// Tiny base64 helpers for Uint8Array ↔ string. The wire format uses standard
// base64 (with padding) for all binary fields. JWK-style base64url is only
// internal to Node's `crypto` module on the bridge side and never appears on
// the wire — so we don't need base64url here.

export function bytesToBase64(bytes: Uint8Array): string {
  // RN provides global btoa; it expects a string of latin-1 chars.
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
