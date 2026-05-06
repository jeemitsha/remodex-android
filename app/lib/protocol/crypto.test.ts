import { describe, expect, it } from 'vitest';

import { base64ToBytes, bytesToBase64, utf8Bytes } from './base64';
import {
  buildTranscriptBytes,
  clientAuthTranscript,
  deriveAesKey,
  ed25519Sign,
  ed25519Verify,
  encryptGCM,
  decryptGCM,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  nonceForDirection,
  random32,
  sha256Bytes,
  x25519SharedSecret,
} from './crypto';

describe('base64', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 200, 13, 10, 0]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('utf8Bytes encodes unicode correctly', () => {
    const bytes = utf8Bytes('héllo');
    expect(Array.from(bytes)).toEqual([0x68, 0xc3, 0xa9, 0x6c, 0x6c, 0x6f]);
  });
});

describe('nonceForDirection', () => {
  it('produces 12 bytes', () => {
    expect(nonceForDirection('mac', 0).length).toBe(12);
    expect(nonceForDirection('iphone', 0).length).toBe(12);
  });

  it('mac sender prefix byte is 1, iphone is 2', () => {
    expect(nonceForDirection('mac', 0)[0]).toBe(1);
    expect(nonceForDirection('iphone', 0)[0]).toBe(2);
  });

  it('counter is big-endian u88 in the trailing 11 bytes', () => {
    const nonce = nonceForDirection('mac', 0x010203);
    expect(nonce[11]).toBe(0x03);
    expect(nonce[10]).toBe(0x02);
    expect(nonce[9]).toBe(0x01);
    expect(nonce[8]).toBe(0x00);
  });

  it('different counters produce different nonces', () => {
    const a = nonceForDirection('mac', 0);
    const b = nonceForDirection('mac', 1);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});

describe('Ed25519 sign/verify', () => {
  it('verifies a valid signature', () => {
    const kp = generateEd25519KeyPair();
    const msg = utf8Bytes('hello world');
    const sig = ed25519Sign(kp.privateKeyBase64, msg);
    expect(ed25519Verify(kp.publicKeyBase64, msg, sig)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const kp = generateEd25519KeyPair();
    const msg = utf8Bytes('hello world');
    const sig = ed25519Sign(kp.privateKeyBase64, msg);
    expect(ed25519Verify(kp.publicKeyBase64, utf8Bytes('hello WORLD'), sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const kpA = generateEd25519KeyPair();
    const kpB = generateEd25519KeyPair();
    const msg = utf8Bytes('hello');
    const sig = ed25519Sign(kpA.privateKeyBase64, msg);
    expect(ed25519Verify(kpB.publicKeyBase64, msg, sig)).toBe(false);
  });
});

describe('X25519 ECDH', () => {
  it('produces equal shared secrets on both sides', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const sa = x25519SharedSecret(a.privateKey, b.publicKeyBase64);
    const sb = x25519SharedSecret(b.privateKey, a.publicKeyBase64);
    expect(Array.from(sa)).toEqual(Array.from(sb));
  });
});

describe('AES-GCM envelope round-trip', () => {
  it('encrypts and decrypts with matching counter+sender', () => {
    const sharedSecret = random32();
    const salt = sha256Bytes(utf8Bytes('test-salt'));
    const key = deriveAesKey(sharedSecret, salt, 'remodex-test|phoneToMac');
    const plaintext = utf8Bytes(JSON.stringify({ payloadText: 'hello' }));

    const env = encryptGCM({ key, sender: 'iphone', counter: 7 }, plaintext);
    const dec = decryptGCM({ key, sender: 'iphone', counter: 7 }, env.ciphertextBase64, env.tagBase64);
    expect(dec).not.toBeNull();
    expect(Array.from(dec!)).toEqual(Array.from(plaintext));
  });

  it('returns null for wrong counter (replay/tamper protection)', () => {
    const key = deriveAesKey(random32(), sha256Bytes(utf8Bytes('salt')), 'info');
    const env = encryptGCM({ key, sender: 'iphone', counter: 1 }, utf8Bytes('x'));
    const dec = decryptGCM({ key, sender: 'iphone', counter: 2 }, env.ciphertextBase64, env.tagBase64);
    expect(dec).toBeNull();
  });

  it('returns null for wrong direction', () => {
    const key = deriveAesKey(random32(), sha256Bytes(utf8Bytes('salt')), 'info');
    const env = encryptGCM({ key, sender: 'iphone', counter: 0 }, utf8Bytes('x'));
    const dec = decryptGCM({ key, sender: 'mac', counter: 0 }, env.ciphertextBase64, env.tagBase64);
    expect(dec).toBeNull();
  });
});

describe('buildTranscriptBytes', () => {
  it('produces a length-prefixed concatenation that matches expected byte layout', () => {
    const out = buildTranscriptBytes({
      sessionId: 'a',
      protocolVersion: 1,
      handshakeMode: 'qr_bootstrap',
      keyEpoch: 1,
      macDeviceId: 'b',
      phoneDeviceId: 'c',
      // 32 zero bytes encoded
      macIdentityPublicKeyBase64: bytesToBase64(new Uint8Array(32)),
      phoneIdentityPublicKeyBase64: bytesToBase64(new Uint8Array(32)),
      macEphemeralPublicKeyBase64: bytesToBase64(new Uint8Array(32)),
      phoneEphemeralPublicKeyBase64: bytesToBase64(new Uint8Array(32)),
      clientNonce: new Uint8Array(32),
      serverNonce: new Uint8Array(32),
      expiresAtForTranscript: 0,
    });

    // Tag is "remodex-e2ee-v1" (15 chars) → 4-byte length prefix + 15 bytes
    // Each pubkey/nonce: 4-byte length + 32 bytes raw
    const expectedLen = (4 + 15) + (4 + 1) + (4 + 1) + (4 + 12) + (4 + 1) + (4 + 1) + (4 + 1) + 144 + 72 + (4 + 1);
    expect(out.length).toBe(expectedLen);
  });

  it('clientAuthTranscript appends the length-prefixed "client-auth" tag', () => {
    const transcript = new Uint8Array([1, 2, 3, 4]);
    const auth = clientAuthTranscript(transcript);
    expect(auth.length).toBe(transcript.length + 4 + 'client-auth'.length);
  });
});
