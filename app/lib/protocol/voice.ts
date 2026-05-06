// Voice transcription. Mirrors iOS CodexService+Voice.swift +
// GPTVoiceTranscriptionManager.swift two-step flow:
//
//   1. JSON-RPC `voice/resolveAuth` over the encrypted bridge channel →
//      { token: string }
//   2. POST the recorded audio directly to
//      https://chatgpt.com/backend-api/transcribe with `Authorization:
//      Bearer <token>` and a multipart body whose `file` field is the
//      audio blob → { text: string } or { transcript: string }
//
// On 401/403 the bridge token is stale; the caller should re-auth and retry
// once. This module only handles the pure call layer; the recorder UI lives
// in pair.tsx.

const TRANSCRIBE_URL = 'https://chatgpt.com/backend-api/transcribe';

export const VOICE_LIMITS = {
  maxDurationSeconds: 120,
  maxByteCount: 10 * 1024 * 1024,
} as const;

export class VoiceAuthExpired extends Error {
  constructor() {
    super('voice auth token expired');
    this.name = 'VoiceAuthExpired';
  }
}

// Validates a recording before we burn bandwidth uploading it. Mirrors
// CodexVoiceTranscriptionPreflight.failureMessage.
export function preflightVoiceClip(input: {
  byteCount: number;
  durationSeconds: number;
}): string | null {
  if (input.durationSeconds > VOICE_LIMITS.maxDurationSeconds) {
    return 'Voice clips must be 120 seconds or less.';
  }
  if (input.byteCount > VOICE_LIMITS.maxByteCount) {
    return 'Voice clips must be smaller than 10 MB.';
  }
  return null;
}

// Pulls the transcript field out of a ChatGPT transcribe response. The server
// has shipped both `text` and `transcript` historically (see iOS
// decodeTranscriptText) — we accept either.
export function decodeTranscriptResponse(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const key of ['text', 'transcript'] as const) {
      const v = o[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        return v.trim();
      }
    }
  }
  throw new Error('Transcript response was empty.');
}

// Decodes the friendlier server error from a 4xx/5xx response body, falling
// back to a generic status message. Mirrors iOS extractErrorMessage.
export function decodeTranscriptError(payload: unknown, statusCode: number): string {
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    const errObj = o.error;
    if (errObj && typeof errObj === 'object') {
      const m = (errObj as Record<string, unknown>).message;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
    const m = o.message;
    if (typeof m === 'string' && m.trim()) return m.trim();
  }
  return `Transcription failed (${statusCode}).`;
}

// Posts the recorded audio to ChatGPT's transcription endpoint. The audio
// argument is a blob-like reference — RN's FormData accepts
// `{ uri, name, type }` shaped objects, while the test passes a real File/Blob.
//
// Throws VoiceAuthExpired on 401/403 so the caller can re-resolve the token.
export async function postTranscribe(input: {
  token: string;
  audio: { uri: string; name: string; type: string } | Blob;
  fetcher?: typeof fetch;
}): Promise<string> {
  const fetchFn = input.fetcher ?? fetch;
  const body = new FormData();
  // RN-style FormData accepts the {uri,name,type} object — TypeScript's lib
  // typing only allows Blob/string, so cast.
  body.append('file', input.audio as unknown as Blob);

  const res = await fetchFn(TRANSCRIBE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token}`,
      // NOTE: do NOT set Content-Type manually for multipart in RN; FormData
      // sets the boundary itself. Letting fetch supply it avoids a "no
      // boundary" 400.
    },
    body,
  });

  if (res.status === 401 || res.status === 403) {
    throw new VoiceAuthExpired();
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Fall through to the friendlier error decoder below.
  }

  if (!res.ok) {
    throw new Error(decodeTranscriptError(parsed, res.status));
  }

  return decodeTranscriptResponse(parsed);
}
