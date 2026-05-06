// Parses the v=2 pairing QR payload printed by the Remodex bridge.
// Spec: see ../../../Docs/PROTOCOL.md ("Pairing QR payload (v2)").

export const PAIRING_QR_VERSION = 2 as const;
export const PAIRING_TTL_MS = 5 * 60 * 1000;

export type PairingPayload = {
  v: 2;
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  expiresAt: number;
};

export type PairingParseResult =
  | { ok: true; payload: PairingPayload; isExpired: boolean; msUntilExpiry: number }
  | { ok: false; error: string };

const REQUIRED_FIELDS = [
  'v',
  'relay',
  'sessionId',
  'macDeviceId',
  'macIdentityPublicKey',
  'expiresAt',
] as const;

export function parsePairingQR(raw: string, now: number = Date.now()): PairingParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Empty QR payload' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: 'QR is not valid JSON — is this a Remodex pairing QR?' };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: 'QR root must be a JSON object' };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      return { ok: false, error: `Missing field: ${field}` };
    }
  }

  if (parsed.v !== PAIRING_QR_VERSION) {
    return {
      ok: false,
      error: `Unsupported QR version: ${String(parsed.v)} (need ${PAIRING_QR_VERSION})`,
    };
  }

  for (const field of ['relay', 'sessionId', 'macDeviceId', 'macIdentityPublicKey'] as const) {
    if (typeof parsed[field] !== 'string' || !(parsed[field] as string).trim()) {
      return { ok: false, error: `Field "${field}" must be a non-empty string` };
    }
  }

  if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) {
    return { ok: false, error: 'Field "expiresAt" must be a number (ms epoch)' };
  }

  const relay = (parsed.relay as string).trim();
  if (!/^wss?:\/\//i.test(relay)) {
    return { ok: false, error: `Relay URL must start with ws:// or wss://, got: ${relay}` };
  }

  const macIdentityPublicKey = (parsed.macIdentityPublicKey as string).trim();
  if (!isLikelyBase64(macIdentityPublicKey)) {
    return { ok: false, error: 'macIdentityPublicKey is not valid base64' };
  }

  const payload: PairingPayload = {
    v: PAIRING_QR_VERSION,
    relay,
    sessionId: (parsed.sessionId as string).trim(),
    macDeviceId: (parsed.macDeviceId as string).trim(),
    macIdentityPublicKey,
    expiresAt: parsed.expiresAt,
  };

  const msUntilExpiry = payload.expiresAt - now;

  return {
    ok: true,
    payload,
    isExpired: msUntilExpiry <= 0,
    msUntilExpiry,
  };
}

export function shortId(value: string, len = 8): string {
  return value.length > len ? `${value.slice(0, len)}…` : value;
}

export function fingerprint(base64: string, len = 12): string {
  // Display-only fingerprint; the real cryptographic check happens during the
  // handshake (verifying serverHello.macIdentityPublicKey matches this value).
  return base64.replace(/[^A-Za-z0-9]/g, '').slice(0, len).toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLikelyBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+=*$/.test(value) && value.length % 4 === 0;
}
