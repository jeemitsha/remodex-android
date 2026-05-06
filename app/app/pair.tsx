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
  SectionList,
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
import { groupThreadsByProject, relativeTime, statusColor } from '@/lib/sidebar';
import { pendingPairing } from '@/lib/state/pendingPairing';
import {
  clearSavedPairing,
  loadSavedPairing,
  saveSavedPairing,
} from '@/lib/state/savedPairing';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

// Thread/turn types and parsers live in lib/protocol/extract.ts so they can be
// fixture-tested. Keep the imports here narrow.
import { extractThreads, extractTurns, ThreadRow, TurnRow } from '@/lib/protocol/extract';

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
      return { ...prev, turns: [...prev.turns, approval] };
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
          // New turns append to the END of the array so chronological order is
          // preserved (oldest at top, newest at bottom — matches iOS Codex).
          return {
            ...prev,
            turns: [...prev.turns, newTurn],
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
            turns: [...prev.turns, errTurn],
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
      turns: [...cur.turns, optimisticUser],
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
          turns: [...prev.turns, errTurn],
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
          {status.threads.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.body50}>
                No threads returned by the bridge. Start one in Codex CLI on your Mac to see it
                here.
              </Text>
            </View>
          ) : (
            <SectionList
              sections={groupThreadsByProject(status.threads).map((g) => ({
                key: g.key,
                label: g.label,
                fullPath: g.fullPath,
                data: g.threads,
              }))}
              keyExtractor={(t, i) => t.id || `thread-${i}`}
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section }) => (
                <View style={styles.projectSectionHeader}>
                  <Text style={styles.projectSectionLabel} numberOfLines={1}>
                    {section.label}
                  </Text>
                  <Text style={styles.projectSectionCount}>
                    {section.data.length}
                  </Text>
                </View>
              )}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => openThread(item)}
                  style={({ pressed }) => pressed && { opacity: 0.6 }}>
                  <ThreadRowView thread={item} />
                </Pressable>
              )}
              ItemSeparatorComponent={() => <View style={styles.threadRowSep} />}
              contentContainerStyle={styles.listPad}
            />
          )}
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
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.body50}>This thread has no turns yet.</Text>
                  </View>
                }
                ListFooterComponent={
                  status.streamingText ? (
                    <View style={[styles.bubbleRow, styles.bubbleRowLeft]}>
                      <View style={[styles.bubble, styles.bubbleAssistant]}>
                        <Text style={styles.bubbleText}>
                          {status.streamingText}
                          <Text style={{ color: colors.fg45 }}>▍</Text>
                        </Text>
                      </View>
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
  const dotColor = statusColor(thread.status);
  const timing = relativeTime(thread.updatedAt);
  const subtitle = thread.preview || (thread.branch ? `${thread.branch}` : '');
  return (
    <View style={styles.threadRow}>
      <View style={styles.threadDotSlot}>
        {dotColor ? <View style={[styles.threadDot, { backgroundColor: dotColor }]} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.threadTitle} numberOfLines={1}>
          {thread.title || thread.id}
        </Text>
        {subtitle ? (
          <Text style={styles.threadSub} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {thread.branch ? (
        <View style={styles.threadBranchPill}>
          <Icon name="arrow.triangle.branch" size={10} color={colors.fg50} />
          <Text style={styles.threadBranchText} numberOfLines={1}>
            {thread.branch}
          </Text>
        </View>
      ) : null}
      {timing ? <Text style={styles.threadTiming}>{timing}</Text> : null}
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

function TurnView({
  turn,
  onApprove,
  onReject,
}: {
  turn: TurnRow;
  onApprove?: (turn: TurnRow) => void;
  onReject?: (turn: TurnRow) => void;
}) {
  switch (turn.role) {
    case 'approval':
      return <ApprovalCard turn={turn} onApprove={onApprove} onReject={onReject} />;
    case 'tool':
      return <CommandCard turn={turn} />;
    case 'user':
      return <MessageBubble turn={turn} side="right" />;
    case 'assistant':
      return <MessageBubble turn={turn} side="left" />;
    case 'system':
      return <SystemRow turn={turn} />;
    default:
      return <SystemRow turn={turn} />;
  }
}

function MessageBubble({ turn, side }: { turn: TurnRow; side: 'left' | 'right' }) {
  const blocks = parseMarkdownBlocks(turn.text);
  return (
    <View style={[styles.bubbleRow, side === 'right' ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
      <View style={[styles.bubble, side === 'right' ? styles.bubbleUser : styles.bubbleAssistant]}>
        {blocks.map((b, i) =>
          b.type === 'code' ? (
            <CodeBlock key={i} language={b.language} text={b.text} />
          ) : (
            <Text key={i} style={[styles.bubbleText, side === 'right' && styles.bubbleTextUser]}>
              {b.text}
            </Text>
          ),
        )}
      </View>
    </View>
  );
}

function CodeBlock({ language, text }: { language?: string; text: string }) {
  return (
    <View style={styles.codeBlock}>
      {language ? <Text style={styles.codeBlockLang}>{language}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingRight: spacing.md }}>
        <Text style={styles.codeBlockText}>{text}</Text>
      </ScrollView>
    </View>
  );
}

function CommandCard({ turn }: { turn: TurnRow }) {
  const exitOk = turn.exitCode === undefined ? null : turn.exitCode === 0;
  const statusLabel = turn.toolStatus || (exitOk === true ? 'completed' : exitOk === false ? 'failed' : 'pending');
  const duration = turn.durationMs ? formatDuration(turn.durationMs) : '';

  return (
    <View style={styles.cmdCard}>
      <View style={styles.cmdHeader}>
        <View style={styles.cmdHeaderLeft}>
          <Icon name="terminal" size={12} color={colors.fg50} />
          <Text style={styles.cmdHeaderLabel}>{cmdHeaderLabel(turn)}</Text>
        </View>
        <View style={styles.cmdHeaderRight}>
          {duration ? <Text style={styles.cmdMetaText}>{duration}</Text> : null}
          <Text
            style={[
              styles.cmdStatusPill,
              exitOk === true
                ? { color: '#9be39a', backgroundColor: 'rgba(155,227,154,0.12)' }
                : exitOk === false
                  ? { color: '#ff8b8b', backgroundColor: 'rgba(255,139,139,0.12)' }
                  : { color: colors.fg50, backgroundColor: colors.fg10 },
            ]}>
            {exitOk === true ? `✓ ${statusLabel}` : exitOk === false ? `✕ exit ${turn.exitCode}` : statusLabel}
          </Text>
        </View>
      </View>
      {turn.command ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingRight: spacing.md }}>
          <Text style={styles.cmdCommand}>{`$ ${turn.command}`}</Text>
        </ScrollView>
      ) : null}
      {turn.output ? <CommandOutput text={turn.output} /> : null}
    </View>
  );
}

function CommandOutput({ text }: { text: string }) {
  const lines = text.split('\n');
  const isLong = lines.length > 8;
  const [expanded, setExpanded] = useState(false);
  const visible = !isLong || expanded ? text : lines.slice(0, 8).join('\n');
  return (
    <View style={styles.cmdOutputWrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingRight: spacing.md }}>
        <Text style={styles.cmdOutputText}>{visible}</Text>
      </ScrollView>
      {isLong ? (
        <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8}>
          <Text style={styles.cmdExpand}>
            {expanded ? 'Show less' : `Show ${lines.length - 8} more lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function SystemRow({ turn }: { turn: TurnRow }) {
  return (
    <View style={styles.systemRow}>
      <Text style={styles.systemRowLabel}>{turn.role === 'unknown' ? 'item' : turn.role}</Text>
      <Text style={styles.systemRowText} numberOfLines={6}>
        {turn.text}
      </Text>
    </View>
  );
}

function cmdHeaderLabel(turn: TurnRow): string {
  if (turn.cwd) {
    const base = turn.cwd.split('/').filter(Boolean).pop() || turn.cwd;
    return base;
  }
  return 'shell';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.round(s / 60)}m`;
}

// Minimal markdown-ish split: extracts ```fenced``` code blocks with optional
// language tag, leaves everything else as plain text. Real markdown rendering
// (lists, bold, headings, inline code) is a later pass — we'd add
// react-native-markdown-display once we accept the bundle-size hit.
type MarkdownBlock = { type: 'text'; text: string } | { type: 'code'; language?: string; text: string };
function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = input.split('\n');
  let i = 0;
  let buffer: string[] = [];
  const flushText = () => {
    if (buffer.length === 0) return;
    const text = buffer.join('\n').trim();
    if (text) blocks.push({ type: 'text', text });
    buffer = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      flushText();
      const language = fence[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', language, text: codeLines.join('\n') });
      i++; // skip closing fence
      continue;
    }
    buffer.push(line);
    i++;
  }
  flushText();
  return blocks.length > 0 ? blocks : [{ type: 'text', text: input }];
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

// Small local helper retained for pickString-of-arbitrary-unknowns inside
// notification/approval handlers.
function pickString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
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
  projectSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  projectSectionLabel: {
    color: colors.fg,
    fontSize: fontSize.subheadline,
    fontWeight: weight.semibold,
    flex: 1,
  },
  projectSectionCount: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    fontFamily: 'Menlo',
  },
  threadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  threadRowSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.fg10,
    marginLeft: 24, // align with title (skip the dot slot)
  },
  threadDotSlot: { width: 16, alignItems: 'center', justifyContent: 'center' },
  threadDot: { width: 8, height: 8, borderRadius: 4 },
  threadTitle: { color: colors.fg, fontSize: fontSize.body, fontWeight: weight.regular },
  threadSub: { color: colors.fg45, fontSize: fontSize.caption, marginTop: 2 },
  threadTiming: { color: colors.fg45, fontSize: fontSize.footnote, fontFamily: 'Menlo' },
  threadBranchPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.fg6,
    borderRadius: radius.sm,
    maxWidth: 100,
  },
  threadBranchText: {
    color: colors.fg50,
    fontSize: fontSize.caption2,
    fontFamily: 'Menlo',
  },
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

  // ---- Chat bubbles (user / assistant)
  bubbleRow: { paddingVertical: 4 },
  bubbleRowLeft: { alignItems: 'flex-start' },
  bubbleRowRight: { alignItems: 'flex-end' },
  bubble: {
    maxWidth: '88%',
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.card,
    gap: spacing.sm,
  },
  bubbleAssistant: {
    backgroundColor: colors.fg5,
    borderWidth: 1,
    borderColor: colors.fg7,
    borderTopLeftRadius: 4,
  },
  bubbleUser: {
    backgroundColor: 'rgba(0,150,255,0.18)',
    borderWidth: 1,
    borderColor: colors.planBorderTop,
    borderTopRightRadius: 4,
  },
  bubbleText: {
    color: colors.fg82,
    fontSize: fontSize.body,
    lineHeight: fontSize.body + 7,
  },
  bubbleTextUser: { color: colors.fg },

  // ---- Code blocks (inside bubbles)
  codeBlock: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.fg10,
    gap: 4,
  },
  codeBlockLang: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: 'Menlo',
  },
  codeBlockText: {
    color: colors.fg,
    fontSize: fontSize.footnote + 1,
    fontFamily: 'Menlo',
    lineHeight: fontSize.footnote + 7,
  },

  // ---- Command-execution cards (tool role)
  cmdCard: {
    backgroundColor: colors.fg5,
    borderRadius: radius.card,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.fg10,
    gap: spacing.sm,
    marginVertical: 4,
  },
  cmdHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cmdHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  cmdHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cmdHeaderLabel: {
    color: colors.fg50,
    fontSize: fontSize.caption,
    fontWeight: weight.medium,
  },
  cmdMetaText: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    fontFamily: 'Menlo',
  },
  cmdStatusPill: {
    fontSize: fontSize.caption2,
    fontWeight: weight.semibold,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  cmdCommand: {
    color: colors.fg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote + 1,
    paddingVertical: 2,
  },
  cmdOutputWrap: {
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    padding: spacing.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fg10,
    gap: spacing.sm,
  },
  cmdOutputText: {
    color: colors.fg82,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote,
    lineHeight: fontSize.footnote + 6,
  },
  cmdExpand: {
    color: colors.plan,
    fontSize: fontSize.caption,
    fontWeight: weight.medium,
  },

  // ---- System / reasoning rows
  systemRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    gap: 4,
    opacity: 0.7,
  },
  systemRowLabel: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontFamily: 'Menlo',
  },
  systemRowText: {
    color: colors.fg70,
    fontSize: fontSize.caption,
    fontStyle: 'italic',
    lineHeight: 16,
  },
});
