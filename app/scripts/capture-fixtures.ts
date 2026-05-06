// Headless integration harness: pairs with a running `remodex up` via the local
// patched relay, captures real JSON-RPC responses, and writes them to
// `lib/__fixtures__/*.json`. These fixtures back our parser unit tests so we
// stop guessing about response shape.
//
// Usage:
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
// The script never persists identity to disk; each run uses an ephemeral
// keypair so we don't pollute the bridge's trusted-phone registry.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { generateEd25519KeyPair } from '../lib/protocol/crypto.js';
import { PairingPayload, parsePairingQR } from '../lib/protocol/qr.js';
import {
  EncryptedEnvelope,
  HandshakeEvent,
  PairingContext,
  createSecureTransport,
} from '../lib/protocol/secureTransport.js';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_APP_DIR = join(__dirname, '..');
const FIXTURES_DIR = join(REPO_APP_DIR, 'lib', '__fixtures__');

async function main() {
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
  console.log(`  sessionId=${shorten(pairing.sessionId)} expiresAt=${new Date(pairing.expiresAt).toISOString()}`);

  // Ephemeral phone identity for this capture run only.
  const idKp = generateEd25519KeyPair();
  const identity = {
    phoneDeviceId: randomUUID(),
    phoneIdentityPublicKey: idKp.publicKeyBase64,
    phoneIdentityPrivateKey: idKp.privateKeyBase64,
  };
  console.log(`→ Ephemeral phoneDeviceId=${shorten(identity.phoneDeviceId)}`);

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
  const ctx: PairingContext = {
    relay: pairing.relay,
    sessionId: pairing.sessionId,
    macDeviceId: pairing.macDeviceId,
    macIdentityPublicKey: pairing.macIdentityPublicKey,
  };

  const transport = createSecureTransport({
    pairing: ctx,
    identity,
    handshakeMode: 'qr_bootstrap',
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

main().catch((e) => {
  console.error(`✗ capture failed: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exit(1);
});
