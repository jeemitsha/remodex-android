import { describe, expect, it } from 'vitest';

import {
  VoiceAuthExpired,
  decodeTranscriptError,
  decodeTranscriptResponse,
  postTranscribe,
  preflightVoiceClip,
} from './voice';

describe('preflightVoiceClip', () => {
  it('rejects clips longer than 120s', () => {
    expect(preflightVoiceClip({ byteCount: 100, durationSeconds: 121 })).toMatch(/120 seconds/);
  });

  it('rejects clips larger than 10 MB', () => {
    expect(preflightVoiceClip({ byteCount: 11 * 1024 * 1024, durationSeconds: 5 })).toMatch(/10 MB/);
  });

  it('returns null for clips within both limits', () => {
    expect(preflightVoiceClip({ byteCount: 1024, durationSeconds: 5 })).toBeNull();
  });
});

describe('decodeTranscriptResponse', () => {
  it('reads the text field', () => {
    expect(decodeTranscriptResponse({ text: 'hello world' })).toBe('hello world');
  });

  it('falls back to transcript if text is missing', () => {
    expect(decodeTranscriptResponse({ transcript: 'fallback' })).toBe('fallback');
  });

  it('throws when both fields are empty / missing', () => {
    expect(() => decodeTranscriptResponse({})).toThrow();
    expect(() => decodeTranscriptResponse({ text: '   ' })).toThrow();
    expect(() => decodeTranscriptResponse(null)).toThrow();
  });
});

describe('decodeTranscriptError', () => {
  it('extracts error.message when present', () => {
    expect(
      decodeTranscriptError({ error: { message: 'Quota exceeded' } }, 429),
    ).toBe('Quota exceeded');
  });

  it('falls back to top-level message', () => {
    expect(decodeTranscriptError({ message: 'oops' }, 500)).toBe('oops');
  });

  it('uses a generic status fallback when payload is unhelpful', () => {
    expect(decodeTranscriptError({}, 502)).toBe('Transcription failed (502).');
    expect(decodeTranscriptError(null, 502)).toBe('Transcription failed (502).');
  });
});

describe('postTranscribe', () => {
  function fakeFetch(impl: (req: Request | string, init?: RequestInit) => Response) {
    return ((url: any, init: any) => Promise.resolve(impl(url, init))) as typeof fetch;
  }

  it('throws VoiceAuthExpired on 401', async () => {
    const fetcher = fakeFetch(() => new Response('{}', { status: 401 }));
    await expect(
      postTranscribe({
        token: 'tok',
        audio: { uri: 'file:///x.wav', name: 'voice.wav', type: 'audio/wav' },
        fetcher,
      }),
    ).rejects.toBeInstanceOf(VoiceAuthExpired);
  });

  it('throws VoiceAuthExpired on 403 too', async () => {
    const fetcher = fakeFetch(() => new Response('{}', { status: 403 }));
    await expect(
      postTranscribe({
        token: 'tok',
        audio: { uri: 'file:///x.wav', name: 'voice.wav', type: 'audio/wav' },
        fetcher,
      }),
    ).rejects.toBeInstanceOf(VoiceAuthExpired);
  });

  it('throws server error message on 4xx with payload', async () => {
    const fetcher = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: 'Audio too short' } }), { status: 400 }),
    );
    await expect(
      postTranscribe({
        token: 'tok',
        audio: { uri: 'file:///x.wav', name: 'voice.wav', type: 'audio/wav' },
        fetcher,
      }),
    ).rejects.toThrow(/Audio too short/);
  });

  it('returns text on a successful 200', async () => {
    const fetcher = fakeFetch(
      () => new Response(JSON.stringify({ text: 'hello there' }), { status: 200 }),
    );
    const text = await postTranscribe({
      token: 'tok',
      audio: { uri: 'file:///x.wav', name: 'voice.wav', type: 'audio/wav' },
      fetcher,
    });
    expect(text).toBe('hello there');
  });

  it('uses Bearer token in the Authorization header', async () => {
    let capturedAuth = '';
    const fetcher = fakeFetch((_url, init) => {
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    });
    await postTranscribe({
      token: 'sk-abc123',
      audio: { uri: 'file:///x.wav', name: 'voice.wav', type: 'audio/wav' },
      fetcher,
    });
    expect(capturedAuth).toBe('Bearer sk-abc123');
  });
});
