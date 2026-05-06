// HTTP POST to the relay's /v1/trusted/session/resolve endpoint to discover
// the live sessionId for a previously trusted Mac without re-scanning a QR.
//
// Mirrors:
//   relay:  relay/relay.js → buildTrustedSessionResolveBytes / resolveTrustedMacSession
//   iOS:    CodexService+SecureTransport.swift → resolveTrustedMacSessionImpl
//
// The request body is signed with the phone's Ed25519 identity private key
// over a length-prefixed transcript that the relay reconstructs and verifies
// against the trusted-phone record it has stored for the Mac.

import * as Crypto from 'expo-crypto';

import { base64ToBytes, ed25519Sign, utf8Bytes } from './crypto';
import { PhoneIdentity } from './identity';

const TRUSTED_SESSION_RESOLVE_TAG = 'remodex-trusted-session-resolve-v1';
const REQUEST_TIMEOUT_MS = 8_000;
const RESOLVE_PATH = '/v1/trusted/session/resolve';

export type TrustedSessionResolveError =
  | { kind: 'mac_offline' }
  | { kind: 'phone_not_trusted' }
  | { kind: 'expired_or_replayed' }
  | { kind: 'unsupported_relay' }
  | { kind: 'network'; message: string }
  | { kind: 'invalid_response'; message: string };

export type TrustedSessionResolved = {
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  displayName?: string;
};

export type TrustedSessionResolveResult =
  | { ok: true; resolved: TrustedSessionResolved }
  | { ok: false; error: TrustedSessionResolveError };

export async function resolveTrustedSession(opts: {
  relay: string;
  macDeviceId: string;
  identity: PhoneIdentity;
}): Promise<TrustedSessionResolveResult> {
  const url = httpResolveUrl(opts.relay);
  if (!url) {
    return { ok: false, error: { kind: 'unsupported_relay' } };
  }

  const nonce = Crypto.randomUUID();
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, error: classifyHttpError(res.status) };
    }

    const json = (await res.json()) as Record<string, unknown>;
    const sessionId = typeof json.sessionId === 'string' ? json.sessionId : '';
    const macDeviceId = typeof json.macDeviceId === 'string' ? json.macDeviceId : opts.macDeviceId;
    const macIdentityPublicKey = typeof json.macIdentityPublicKey === 'string' ? json.macIdentityPublicKey : '';
    const displayName = typeof json.displayName === 'string' ? json.displayName : undefined;

    if (!sessionId || !macIdentityPublicKey) {
      return {
        ok: false,
        error: { kind: 'invalid_response', message: 'Resolve response missing sessionId or macIdentityPublicKey' },
      };
    }

    return {
      ok: true,
      resolved: { sessionId, macDeviceId, macIdentityPublicKey, displayName },
    };
  } catch (e) {
    return { ok: false, error: { kind: 'network', message: (e as Error).message } };
  } finally {
    clearTimeout(timer);
  }
}

// Build the signed transcript verbatim against relay.js → buildTrustedSessionResolveBytes.
function buildResolveTranscript(args: {
  macDeviceId: string;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string; // base64
  nonce: string;
  timestamp: number;
}): Uint8Array {
  return concat([
    lpUtf8(TRUSTED_SESSION_RESOLVE_TAG),
    lpUtf8(args.macDeviceId),
    lpUtf8(args.phoneDeviceId),
    lpBytes(base64ToBytes(args.phoneIdentityPublicKey)),
    lpUtf8(args.nonce),
    lpUtf8(String(args.timestamp)),
  ]);
}

function classifyHttpError(status: number): TrustedSessionResolveError {
  switch (status) {
    case 401:
      return { kind: 'expired_or_replayed' };
    case 403:
      return { kind: 'phone_not_trusted' };
    case 404:
      return { kind: 'mac_offline' };
    case 409:
      return { kind: 'expired_or_replayed' };
    default:
      return { kind: 'invalid_response', message: `HTTP ${status}` };
  }
}

// Convert ws:// → http://, wss:// → https://, append RESOLVE_PATH.
// We try the same root the bridge uses (e.g. wss://api.phodex.app/relay →
// https://api.phodex.app/v1/trusted/session/resolve).
function httpResolveUrl(relay: string): string | null {
  let u: URL;
  try {
    u = new URL(relay);
  } catch {
    return null;
  }
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  else if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.pathname = RESOLVE_PATH;
  u.search = '';
  u.hash = '';
  return u.toString();
}

function lpUtf8(s: string): Uint8Array {
  return lpBytes(utf8Bytes(s));
}
function lpBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + b.length);
  out[0] = (b.length >>> 24) & 0xff;
  out[1] = (b.length >>> 16) & 0xff;
  out[2] = (b.length >>> 8) & 0xff;
  out[3] = b.length & 0xff;
  out.set(b, 4);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
