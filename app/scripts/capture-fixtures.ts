// Headless integration harness: pairs with a running `remodex up` via the local
// patched relay, captures real JSON-RPC responses, and writes them to
// `lib/__fixtures__/*.json`. These fixtures back our parser unit tests so we
// stop guessing about response shape.
//
// First run: needs ./pairing.json (the QR's JSON payload — see steps 1-4 below).
//   1. In one terminal, start the patched relay:
//        cd relay-local && BIND_HOST=0.0.0.0 PORT=9000 npm start
//   2. In another terminal, start the bridge:
//        REMODEX_RELAY=ws://127.0.0.1:9000/relay remodex up
//   3. Copy the QR's JSON payload from the terminal output (look for
//      "Pairing JSON (debug only; same sensitive bytes as the QR):" — set
//      `REMODEX_PRINT_PAIRING_JSON=1` if you don't see it).
//   4. Save the pairing JSON to ./pairing.json (gitignored), then:
//        npm run capture
//
// Subsequent runs: identity is cached at lib/__fixtures__/.identity.cache.json
// (gitignored). The script reuses that identity + asks the relay for a fresh
// sessionId via /v1/trusted/session/resolve, so no new QR is needed. Run
// REMODEX_CAPTURE_RESET=1 npm run capture to wipe the cache and re-pair.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import {
  base64ToBytes,
  ed25519Sign,
  generateEd25519KeyPair,
  utf8Bytes,
} from '../lib/protocol/crypto.js';
import { PairingPayload, parsePairingQR } from '../lib/protocol/qr.js';
import {
  EncryptedEnvelope,
  HandshakeEvent,
  HandshakeMode,
  PairingContext,
  createSecureTransport,
} from '../lib/protocol/secureTransport.js';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_APP_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(REPO_APP_DIR, 'lib', '__fixtures__');
const IDENTITY_CACHE_PATH = join(FIXTURES_DIR, '.identity.cache.json');

type IdentityCache = {
  identity: {
    phoneDeviceId: string;
    phoneIdentityPublicKey: string;
    phoneIdentityPrivateKey: string;
  };
  macDeviceId: string;
  macIdentityPublicKey: string;
  relay: string;
};

type Bootstrap = {
  pairing: PairingContext;
  identity: IdentityCache['identity'];
  handshakeMode: HandshakeMode;
};

async function main() {
  if (process.env.REMODEX_CAPTURE_RESET === '1') {
    await unlink(IDENTITY_CACHE_PATH).catch(() => {});
    console.log('→ Identity cache cleared (REMODEX_CAPTURE_RESET=1).');
  }

  const cache = await readIdentityCache();
  const bootstrap = cache
    ? await bootstrapFromCache(cache)
    : await bootstrapFromQR();

  const pairing = bootstrap.pairing;
  const identity = bootstrap.identity;
  console.log(`→ Mode: ${bootstrap.handshakeMode}`);
  console.log(`  sessionId=${shorten(pairing.sessionId)} mac=${shorten(pairing.macDeviceId)}`);

  const url = `${pairing.relay.replace(/\/+$/, '')}/${pairing.sessionId}?role=android`;
  const ws = new WebSocket(url, {
    headers: { 'x-role': 'android' },
  });
  await waitForOpen(ws);
  console.log(`✓ WebSocket open ${url}`);

  // Hook the secure transport up to the WS.
  let pairedResolve!: () => void;
  const pairedPromise = new Promise<void>((resolve) => (pairedResolve = resolve));

  let lastErrorMsg = '';

  const transport = createSecureTransport({
    pairing,
    identity,
    handshakeMode: bootstrap.handshakeMode,
    sendWire: (text) => ws.readyState === WebSocket.OPEN && ws.send(text),
    emit: (event: HandshakeEvent) => {
      if (event.type === 'stage') {
        console.log(`  stage → ${event.stage}`);
      } else if (event.type === 'paired') {
        console.log(`✓ Paired (epoch ${event.session.keyEpoch}, mac ${shorten(event.session.macDeviceId)})`);
        pairedResolve();
      } else if (event.type === 'error') {
        lastErrorMsg = `${event.code ?? 'error'}: ${event.message}`;
        console.error(`✗ Handshake error: ${lastErrorMsg}`);
      }
    },
  });

  // Track outbound JSON-RPC ids so we can correlate responses.
  const pendingResponses = new Map<number, (r: { result?: unknown; error?: any }) => void>();
  let nextRpcId = 1;

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed.kind === 'encryptedEnvelope') {
      const inner = transport.decryptApplication(parsed as EncryptedEnvelope);
      if (!inner) return;
      let rpc: any;
      try {
        rpc = JSON.parse(inner);
      } catch {
        return;
      }
      // Ignore notifications from the bridge for capture purposes.
      if (rpc.id !== undefined && !rpc.method) {
        const handler = pendingResponses.get(rpc.id);
        if (handler) {
          pendingResponses.delete(rpc.id);
          handler({ result: rpc.result, error: rpc.error });
        }
      }
      return;
    }
    transport.handleWireText(text);
  });

  ws.on('close', (code, reason) => {
    if (!transport.isPaired()) {
      console.error(`✗ WebSocket closed before pair: ${code} ${reason.toString()}`);
      process.exit(1);
    }
  });
  ws.on('error', (e) => {
    console.error(`✗ WS error: ${e.message}`);
  });

  transport.start();
  await Promise.race([
    pairedPromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('handshake timeout')), 15_000)),
  ]);

  // First-time qr_bootstrap pair → persist identity + mac details for later
  // runs to use trusted_session_resolve and skip the QR.
  if (bootstrap.handshakeMode === 'qr_bootstrap') {
    await mkdir(FIXTURES_DIR, { recursive: true });
    const cacheRecord: IdentityCache = {
      identity,
      macDeviceId: pairing.macDeviceId,
      macIdentityPublicKey: pairing.macIdentityPublicKey,
      relay: pairing.relay,
    };
    await writeFile(IDENTITY_CACHE_PATH, JSON.stringify(cacheRecord, null, 2) + '\n', 'utf8');
    console.log(`→ Identity cached at ${IDENTITY_CACHE_PATH}`);
  }

  async function rpc(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<{ result?: unknown; error?: any }> {
    const id = nextRpcId++;
    const promise = new Promise<{ result?: unknown; error?: any }>((resolve) => {
      pendingResponses.set(id, resolve);
    });
    const env = transport.encryptApplication(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    ws.send(env);
    return await Promise.race([
      promise,
      new Promise<{ result?: unknown; error?: any }>((_, rej) =>
        setTimeout(() => {
          pendingResponses.delete(id);
          rej(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      ),
    ]);
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  // 1. initialize
  console.log('→ initialize');
  const init = await rpc('initialize', {
    clientInfo: { name: 'remodex_capture', title: 'Capture Harness', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  await dump('initialize.response.json', init);

  // 2. thread/list
  console.log('→ thread/list');
  const list = await rpc('thread/list', { limit: 10 });
  await dump('thread-list.response.json', list);

  // Pull a thread id off whatever shape the bridge returned.
  const threadList = (list.result as any) || {};
  const threadsArr: any[] =
    (Array.isArray(threadList.data) && threadList.data) ||
    (Array.isArray(threadList.items) && threadList.items) ||
    (Array.isArray(threadList.threads) && threadList.threads) ||
    [];
  const sampleThread = threadsArr.find((t) => typeof t === 'object' && (t.id || t.threadId));
  const threadId: string | undefined = sampleThread?.id ?? sampleThread?.threadId;

  // Optional: capture a specific session via REMODEX_CAPTURE_THREAD_IDS=<id1>,<id2>
  // The first match becomes the canonical thread-turns-list.response.json so
  // existing tests keep working; additional ones are written as
  // thread-turns-list.<shortid>.response.json.
  const explicit = (process.env.REMODEX_CAPTURE_THREAD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const targetIds = explicit.length > 0 ? explicit : threadId ? [threadId] : [];

  for (let i = 0; i < targetIds.length; i++) {
    const tid = targetIds[i];
    console.log(`→ thread/turns/list threadId=${shorten(tid)} (limit=200)`);
    const turns = await rpc('thread/turns/list', {
      threadId: tid,
      limit: 200, // big enough for most real sessions
      sortDirection: 'desc',
    });
    const filename = i === 0
      ? 'thread-turns-list.response.json'
      : `thread-turns-list.${tid.slice(0, 8)}.response.json`;
    await dump(filename, turns);
  }
  if (targetIds.length === 0) {
    console.log('  (no threads to dump turns for; skipping thread/turns/list capture)');
  }

  console.log(`\n✓ Fixtures written to ${FIXTURES_DIR}/`);
  ws.close();
  process.exit(0);

  async function dump(name: string, data: unknown) {
    const path = join(FIXTURES_DIR, name);
    await writeFile(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log(`  wrote ${name}`);
  }
}

function shorten(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });
}

async function readIdentityCache(): Promise<IdentityCache | null> {
  try {
    const raw = await readFile(IDENTITY_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed
      && parsed.identity?.phoneDeviceId
      && parsed.identity?.phoneIdentityPublicKey
      && parsed.identity?.phoneIdentityPrivateKey
      && parsed.macDeviceId
      && parsed.macIdentityPublicKey
      && parsed.relay
    ) {
      return parsed as IdentityCache;
    }
    console.warn('⚠ Identity cache malformed; ignoring.');
    return null;
  } catch {
    return null;
  }
}

async function bootstrapFromQR(): Promise<Bootstrap> {
  const pairingPath = process.env.REMODEX_PAIRING_PATH || join(REPO_APP_DIR, 'pairing.json');
  const raw = await readFile(pairingPath, 'utf8').catch((e) => {
    console.error(`✗ Could not read ${pairingPath}: ${e.message}`);
    console.error('  Save the QR JSON from `remodex up` output to that path first.');
    process.exit(2);
  });

  const parsed = parsePairingQR(raw);
  if (!parsed.ok) {
    console.error(`✗ Pairing JSON failed to parse: ${parsed.error}`);
    process.exit(2);
  }
  if (parsed.isExpired) {
    console.error('✗ Pairing JSON expired. Re-run `remodex up` and copy the new QR.');
    process.exit(2);
  }
  const pairing: PairingPayload = parsed.payload;
  console.log(`→ Pairing payload v${pairing.v} relay=${pairing.relay}`);
  console.log(`  expiresAt=${new Date(pairing.expiresAt).toISOString()}`);

  const idKp = generateEd25519KeyPair();
  const identity = {
    phoneDeviceId: randomUUID(),
    phoneIdentityPublicKey: idKp.publicKeyBase64,
    phoneIdentityPrivateKey: idKp.privateKeyBase64,
  };
  console.log(`→ Fresh phoneDeviceId=${shorten(identity.phoneDeviceId)}`);

  return {
    pairing: {
      relay: pairing.relay,
      sessionId: pairing.sessionId,
      macDeviceId: pairing.macDeviceId,
      macIdentityPublicKey: pairing.macIdentityPublicKey,
    },
    identity,
    handshakeMode: 'qr_bootstrap',
  };
}

async function bootstrapFromCache(cache: IdentityCache): Promise<Bootstrap> {
  console.log(`→ Reusing cached identity (phoneDeviceId=${shorten(cache.identity.phoneDeviceId)}).`);
  console.log(`  Resolving fresh sessionId via ${cache.relay}/v1/trusted/session/resolve…`);

  const resolved = await resolveTrustedSessionInline({
    relay: cache.relay,
    macDeviceId: cache.macDeviceId,
    identity: cache.identity,
  });
  if (!resolved.ok) {
    console.error(`✗ Trusted-session resolve failed: ${resolved.errorMessage}`);
    console.error('  Run REMODEX_CAPTURE_RESET=1 npm run capture to wipe the cache and re-pair.');
    process.exit(3);
  }
  return {
    pairing: {
      relay: cache.relay,
      sessionId: resolved.sessionId,
      macDeviceId: resolved.macDeviceId,
      macIdentityPublicKey: resolved.macIdentityPublicKey,
    },
    identity: cache.identity,
    handshakeMode: 'trusted_reconnect',
  };
}

const TRUSTED_SESSION_RESOLVE_TAG = 'remodex-trusted-session-resolve-v1';

async function resolveTrustedSessionInline(opts: {
  relay: string;
  macDeviceId: string;
  identity: IdentityCache['identity'];
}): Promise<
  | { ok: true; sessionId: string; macDeviceId: string; macIdentityPublicKey: string }
  | { ok: false; errorMessage: string }
> {
  // Mirrors lib/protocol/trustedSessionResolve.ts but inlined here so the
  // capture script doesn't drag in expo-crypto.
  const url = httpResolveUrl(opts.relay);
  if (!url) return { ok: false, errorMessage: `Unsupported relay scheme: ${opts.relay}` };

  const nonce = randomUUID();
  const timestamp = Date.now();
  const transcript = buildResolveTranscript({
    macDeviceId: opts.macDeviceId,
    phoneDeviceId: opts.identity.phoneDeviceId,
    phoneIdentityPublicKey: opts.identity.phoneIdentityPublicKey,
    nonce,
    timestamp,
  });
  const signature = ed25519Sign(opts.identity.phoneIdentityPrivateKey, transcript);

  const body = {
    macDeviceId: opts.macDeviceId,
    phoneDeviceId: opts.identity.phoneDeviceId,
    phoneIdentityPublicKey: opts.identity.phoneIdentityPublicKey,
    nonce,
    timestamp,
    signature,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, errorMessage: `HTTP ${res.status} ${res.statusText}` };
    }
    const json = (await res.json()) as Record<string, unknown>;
    const sessionId = typeof json.sessionId === 'string' ? json.sessionId : '';
    const macDeviceId = typeof json.macDeviceId === 'string' ? json.macDeviceId : opts.macDeviceId;
    const macIdentityPublicKey = typeof json.macIdentityPublicKey === 'string' ? json.macIdentityPublicKey : '';
    if (!sessionId || !macIdentityPublicKey) {
      return { ok: false, errorMessage: 'Resolve response missing sessionId or macIdentityPublicKey.' };
    }
    return { ok: true, sessionId, macDeviceId, macIdentityPublicKey };
  } catch (e) {
    return { ok: false, errorMessage: (e as Error).message };
  }
}

function httpResolveUrl(relay: string): string | null {
  // ws://host[:port][/path]  →  http://host[:port]/v1/trusted/session/resolve
  // wss://host... → https://...
  const m = relay.match(/^(wss?):\/\/([^\/?#]+)/);
  if (!m) return null;
  const httpScheme = m[1] === 'wss' ? 'https' : 'http';
  return `${httpScheme}://${m[2]}/v1/trusted/session/resolve`;
}

function buildResolveTranscript(args: {
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  nonce: string;
  timestamp: number;
}): Uint8Array {
  return concatBytes([
    lpUtf8(TRUSTED_SESSION_RESOLVE_TAG),
    lpUtf8(args.macDeviceId),
    lpUtf8(args.phoneDeviceId),
    lpBytes(base64ToBytes(args.phoneIdentityPublicKey)),
    lpUtf8(args.nonce),
    lpUtf8(String(args.timestamp)),
  ]);
}

function lpUtf8(s: string): Uint8Array {
  return lpBytes(utf8Bytes(s));
}

function lpBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, bytes.length, false); // big-endian length prefix
  out.set(bytes, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

main().catch((e) => {
  console.error(`✗ capture failed: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exit(1);
});
