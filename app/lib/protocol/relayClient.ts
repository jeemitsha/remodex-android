// Thin WebSocket client that pipes wire messages between the relay and a
// SecureTransport instance, plus a tiny JSON-RPC layer over the encrypted
// application channel — including request/response correlation by id.

import {
  EncryptedEnvelope,
  HandshakeEvent,
  HandshakeMode,
  HandshakeStage,
  PairingContext,
  SecureSession,
  SecureTransport,
  createSecureTransport,
} from './secureTransport';
import { PhoneIdentity } from './identity';

export type RelayClientEvent =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'stage'; stage: HandshakeStage }
  | { type: 'paired'; session: SecureSession }
  | { type: 'application'; payloadText: string }
  | { type: 'notification'; method: string; params: unknown }
  | { type: 'serverRequest'; id: number | string; method: string; params: unknown }
  | { type: 'error'; message: string; code?: string }
  | { type: 'closed'; code: number; reason?: string };

export type JsonRpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string; data?: unknown } };

export type RelayClient = {
  close: () => void;
  sendRequest: (method: string, params?: unknown, timeoutMs?: number) => Promise<JsonRpcResponse>;
  sendNotification: (method: string, params?: unknown) => void;
  // Reply to a server-initiated request (e.g. an approval prompt).
  sendResponse: (id: number | string, result: unknown) => void;
  sendErrorResponse: (id: number | string, code: number, message: string) => void;
};

export function createRelayClient(opts: {
  pairing: PairingContext;
  identity: PhoneIdentity;
  handshakeMode?: HandshakeMode;
  emit: (event: RelayClientEvent) => void;
}): RelayClient {
  // Append `?role=android` because Expo Go's WebSocket strips custom request
  // headers (the `x-role` header path doesn't survive). Our patched relay
  // reads role from query string as a fallback. We still pass the header in
  // case a future Expo Go release honors it.
  const baseUrl = relayUrlForSession(opts.pairing.relay, opts.pairing.sessionId);
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'role=android';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WS = WebSocket as unknown as new (url: string, protocols?: string | string[] | null, options?: any) => WebSocket;
  const ws = new WS(url, null, { headers: { 'x-role': 'android' } });

  let secure: SecureTransport | null = null;
  let nextRequestId = 1;
  const pendingRequests = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; timer: ReturnType<typeof setTimeout> | null }
  >();

  function emit(e: RelayClientEvent) {
    opts.emit(e);
  }

  emit({ type: 'connecting' });

  ws.onopen = () => {
    emit({ type: 'connected' });

    secure = createSecureTransport({
      pairing: opts.pairing,
      identity: opts.identity,
      handshakeMode: opts.handshakeMode,
      sendWire: (text) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(text);
      },
      emit: (event: HandshakeEvent) => {
        switch (event.type) {
          case 'stage':
            emit({ type: 'stage', stage: event.stage });
            return;
          case 'paired':
            emit({ type: 'paired', session: event.session });
            return;
          case 'error':
            emit({ type: 'error', message: event.message, code: event.code });
            return;
        }
      },
    });
    secure.start();
  };

  ws.onmessage = (e) => {
    const text = typeof e.data === 'string' ? e.data : '';
    if (!text) return;

    let parsed: { kind?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (parsed.kind === 'encryptedEnvelope' && secure) {
      const inner = secure.decryptApplication(parsed as EncryptedEnvelope);
      if (inner) handleApplicationMessage(inner);
      return;
    }

    if (secure) secure.handleWireText(text);
  };

  ws.onerror = () => {
    emit({ type: 'error', message: 'WebSocket error' });
  };

  ws.onclose = (e) => {
    for (const { resolve, timer } of pendingRequests.values()) {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: { code: -32000, message: `Connection closed (${e.code})` } });
    }
    pendingRequests.clear();
    emit({ type: 'closed', code: e.code, reason: e.reason });
  };

  function handleApplicationMessage(payloadText: string): void {
    emit({ type: 'application', payloadText });

    let rpc: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: any };
    try {
      rpc = JSON.parse(payloadText);
    } catch {
      return;
    }

    // Server-initiated request: has both `method` AND `id` — needs a response.
    if (rpc.method && rpc.id !== undefined && rpc.id !== null) {
      emit({ type: 'serverRequest', id: rpc.id, method: rpc.method, params: rpc.params });
      return;
    }

    // Response: has `id` and either `result` or `error`, no `method`.
    if (rpc.id !== undefined && rpc.id !== null && !rpc.method) {
      const pending = pendingRequests.get(rpc.id as number);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        pendingRequests.delete(rpc.id as number);
        if (rpc.error) {
          pending.resolve({ ok: false, error: rpc.error });
        } else {
          pending.resolve({ ok: true, result: rpc.result });
        }
      }
      return;
    }

    // Notification: has `method`, no `id`.
    if (rpc.method) {
      emit({ type: 'notification', method: rpc.method, params: rpc.params });
    }
  }

  function sendRequest(method: string, params?: unknown, timeoutMs = 30_000): Promise<JsonRpcResponse> {
    return new Promise((resolve) => {
      if (!secure || !secure.isPaired()) {
        resolve({ ok: false, error: { code: -32000, message: 'Not paired yet' } });
        return;
      }
      const id = nextRequestId++;
      const timer = setTimeout(() => {
        if (pendingRequests.delete(id)) {
          resolve({ ok: false, error: { code: -32001, message: `Request "${method}" timed out` } });
        }
      }, timeoutMs);
      pendingRequests.set(id, { resolve, timer });
      try {
        sendApplication({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (e) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        resolve({ ok: false, error: { code: -32000, message: (e as Error).message } });
      }
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    if (!secure || !secure.isPaired()) return;
    sendApplication({ jsonrpc: '2.0', method, params: params ?? {} });
  }

  function sendResponse(id: number | string, result: unknown): void {
    if (!secure || !secure.isPaired()) return;
    sendApplication({ jsonrpc: '2.0', id, result });
  }

  function sendErrorResponse(id: number | string, code: number, message: string): void {
    if (!secure || !secure.isPaired()) return;
    sendApplication({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function sendApplication(rpc: unknown): void {
    if (!secure || !secure.isPaired()) {
      throw new Error('Cannot send application message before pairing is complete');
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    const env = secure.encryptApplication(JSON.stringify(rpc));
    ws.send(env);
  }

  return {
    close: () => ws.close(),
    sendRequest,
    sendNotification,
    sendResponse,
    sendErrorResponse,
  };
}

// Relay matchmaking convention from bridge.js:
//   const relayBaseUrl = config.relayUrl.replace(/\/+$/, "");
//   const relaySessionUrl = `${relayBaseUrl}/${sessionId}`;
export function relayUrlForSession(relay: string, sessionId: string): string {
  const trimmed = relay.replace(/\/+$/, '');
  return `${trimmed}/${sessionId}`;
}
