// Crypto primitives mirroring the Remodex bridge's secure-transport.js.
// Uses @noble/* (pure JS) so the app keeps loading in Expo Go.
//
// Maps to upstream:
//   Node `crypto` X25519           ↔ @noble/curves/ed25519 → x25519
//   Node `crypto` Ed25519          ↔ @noble/curves/ed25519 → ed25519
//   Node `crypto` HKDF-SHA256      ↔ @noble/hashes/hkdf
//   Node `crypto` AES-256-GCM      ↔ @noble/ciphers/aes → gcm
//   Node `crypto` SHA-256          ↔ @noble/hashes/sha256
//
// Wire-format invariants (see Docs/PROTOCOL.md):
//   - Transcript bytes use uint32-BE length prefixes (NOT varints).
//   - AES-GCM nonce is 12 bytes: byte0 = sender (1=mac, 2=iphone), bytes 1..11 = counter as big-endian u88.
//   - HKDF salt = SHA-256(transcript). Info string includes HANDSHAKE_TAG | sessionId | macDeviceId | phoneDeviceId | keyEpoch | direction.

import { gcm } from '@noble/ciphers/aes.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64ToBytes, bytesToBase64, utf8Bytes } from './base64';

// Re-export base64 helpers so callers can grab everything from one module.
export { base64ToBytes, bytesToBase64, utf8Bytes } from './base64';

export const HANDSHAKE_TAG = 'remodex-e2ee-v1';
export const SECURE_PROTOCOL_VERSION = 1;
export const SENDER_MAC = 'mac';
export const SENDER_IPHONE = 'iphone';
export type Sender = typeof SENDER_MAC | typeof SENDER_IPHONE;

// ---------- Ed25519 (identity) ----------

export type Ed25519KeyPair = {
  privateKeyBase64: string;
  publicKeyBase64: string;
};

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const priv = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(priv);
  return { privateKeyBase64: bytesToBase64(priv), publicKeyBase64: bytesToBase64(pub) };
}

export function ed25519Sign(privateKeyBase64: string, message: Uint8Array): string {
  const priv = base64ToBytes(privateKeyBase64);
  const sig = ed25519.sign(message, priv);
  return bytesToBase64(sig);
}

export function ed25519Verify(publicKeyBase64: string, message: Uint8Array, signatureBase64: string): boolean {
  try {
    const pub = base64ToBytes(publicKeyBase64);
    const sig = base64ToBytes(signatureBase64);
    return ed25519.verify(sig, message, pub);
  } catch {
    return false;
  }
}

// ---------- X25519 (ephemeral, ECDH) ----------

export type X25519KeyPair = {
  privateKey: Uint8Array;
  publicKeyBase64: string;
};

export function generateX25519KeyPair(): X25519KeyPair {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { privateKey: priv, publicKeyBase64: bytesToBase64(pub) };
}

export function x25519SharedSecret(privateKey: Uint8Array, peerPublicKeyBase64: string): Uint8Array {
  const peerPub = base64ToBytes(peerPublicKeyBase64);
  return x25519.getSharedSecret(privateKey, peerPub);
}

// ---------- Hash + KDF ----------

export function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

export function deriveAesKey(sharedSecret: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, sharedSecret, salt, utf8Bytes(info), 32);
}

// ---------- AES-256-GCM ----------

export type EnvelopeCipherInputs = {
  key: Uint8Array;
  sender: Sender;
  counter: number;
};

export function encryptGCM(
  inputs: EnvelopeCipherInputs,
  plaintext: Uint8Array,
): { ciphertextBase64: string; tagBase64: string } {
  const nonce = nonceForDirection(inputs.sender, inputs.counter);
  const cipher = gcm(inputs.key, nonce);
  const sealed = cipher.encrypt(plaintext);
  // noble's gcm output = ciphertext || 16-byte tag
  const tag = sealed.slice(sealed.length - 16);
  const ct = sealed.slice(0, sealed.length - 16);
  return { ciphertextBase64: bytesToBase64(ct), tagBase64: bytesToBase64(tag) };
}

export function decryptGCM(
  inputs: EnvelopeCipherInputs,
  ciphertextBase64: string,
  tagBase64: string,
): Uint8Array | null {
  try {
    const nonce = nonceForDirection(inputs.sender, inputs.counter);
    const cipher = gcm(inputs.key, nonce);
    const ct = base64ToBytes(ciphertextBase64);
    const tag = base64ToBytes(tagBase64);
    const sealed = new Uint8Array(ct.length + tag.length);
    sealed.set(ct, 0);
    sealed.set(tag, ct.length);
    return cipher.decrypt(sealed);
  } catch {
    return null;
  }
}

// 12 bytes: nonce[0]=1(mac)|2(iphone), nonce[1..11]=counter as big-endian u88.
export function nonceForDirection(sender: Sender, counter: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = sender === SENDER_MAC ? 1 : 2;
  // 88-bit big-endian counter — JS number is safe for ~53 bits, plenty for our session lifetime.
  let value = BigInt(counter);
  for (let i = 11; i >= 1; i--) {
    nonce[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return nonce;
}

// ---------- Transcript bytes (length-prefixed concat per upstream) ----------

export type TranscriptInputs = {
  sessionId: string;
  protocolVersion: number;
  handshakeMode: string;
  keyEpoch: number;
  macDeviceId: string;
  phoneDeviceId: string;
  macIdentityPublicKeyBase64: string;
  phoneIdentityPublicKeyBase64: string;
  macEphemeralPublicKeyBase64: string;
  phoneEphemeralPublicKeyBase64: string;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  expiresAtForTranscript: number;
};

export function buildTranscriptBytes(inputs: TranscriptInputs): Uint8Array {
  const parts: Uint8Array[] = [
    lpUtf8(HANDSHAKE_TAG),
    lpUtf8(inputs.sessionId),
    lpUtf8(String(inputs.protocolVersion)),
    lpUtf8(inputs.handshakeMode),
    lpUtf8(String(inputs.keyEpoch)),
    lpUtf8(inputs.macDeviceId),
    lpUtf8(inputs.phoneDeviceId),
    lpBytes(base64ToBytes(inputs.macIdentityPublicKeyBase64)),
    lpBytes(base64ToBytes(inputs.phoneIdentityPublicKeyBase64)),
    lpBytes(base64ToBytes(inputs.macEphemeralPublicKeyBase64)),
    lpBytes(base64ToBytes(inputs.phoneEphemeralPublicKeyBase64)),
    lpBytes(inputs.clientNonce),
    lpBytes(inputs.serverNonce),
    lpUtf8(String(inputs.expiresAtForTranscript)),
  ];
  return concatBytes(parts);
}

export function clientAuthTranscript(transcriptBytes: Uint8Array): Uint8Array {
  return concatBytes([transcriptBytes, lpUtf8('client-auth')]);
}

function lpUtf8(s: string): Uint8Array {
  return lpBytes(utf8Bytes(s));
}

function lpBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + b.length);
  // big-endian uint32 length prefix
  out[0] = (b.length >>> 24) & 0xff;
  out[1] = (b.length >>> 16) & 0xff;
  out[2] = (b.length >>> 8) & 0xff;
  out[3] = b.length & 0xff;
  out.set(b, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

// ---------- Random nonce helper ----------

export function random32(): Uint8Array {
  // ed25519.utils.randomPrivateKey returns 32 cryptographically random bytes —
  // borrowing it here avoids pulling in another RNG import path.
  return ed25519.utils.randomSecretKey();
}
