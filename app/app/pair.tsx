// Pairing + session list screen. Three modes:
//
//   1. Fresh pair: pendingPairing was just set by the QR scanner.
//      → handshakeMode = qr_bootstrap. On success, save to secure-store.
//   2. Auto-reconnect: pendingPairing is empty but savedPairing exists.
//      → handshakeMode = trusted_reconnect using the stored sessionId.
//      → If sessionId is stale (bridge restarted), the bridge errors and we
//        fall back to scanner with a friendly message.
//   3. No state at all: bounce to scanner.
//
// After pair: send `initialize`, then `thread/list`, render the result.

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/lib/icons';
import { loadOrCreatePhoneIdentity, PhoneIdentity } from '@/lib/protocol/identity';
import { fingerprint, shortId } from '@/lib/protocol/qr';
import {
  RelayClient,
  RelayClientEvent,
  createRelayClient,
} from '@/lib/protocol/relayClient';
import {
  HandshakeMode,
  HandshakeStage,
  PairingContext,
  SecureSession,
} from '@/lib/protocol/secureTransport';
import { resolveTrustedSession } from '@/lib/protocol/trustedSessionResolve';
import { pendingPairing } from '@/lib/state/pendingPairing';
import {
  clearSavedPairing,
  loadSavedPairing,
  saveSavedPairing,
} from '@/lib/state/savedPairing';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type ThreadRow = {
  id: string;
  title?: string;
  status?: string;
  cwd?: string;
  updatedAt?: number | string;
};

type TurnRow = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'approval' | 'unknown';
  text: string;
  status?: string;
  createdAt?: number | string;
  raw: unknown; // for debug rendering when nothing else parses
  // Only present when role === 'approval':
  approvalRequestId?: number | string;
  approvalMethod?: string;
  approvalCommand?: string;
  approvalReason?: string;
  approvalDecision?: 'accept' | 'reject';
};

type Status =
  | { kind: 'loading' }
  | { kind: 'no-payload' }
  | { kind: 'connecting'; stage: HandshakeStage | 'opening' }
  | { kind: 'paired'; session: SecureSession; pairing: PairingContext; mode: HandshakeMode }
  | { kind: 'sessions-loading'; session: SecureSession; pairing: PairingContext; mode: HandshakeMode }
  | {
      kind: 'sessions-ready';
      session: SecureSession;
      pairing: PairingContext;
      mode: HandshakeMode;
      threads: ThreadRow[];
      raw: unknown;
    }
  | {
      kind: 'thread-loading';
      session: SecureSession;
      pairing: PairingContext;
      mode: HandshakeMode;
      threads: ThreadRow[];
      thread: ThreadRow;
    }
  | {
      kind: 'thread-ready';
      session: SecureSession;
      pairing: PairingContext;
      mode: HandshakeMode;
      threads: ThreadRow[];
      thread: ThreadRow;
      turns: TurnRow[];
      rawTurns: unknown;
      composer: string;
      activeTurnId: string | null;
      streamingText: string;
      isSending: boolean;
    }
  | {
      kind: 'thread-error';
      session: SecureSession;
      pairing: PairingContext;
      mode: HandshakeMode;
      threads: ThreadRow[];
      thread: ThreadRow;
      message: string;
    }
  | { kind: 'error'; message: string; code?: string; canRetry: boolean };

const STAGE_LABEL: Record<HandshakeStage | 'opening' | 'connected', string> = {
  opening: 'Opening WebSocket to relay…',
  connected: 'Connected to relay',
  idle: 'Preparing handshake…',
  'sending-client-hello': 'Sending clientHello…',
  'awaiting-server-hello': 'Awaiting serverHello…',
  'sending-client-auth': 'Verified Mac signature · sending clientAuth…',
  'awaiting-secure-ready': 'Awaiting secureReady…',
  paired: 'Paired',
  failed: 'Failed',
};

export default function PairScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const clientRef = useRef<RelayClient | null>(null);
  const pairingRef = useRef<PairingContext | null>(null);
  const modeRef = useRef<HandshakeMode>('qr_bootstrap');

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Resolve which pairing context to use.
      let pairing: PairingContext | null = pendingPairing.consume();
      let mode: HandshakeMode = 'qr_bootstrap';

      if (!pairing) {
        const saved = await loadSavedPairing();
        if (saved) {
          // Always ask the relay for the *current* sessionId for this trusted
          // Mac before connecting. The saved sessionId is from a previous
          // bridge-up invocation and is almost certainly stale by now.
          if (!cancelled) setStatus({ kind: 'connecting', stage: 'opening' });
          let identityForResolve: PhoneIdentity;
          try {
            identityForResolve = await loadOrCreatePhoneIdentity();
          } catch (e) {
            if (!cancelled) {
              setStatus({
                kind: 'error',
                message: `Failed to load phone identity: ${(e as Error).message}`,
                canRetry: true,
              });
            }
            return;
          }
          if (cancelled) return;

          const resolved = await resolveTrustedSession({
            relay: saved.relay,
            macDeviceId: saved.macDeviceId,
            identity: identityForResolve,
          });

          if (cancelled) return;

          if (resolved.ok) {
            pairing = {
              relay: saved.relay,
              sessionId: resolved.resolved.sessionId,
              macDeviceId: resolved.resolved.macDeviceId,
              macIdentityPublicKey: resolved.resolved.macIdentityPublicKey,
            };
            mode = 'trusted_reconnect';
            // Refresh saved pairing with the new sessionId so subsequent attempts
            // (rare, since we re-resolve each launch anyway) start from the freshest data.
            void saveSavedPairing({
              relay: saved.relay,
              sessionId: resolved.resolved.sessionId,
              macDeviceId: resolved.resolved.macDeviceId,
              macIdentityPublicKey: resolved.resolved.macIdentityPublicKey,
            });
          } else if (resolved.error.kind === 'mac_offline') {
            setStatus({
              kind: 'error',
              message: 'Your trusted Mac appears to be offline. Start `remodex up` and re-open the app.',
              code: 'mac_offline',
              canRetry: true,
            });
            return;
          } else if (resolved.error.kind === 'phone_not_trusted') {
            // Trust was wiped (e.g. someone ran `remodex reset-pairing`). Force re-pair.
            await clearSavedPairing();
            setStatus({
              kind: 'error',
              message: 'This phone is no longer trusted by the Mac. Re-pair to continue.',
              code: 'phone_not_trusted',
              canRetry: true,
            });
            return;
          } else {
            // network / invalid_response / unsupported_relay → try with the
            // saved (possibly stale) sessionId; the bridge will tell us if it's stale.
            pairing = {
              relay: saved.relay,
              sessionId: saved.sessionId,
              macDeviceId: saved.macDeviceId,
              macIdentityPublicKey: saved.macIdentityPublicKey,
            };
            mode = 'trusted_reconnect';
          }
        }
      }

      if (!pairing) {
        if (!cancelled) setStatus({ kind: 'no-payload' });
        return;
      }

      pairingRef.current = pairing;
      modeRef.current = mode;

      let identity: PhoneIdentity;
      try {
        identity = await loadOrCreatePhoneIdentity();
      } catch (e) {
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: `Failed to load phone identity: ${(e as Error).message}`,
            canRetry: true,
          });
        }
        return;
      }
      if (cancelled) return;

      setStatus({ kind: 'connecting', stage: 'opening' });

      const client = createRelayClient({
        pairing,
        identity,
        handshakeMode: mode,
        emit: (event: RelayClientEvent) => {
          if (cancelled) return;
          switch (event.type) {
            case 'connecting':
              setStatus({ kind: 'connecting', stage: 'opening' });
              return;
            case 'connected':
              setStatus({ kind: 'connecting', stage: 'idle' });
              return;
            case 'stage':
              setStatus({ kind: 'connecting', stage: event.stage });
              return;
            case 'paired':
              setStatus({
                kind: 'paired',
                session: event.session,
                pairing: pairing!,
                mode,
              });
              // Save now so future launches can auto-resume.
              void saveSavedPairing({
                relay: pairing!.relay,
                sessionId: pairing!.sessionId,
                macDeviceId: event.session.macDeviceId,
                macIdentityPublicKey: event.session.macIdentityPublicKey,
              });
              // Kick off session-list bootstrap immediately.
              void bootstrapSessions(event.session, pairing!, mode);
              return;
            case 'application':
              if (__DEV__) {
                console.log('[remodex] app msg:', event.payloadText.slice(0, 240));
              }
              return;
            case 'notification':
              if (__DEV__) {
                console.log('[remodex] notif:', event.method);
              }
              handleNotification(event.method, event.params);
              return;
            case 'serverRequest':
              if (__DEV__) {
                console.log('[remodex] server req:', event.method, event.id);
              }
              handleServerRequest(event.id, event.method, event.params);
              return;
            case 'error':
              setStatus({
                kind: 'error',
                message: event.message,
                code: event.code,
                canRetry: true,
              });
              return;
            case 'closed':
              setStatus((prev) => {
                if (prev.kind === 'sessions-ready' || prev.kind === 'sessions-loading' || prev.kind === 'paired') {
                  return {
                    kind: 'error',
                    message: `Disconnected (code ${event.code})`,
                    canRetry: true,
                  };
                }
                if (prev.kind === 'error') return prev;
                const reason = event.reason ? `: ${event.reason}` : '';
                return {
                  kind: 'error',
                  message: `Connection closed before pairing (code ${event.code}${reason})`,
                  code: `ws_close_${event.code}`,
                  canRetry: true,
                };
              });
              return;
          }
        },
      });
      clientRef.current = client;
    })();

    async function bootstrapSessions(
      session: SecureSession,
      pairing: PairingContext,
      mode: HandshakeMode,
    ) {
      const client = clientRef.current;
      if (!client || cancelled) return;

      setStatus({ kind: 'sessions-loading', session, pairing, mode });

      // 1) initialize — announces our client and asks for experimental capabilities.
      const initResp = await client.sendRequest('initialize', {
        clientInfo: {
          name: 'remodex_android',
          title: 'Remodex Android',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      if (!initResp.ok) {
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: `initialize failed: ${initResp.error.message}`,
            code: String(initResp.error.code),
            canRetry: true,
          });
        }
        return;
      }

      // 2) thread/list — paginated; for MVP just grab the first page.
      const listResp = await client.sendRequest('thread/list', { limit: 50 });
      if (!listResp.ok) {
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: `thread/list failed: ${listResp.error.message}`,
            code: String(listResp.error.code),
            canRetry: true,
          });
        }
        return;
      }

      const threads = extractThreads(listResp.result);
      if (!cancelled) {
        setStatus({
          kind: 'sessions-ready',
          session,
          pairing,
          mode,
          threads,
          raw: listResp.result,
        });
      }
    }

    return () => {
      cancelled = true;
      clientRef.current?.close();
    };
  }, []);

  async function rescan() {
    await clearSavedPairing();
    router.replace('/scan');
  }

  async function openThread(thread: ThreadRow) {
    const client = clientRef.current;
    if (!client) return;
    const cur = status;
    if (cur.kind !== 'sessions-ready') return;

    setStatus({
      kind: 'thread-loading',
      session: cur.session,
      pairing: cur.pairing,
      mode: cur.mode,
      threads: cur.threads,
      thread,
    });

    const resp = await client.sendRequest('thread/turns/list', {
      threadId: thread.id,
      limit: 80,
      sortDirection: 'desc',
    });

    if (resp.ok) {
      setStatus({
        kind: 'thread-ready',
        session: cur.session,
        pairing: cur.pairing,
        mode: cur.mode,
        threads: cur.threads,
        thread,
        turns: extractTurns(resp.result),
        rawTurns: resp.result,
        composer: '',
        activeTurnId: null,
        streamingText: '',
        isSending: false,
      });
    } else {
      setStatus({
        kind: 'thread-error',
        session: cur.session,
        pairing: cur.pairing,
        mode: cur.mode,
        threads: cur.threads,
        thread,
        message: `${resp.error.message} (${resp.error.code})`,
      });
    }
  }

  function handleServerRequest(id: number | string, method: string, params: unknown) {
    // Approval requests come as JSON-RPC requests with method ending in
    // "requestApproval". Per CodexService+Incoming.swift line 125-138.
    if (!method.endsWith('requestApproval') && method !== 'item/tool/requestUserInput') {
      // Other server requests we don't yet understand — error back so the bridge
      // doesn't hang waiting for a response.
      clientRef.current?.sendErrorResponse(id, -32601, `Unsupported method: ${method}`);
      return;
    }

    setStatus((prev) => {
      if (prev.kind !== 'thread-ready') return prev;
      const p = (params && typeof params === 'object' ? (params as Record<string, unknown>) : {}) as Record<string, unknown>;
      const threadId = typeof p.threadId === 'string' ? p.threadId : undefined;
      if (threadId && threadId !== prev.thread.id) {
        // Approval is for a different thread — auto-reject so we don't strand
        // the bridge. We'll do a smarter inbox later when there's UI for cross-
        // thread approvals.
        clientRef.current?.sendResponse(id, { decision: 'reject' });
        return prev;
      }

      const approval: TurnRow = {
        id: `approval-${id}`,
        role: 'approval',
        text: '',
        raw: p,
        approvalRequestId: id,
        approvalMethod: method,
        approvalCommand: pickString(p.command, p.shellCommand, p.path),
        approvalReason: pickString(p.reason, p.justification, p.summary),
      };
      return { ...prev, turns: [approval, ...prev.turns] };
    });
  }

  function decideApproval(turn: TurnRow, decision: 'accept' | 'reject') {
    const id = turn.approvalRequestId;
    if (id === undefined || id === null) return;
    clientRef.current?.sendResponse(id, { decision });
    setStatus((prev) => {
      if (prev.kind !== 'thread-ready') return prev;
      return {
        ...prev,
        turns: prev.turns.map((t) =>
          t.id === turn.id ? { ...t, approvalDecision: decision } : t,
        ),
      };
    });
  }

  function handleNotification(method: string, params: unknown) {
    setStatus((prev) => {
      if (prev.kind !== 'thread-ready') return prev;
      const p = (params && typeof params === 'object' ? (params as Record<string, unknown>) : {}) as Record<string, unknown>;
      const threadId = typeof p.threadId === 'string' ? p.threadId : undefined;
      // Only act on notifications for the open thread.
      if (threadId && threadId !== prev.thread.id) return prev;

      switch (method) {
        case 'turn/started': {
          const turnId = pickString(p.turnId, p.id);
          return { ...prev, activeTurnId: turnId, streamingText: '' };
        }
        case 'item/agentMessage/delta':
        case 'codex/event/agent_message_delta': {
          const delta = pickString(p.delta, p.text, p.chunk, p.deltaText);
          if (!delta) return prev;
          return { ...prev, streamingText: prev.streamingText + delta };
        }
        case 'item/completed':
        case 'codex/event/agent_message':
        case 'codex/event/item_completed': {
          // If we got a final assistant message, prefer it over our streaming buffer.
          const finalText = pickString(p.text, p.message, p.content)
            || (p.item && typeof p.item === 'object' ? pickString((p.item as any).text, (p.item as any).content) : '')
            || prev.streamingText;
          if (!finalText) return prev;
          const newTurn: TurnRow = {
            id: pickString(p.id, p.itemId, prev.activeTurnId, `live-${Date.now()}`),
            role: 'assistant',
            text: finalText,
            raw: p,
          };
          return {
            ...prev,
            turns: [newTurn, ...prev.turns],
            streamingText: '',
          };
        }
        case 'turn/completed':
          return { ...prev, activeTurnId: null, streamingText: '', isSending: false };
        case 'turn/failed':
        case 'error':
        case 'codex/event/error': {
          const msg = pickString(p.message, p.error, 'turn failed');
          const errTurn: TurnRow = {
            id: `err-${Date.now()}`,
            role: 'system',
            text: `[error] ${msg}`,
            raw: p,
          };
          return {
            ...prev,
            turns: [errTurn, ...prev.turns],
            activeTurnId: null,
            streamingText: '',
            isSending: false,
          };
        }
        default:
          return prev;
      }
    });
  }

  async function sendPrompt() {
    const cur = status;
    if (cur.kind !== 'thread-ready') return;
    const text = cur.composer.trim();
    if (!text || cur.isSending) return;
    const client = clientRef.current;
    if (!client) return;

    // Optimistically render the user message immediately.
    const optimisticUser: TurnRow = {
      id: `local-${Date.now()}`,
      role: 'user',
      text,
      raw: null,
    };
    setStatus({
      ...cur,
      turns: [optimisticUser, ...cur.turns],
      composer: '',
      isSending: true,
      streamingText: '',
      activeTurnId: null,
    });

    const resp = await client.sendRequest('turn/start', {
      threadId: cur.thread.id,
      input: [{ type: 'text', text }],
    });

    if (!resp.ok) {
      setStatus((prev) => {
        if (prev.kind !== 'thread-ready') return prev;
        const errTurn: TurnRow = {
          id: `send-err-${Date.now()}`,
          role: 'system',
          text: `[turn/start failed] ${resp.error.message}`,
          raw: resp.error,
        };
        return {
          ...prev,
          turns: [errTurn, ...prev.turns],
          isSending: false,
        };
      });
    }
  }

  function setComposer(text: string) {
    setStatus((prev) => (prev.kind === 'thread-ready' ? { ...prev, composer: text } : prev));
  }

  function closeThread() {
    setStatus((prev) => {
      if (
        prev.kind === 'thread-ready'
        || prev.kind === 'thread-loading'
        || prev.kind === 'thread-error'
      ) {
        return {
          kind: 'sessions-ready',
          session: prev.session,
          pairing: prev.pairing,
          mode: prev.mode,
          threads: prev.threads,
          raw: null,
        };
      }
      return prev;
    });
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.topBar}>
        <Pressable
          onPress={() => router.replace('/')}
          hitSlop={12}
          style={styles.backBtn}>
          <Icon name="chevron.left" size={20} color={colors.fg} />
        </Pressable>
      </SafeAreaView>

      {status.kind === 'loading' && <Centered>Loading identity…</Centered>}

      {status.kind === 'no-payload' && (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>No saved pairing</Text>
          <Text style={styles.body50}>Scan a QR from `remodex up` to pair.</Text>
          <Cta label="Open scanner" onPress={() => router.replace('/scan')} />
        </ScrollView>
      )}

      {status.kind === 'connecting' && (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.title}>
            {modeRef.current === 'trusted_reconnect' ? 'Reconnecting…' : 'Pairing…'}
          </Text>
          <Text style={styles.body50}>{STAGE_LABEL[status.stage]}</Text>
          <ActivityIndicator color={colors.plan} />
          {pairingRef.current && (
            <View style={styles.fields}>
              <Field label="Relay" value={pairingRef.current.relay} />
              <Field label="Session" value={shortId(pairingRef.current.sessionId, 12)} />
              <Field
                label="Mac fingerprint"
                value={fingerprint(pairingRef.current.macIdentityPublicKey)}
              />
              <Field label="Mode" value={modeRef.current} />
            </View>
          )}
        </ScrollView>
      )}

      {status.kind === 'paired' && <Centered>Paired ✓ — fetching sessions…</Centered>}

      {status.kind === 'sessions-loading' && (
        <ScrollView contentContainerStyle={styles.body}>
          <PairedHeader session={status.session} mode={status.mode} />
          <View style={styles.row}>
            <ActivityIndicator color={colors.plan} />
            <Text style={styles.body50}>Sending initialize + thread/list…</Text>
          </View>
        </ScrollView>
      )}

      {status.kind === 'sessions-ready' && (
        <View style={{ flex: 1 }}>
          <PairedHeader session={status.session} mode={status.mode} />
          <FlatList
            data={status.threads}
            keyExtractor={(t, i) => t.id || `thread-${i}`}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.body50}>
                  No threads returned by the bridge. Start one in Codex CLI on your Mac to see it
                  here.
                </Text>
              </View>
            }
            ListHeaderComponent={
              <Text style={styles.sectionLabel}>
                {status.threads.length} thread{status.threads.length === 1 ? '' : 's'}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable onPress={() => openThread(item)} style={({ pressed }) => pressed && { opacity: 0.6 }}>
                <ThreadRowView thread={item} />
              </Pressable>
            )}
            contentContainerStyle={styles.listPad}
          />
          <View style={styles.footerBar}>
            <Pressable onPress={rescan} style={styles.footerBtn}>
              <Text style={styles.footerBtnText}>Re-pair</Text>
            </Pressable>
          </View>
        </View>
      )}

      {(status.kind === 'thread-loading' || status.kind === 'thread-ready' || status.kind === 'thread-error') && (
        <View style={{ flex: 1 }}>
          <ThreadHeader thread={status.thread} onBack={closeThread} />
          {status.kind === 'thread-loading' && (
            <View style={styles.row}>
              <ActivityIndicator color={colors.plan} />
              <Text style={styles.body50}>Loading turns…</Text>
            </View>
          )}
          {status.kind === 'thread-error' && (
            <View style={styles.body}>
              <Text style={[styles.title, { color: '#ff8b8b' }]}>Couldn't load turns</Text>
              <Text style={styles.body50}>{status.message}</Text>
              <Cta label="Back to threads" onPress={closeThread} />
            </View>
          )}
          {status.kind === 'thread-ready' && (
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={0}>
              <FlatList
                data={status.turns}
                keyExtractor={(t, i) => t.id || `turn-${i}`}
                inverted
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.body50}>This thread has no turns yet.</Text>
                  </View>
                }
                ListHeaderComponent={
                  status.streamingText ? (
                    <View style={[styles.turnRow, styles.turnRowStreaming]}>
                      <Text style={styles.turnRoleLabel}>assistant</Text>
                      <Text style={styles.turnText}>
                        {status.streamingText}
                        <Text style={{ color: colors.fg45 }}>▍</Text>
                      </Text>
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <TurnView
                    turn={item}
                    onApprove={(t) => decideApproval(t, 'accept')}
                    onReject={(t) => decideApproval(t, 'reject')}
                  />
                )}
                contentContainerStyle={styles.turnsPad}
              />
              <Composer
                text={status.composer}
                onChange={setComposer}
                onSend={sendPrompt}
                disabled={status.isSending}
              />
            </KeyboardAvoidingView>
          )}
        </View>
      )}

      {status.kind === 'error' && (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={[styles.title, { color: '#ff8b8b' }]}>
            {modeRef.current === 'trusted_reconnect' ? 'Could not reconnect' : 'Pairing failed'}
          </Text>
          <Text style={styles.body50}>{status.message}</Text>
          {status.code && <Text style={styles.codePill}>{status.code}</Text>}
          {modeRef.current === 'trusted_reconnect' && (
            <Text style={styles.body50}>
              The saved sessionId may be stale (Mac restarted). Re-pair to refresh.
            </Text>
          )}
          {status.canRetry && <Cta label="Re-pair (open scanner)" onPress={rescan} />}
        </ScrollView>
      )}
    </View>
  );
}

function PairedHeader({ session, mode }: { session: SecureSession; mode: HandshakeMode }) {
  return (
    <View style={styles.headerCard}>
      <View style={styles.checkBubbleSmall}>
        <Icon name="checkmark" size={14} color={colors.bg} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>
          {mode === 'trusted_reconnect' ? 'Reconnected' : 'Paired'} · {fingerprint(session.macIdentityPublicKey)}
        </Text>
        <Text style={styles.headerSub}>
          {shortId(session.macDeviceId, 12)} · key epoch {session.keyEpoch}
        </Text>
      </View>
    </View>
  );
}

function ThreadRowView({ thread }: { thread: ThreadRow }) {
  const subtitle = thread.cwd
    ? thread.cwd
    : thread.status
      ? thread.status
      : thread.id;
  return (
    <View style={styles.threadRow}>
      <Text style={styles.threadTitle} numberOfLines={1}>
        {thread.title || thread.id}
      </Text>
      <Text style={styles.threadSub} numberOfLines={1}>
        {subtitle}
      </Text>
    </View>
  );
}

function ThreadHeader({ thread, onBack }: { thread: ThreadRow; onBack: () => void }) {
  return (
    <View style={styles.threadHeaderBar}>
      <Pressable onPress={onBack} hitSlop={12} style={styles.backBtnSmall}>
        <Icon name="chevron.left" size={18} color={colors.fg} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.threadHeaderTitle} numberOfLines={1}>
          {thread.title || thread.id}
        </Text>
        {thread.cwd ? (
          <Text style={styles.threadHeaderSub} numberOfLines={1}>
            {thread.cwd}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Composer({
  text,
  onChange,
  onSend,
  disabled,
}: {
  text: string;
  onChange: (s: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  return (
    <View style={styles.composerBar}>
      <TextInput
        style={styles.composerInput}
        value={text}
        onChangeText={onChange}
        placeholder="Send a prompt to Codex…"
        placeholderTextColor={colors.fg40}
        multiline
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable
        onPress={onSend}
        disabled={disabled || !text.trim()}
        style={({ pressed }) => [
          styles.composerSendBtn,
          (disabled || !text.trim()) && { opacity: 0.4 },
          pressed && { opacity: 0.7 },
        ]}>
        {disabled ? (
          <ActivityIndicator color={colors.bg} size="small" />
        ) : (
          <Icon name="qrcode" size={16} color={colors.bg} />
        )}
      </Pressable>
    </View>
  );
}

function pickString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

function TurnView({
  turn,
  onApprove,
  onReject,
}: {
  turn: TurnRow;
  onApprove?: (turn: TurnRow) => void;
  onReject?: (turn: TurnRow) => void;
}) {
  if (turn.role === 'approval') {
    return <ApprovalCard turn={turn} onApprove={onApprove} onReject={onReject} />;
  }
  const isUser = turn.role === 'user';
  const isAssistant = turn.role === 'assistant';
  return (
    <View style={[styles.turnRow, isUser && styles.turnRowUser]}>
      <Text style={[styles.turnRoleLabel, isUser && { color: colors.plan }]}>
        {turn.role}
      </Text>
      <Text style={[styles.turnText, isAssistant && { color: colors.fg }]}>
        {turn.text || '(empty)'}
      </Text>
    </View>
  );
}

function ApprovalCard({
  turn,
  onApprove,
  onReject,
}: {
  turn: TurnRow;
  onApprove?: (turn: TurnRow) => void;
  onReject?: (turn: TurnRow) => void;
}) {
  const kind = approvalKindLabel(turn.approvalMethod || '');
  const decided = turn.approvalDecision;
  return (
    <View style={styles.approvalCard}>
      <Text style={styles.approvalKind}>{kind}</Text>
      {turn.approvalCommand ? (
        <Text style={styles.approvalCommand} numberOfLines={6}>
          {turn.approvalCommand}
        </Text>
      ) : null}
      {turn.approvalReason ? (
        <Text style={styles.approvalReason}>{turn.approvalReason}</Text>
      ) : null}
      {decided ? (
        <Text style={[styles.approvalDecided, decided === 'accept' ? { color: '#9be39a' } : { color: '#ff8b8b' }]}>
          {decided === 'accept' ? '✓ Approved' : '✕ Rejected'}
        </Text>
      ) : (
        <View style={styles.approvalActions}>
          <Pressable
            onPress={() => onReject?.(turn)}
            style={({ pressed }) => [styles.approvalRejectBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.approvalRejectText}>Reject</Text>
          </Pressable>
          <Pressable
            onPress={() => onApprove?.(turn)}
            style={({ pressed }) => [styles.approvalApproveBtn, pressed && { opacity: 0.7 }]}>
            <Text style={styles.approvalApproveText}>Approve</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

function approvalKindLabel(method: string): string {
  if (method.includes('commandExecution')) return 'Run command';
  if (method.includes('fileChange')) return 'Apply file change';
  if (method.includes('requestUserInput')) return 'User input requested';
  if (method.endsWith('requestApproval')) return method.replace(/\/requestApproval$/, '');
  return method || 'Approval requested';
}

function extractTurns(result: unknown): TurnRow[] {
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const list =
    (Array.isArray(obj.data) && (obj.data as unknown[]))
    || (Array.isArray(obj.items) && (obj.items as unknown[]))
    || (Array.isArray(obj.turns) && (obj.turns as unknown[]))
    || [];

  const rows: TurnRow[] = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const turn = t as Record<string, unknown>;
    const id =
      typeof turn.id === 'string'
        ? turn.id
        : typeof turn.turnId === 'string'
          ? (turn.turnId as string)
          : '';

    // A "turn" packs both the user input and the assistant's reply together.
    // Render them as two stacked rows so the chat UI reads top-to-bottom.
    const userText = pickText(
      turn.userInput,
      turn.input,
      turn.prompt,
      turn.userMessage,
      turn.user,
    );
    const assistantText = pickText(
      turn.assistantOutput,
      turn.output,
      turn.response,
      turn.assistantMessage,
      turn.assistant,
      turn.text,
    );

    if (userText) {
      rows.push({
        id: `${id}:user`,
        role: 'user',
        text: userText,
        status: typeof turn.status === 'string' ? turn.status : undefined,
        createdAt:
          typeof turn.createdAt === 'number' || typeof turn.createdAt === 'string'
            ? (turn.createdAt as number | string)
            : undefined,
        raw: turn,
      });
    }
    if (assistantText) {
      rows.push({
        id: `${id}:assistant`,
        role: 'assistant',
        text: assistantText,
        status: typeof turn.status === 'string' ? turn.status : undefined,
        createdAt:
          typeof turn.completedAt === 'number' || typeof turn.completedAt === 'string'
            ? (turn.completedAt as number | string)
            : undefined,
        raw: turn,
      });
    }
    if (!userText && !assistantText) {
      // Fallback: dump JSON so we can iterate on the parser.
      rows.push({
        id: id || `unknown-${rows.length}`,
        role: 'unknown',
        text: JSON.stringify(turn).slice(0, 4000),
        raw: turn,
      });
    }
  }
  return rows;
}

function pickText(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
    if (Array.isArray(c)) {
      // Some shapes nest content as an array of {type, text} chunks (Codex/Claude style).
      const joined = c
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof (part as any).text === 'string') {
            return (part as any).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      if (joined.trim()) return joined;
    }
    if (c && typeof c === 'object' && typeof (c as any).text === 'string') {
      return (c as any).text;
    }
  }
  return '';
}

function extractThreads(result: unknown): ThreadRow[] {
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const list =
    (Array.isArray(obj.data) && (obj.data as unknown[]))
    || (Array.isArray(obj.items) && (obj.items as unknown[]))
    || (Array.isArray(obj.threads) && (obj.threads as unknown[]))
    || [];
  return list
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map<ThreadRow>((t) => ({
      id: typeof t.id === 'string' ? t.id : typeof t.threadId === 'string' ? t.threadId : '',
      title: typeof t.title === 'string' ? t.title : typeof t.name === 'string' ? t.name : undefined,
      status: typeof t.status === 'string' ? t.status : undefined,
      cwd: typeof t.cwd === 'string' ? t.cwd : undefined,
      updatedAt:
        typeof t.updatedAt === 'number' || typeof t.updatedAt === 'string'
          ? (t.updatedAt as number | string)
          : undefined,
    }))
    .filter((t) => t.id);
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.centered}>
      <Text style={styles.centeredText}>{children}</Text>
    </View>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fieldRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.mono}>{value}</Text>
    </View>
  );
}

function Cta({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.btn}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fg10,
  },
  body: { padding: spacing.xl, paddingTop: 40, gap: spacing.lg, flexGrow: 1 },
  title: { color: colors.fg, fontSize: fontSize.pageTitle, fontWeight: weight.bold },
  body50: { color: colors.fg50, fontSize: fontSize.subheadline, lineHeight: 22 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  fields: { gap: spacing.md, marginTop: spacing.sm },
  fieldRow: { gap: 4 },
  fieldLabel: {
    color: 'rgba(125,138,153,1)',
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  mono: { color: colors.fg, fontFamily: 'Menlo', fontSize: fontSize.footnote + 1 },
  headerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    margin: spacing.xl,
    marginTop: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.fg6,
    borderWidth: 1,
    borderColor: colors.fg10,
  },
  checkBubbleSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#9be39a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { color: colors.fg, fontSize: fontSize.body, fontWeight: weight.semibold },
  headerSub: {
    color: colors.fg50,
    fontSize: fontSize.caption,
    marginTop: 2,
    fontFamily: 'Menlo',
  },
  sectionLabel: {
    color: 'rgba(125,138,153,1)',
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  listPad: { paddingHorizontal: spacing.xl, paddingBottom: 100 },
  threadRow: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.fg10,
  },
  threadTitle: { color: colors.fg, fontSize: fontSize.body, fontWeight: weight.semibold },
  threadSub: { color: colors.fg50, fontSize: fontSize.caption, marginTop: 2 },
  empty: { paddingVertical: spacing.xxl, alignItems: 'center' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  centeredText: { color: colors.fg, fontSize: fontSize.subheadline, textAlign: 'center' },
  codePill: {
    alignSelf: 'flex-start',
    color: colors.fg70,
    fontSize: fontSize.caption,
    backgroundColor: colors.fg10,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    fontFamily: 'Menlo',
  },
  btn: {
    backgroundColor: colors.plan,
    paddingVertical: 14,
    borderRadius: radius.capsule,
    marginTop: spacing.md,
  },
  btnText: {
    color: colors.fg,
    textAlign: 'center',
    fontWeight: weight.semibold,
    fontSize: fontSize.body,
  },
  footerBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.xl,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.fg10,
  },
  footerBtn: {
    backgroundColor: colors.fg10,
    paddingVertical: 12,
    borderRadius: radius.capsule,
  },
  footerBtnText: {
    color: colors.fg,
    textAlign: 'center',
    fontWeight: weight.semibold,
  },
  threadHeaderBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.fg10,
    backgroundColor: colors.bg,
  },
  backBtnSmall: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fg10,
  },
  threadHeaderTitle: {
    color: colors.fg,
    fontSize: fontSize.body,
    fontWeight: weight.semibold,
  },
  threadHeaderSub: {
    color: colors.fg50,
    fontSize: fontSize.caption,
    fontFamily: 'Menlo',
    marginTop: 2,
  },
  turnsPad: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, paddingTop: spacing.md },
  turnRow: {
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.fg10,
    gap: 6,
  },
  turnRowUser: {
    // Subtle row tint for user prompts to make the alternation read like a chat.
  },
  turnRoleLabel: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: weight.semibold,
  },
  turnText: {
    color: colors.fg82,
    fontSize: fontSize.body,
    lineHeight: fontSize.body + 7,
  },
  turnRowStreaming: {
    backgroundColor: colors.fg5,
    borderRadius: radius.md,
    padding: spacing.md,
    marginVertical: spacing.sm,
    borderBottomWidth: 0,
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.fg10,
    backgroundColor: colors.bg,
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    color: colors.fg,
    fontSize: fontSize.body,
    backgroundColor: colors.fg6,
    borderRadius: radius.card,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.fg10,
  },
  composerSendBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.fg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approvalCard: {
    backgroundColor: colors.fg6,
    borderRadius: radius.card,
    padding: spacing.lg,
    marginVertical: spacing.sm,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.planBorderTop,
  },
  approvalKind: {
    color: colors.plan,
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: weight.semibold,
  },
  approvalCommand: {
    color: colors.fg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote + 1,
    backgroundColor: colors.bg,
    padding: spacing.sm,
    borderRadius: radius.sm,
  },
  approvalReason: { color: colors.fg70, fontSize: fontSize.caption, lineHeight: 16 },
  approvalDecided: { fontSize: fontSize.caption, fontWeight: weight.semibold },
  approvalActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  approvalRejectBtn: {
    flex: 1,
    backgroundColor: colors.fg10,
    paddingVertical: 10,
    borderRadius: radius.capsule,
    alignItems: 'center',
  },
  approvalRejectText: { color: colors.fg, fontWeight: weight.semibold },
  approvalApproveBtn: {
    flex: 1,
    backgroundColor: colors.plan,
    paddingVertical: 10,
    borderRadius: radius.capsule,
    alignItems: 'center',
  },
  approvalApproveText: { color: colors.fg, fontWeight: weight.semibold },
});
