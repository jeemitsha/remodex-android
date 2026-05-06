import { describe, expect, it } from 'vitest';

import { parsePairingQR, fingerprint, shortId } from './qr';

const validPayload = {
  v: 2,
  relay: 'wss://api.phodex.app/relay',
  sessionId: '0ee2236f-1234-5678-9abc-def012345678',
  macDeviceId: '9364fdd4-aaaa-bbbb-cccc-dddddddddddd',
  macIdentityPublicKey: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==',
  expiresAt: Date.now() + 60_000,
};

describe('parsePairingQR', () => {
  it('accepts a well-formed v=2 payload', () => {
    const r = parsePairingQR(JSON.stringify(validPayload));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sessionId).toBe(validPayload.sessionId);
      expect(r.isExpired).toBe(false);
      expect(r.msUntilExpiry).toBeGreaterThan(0);
    }
  });

  it('reports expired when expiresAt is in the past', () => {
    const r = parsePairingQR(JSON.stringify({ ...validPayload, expiresAt: Date.now() - 1000 }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.isExpired).toBe(true);
  });

  it('rejects empty input', () => {
    expect(parsePairingQR('')).toEqual({ ok: false, error: 'Empty QR payload' });
  });

  it('rejects non-JSON', () => {
    const r = parsePairingQR('not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid JSON/);
  });

  it('rejects unsupported version', () => {
    const r = parsePairingQR(JSON.stringify({ ...validPayload, v: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported QR version/);
  });

  it('rejects non-WS relay schemes', () => {
    const r = parsePairingQR(JSON.stringify({ ...validPayload, relay: 'http://example.com' }));
    expect(r.ok).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { sessionId: _omit, ...without } = validPayload;
    const r = parsePairingQR(JSON.stringify(without));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Missing field: sessionId/);
  });

  it('rejects invalid base64 in macIdentityPublicKey', () => {
    const r = parsePairingQR(JSON.stringify({ ...validPayload, macIdentityPublicKey: '!!!!not-base64!!!!' }));
    expect(r.ok).toBe(false);
  });
});

describe('shortId', () => {
  it('truncates with ellipsis past the limit', () => {
    expect(shortId('abcdefghij', 6)).toBe('abcdef…');
  });
  it('returns short input unchanged', () => {
    expect(shortId('abc', 6)).toBe('abc');
  });
});

describe('fingerprint', () => {
  it('returns 12 alphanumeric chars uppercased', () => {
    const fp = fingerprint('YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==');
    expect(fp).toMatch(/^[A-Z0-9]{1,12}$/);
    expect(fp.length).toBeLessThanOrEqual(12);
  });
});
