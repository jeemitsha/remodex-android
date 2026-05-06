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

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import Markdown from 'react-native-markdown-display';

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
import {
  applyGroupLimit,
  relativeTime,
  splitProjectsAndChats,
  statusColor,
} from '@/lib/sidebar';
import { pendingPairing } from '@/lib/state/pendingPairing';
import {
  clearSavedPairing,
  loadSavedPairing,
  saveSavedPairing,
} from '@/lib/state/savedPairing';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

// Thread/turn types and parsers live in lib/protocol/extract.ts so they can be
// fixture-tested. Keep the imports here narrow.
import { extractThreads, extractTurnMeta, extractTurns, ThreadRow, TurnMeta, TurnRow } from '@/lib/protocol/extract';
import { formatDuration } from '@/lib/format';
import { IntermediateBlock, TurnDisplay, buildTurnDisplays } from '@/lib/turn-display';
import {
  ComposerAttachment,
  INITIAL_COMPOSER_STATE,
  isComposerSendable,
  remainingAttachmentSlots,
} from '@/lib/composer-state';
import {
  ModelOption,
  RuntimeSelection,
  ServiceTier,
  compactRuntimeLabel,
  effectiveReasoningEffort,
  extractModels,
  featuredModelOptions,
  hasNonFeaturedModels,
  normalizeServiceTier,
  reasoningTitle,
  selectedModelOption,
} from '@/lib/protocol/runtime';
import {
  ContextWindowUsage,
  compactUsageLabel,
  extractContextWindowUsage,
  fractionUsed,
} from '@/lib/protocol/contextWindow';
import {
  buildTurnInput,
  encodeAttachmentToDataURL,
  shouldRetryWithImageURLKey,
} from '@/lib/protocol/attachments';
import {
  VOICE_LIMITS,
  VoiceAuthExpired,
  postTranscribe,
  preflightVoiceClip,
} from '@/lib/protocol/voice';

// How many threads each project section shows by default in the sidebar drawer.
// Tap "Show all (N)" on a section to reveal the rest. Mirrors the leaner
// Linear/Slack-style sidebar UX rather than iOS Codex's flat dump.
const SIDEBAR_THREADS_PER_GROUP = 5;

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
      turnMeta: TurnMeta[];
      rawTurns: unknown;
      composer: string;
      attachments: ComposerAttachment[];
      planArmed: boolean;
      selection: RuntimeSelection;
      contextUsage: ContextWindowUsage | null;
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Models are loaded once after `initialize` and stay valid for the whole
  // session. Kept in component state (not a ref) so the model-pill label
  // re-renders when the bridge response lands.
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
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

      // 1.5) model/list — fire-and-forget so a slow / unsupported model/list
      // never blocks the session list from rendering. iOS uses an 8s timeout;
      // we let sendRequest's default (30s) apply but don't await it here.
      void (async () => {
        try {
          const modelsResp = await client.sendRequest(
            'model/list',
            { cursor: null, limit: 50, includeHidden: false },
            8_000,
          );
          if (modelsResp.ok && !cancelled) {
            setAvailableModels(extractModels(modelsResp.result));
          }
        } catch {
          // Silent: picker stays in "Default" state.
        }
      })();

      // 2) thread/list — active call (no `archived` param) + parallel
      // archived call. iOS does this exact pair-and-cross-reference because
      // the active list still contains archived threads; we need the
      // archived id set to drop them client-side.
      const [listResp, archivedResp] = await Promise.all([
        client.sendRequest('thread/list', { limit: 50 }),
        client.sendRequest('thread/list', { limit: 100, archived: true }),
      ]);
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

      const allThreads = extractThreads(listResp.result);
      const archivedIds = archivedResp.ok
        ? new Set(extractThreads(archivedResp.result).map((t) => t.id))
        : new Set<string>();
      const threads = allThreads.filter((t) => !archivedIds.has(t.id));
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

    setSidebarOpen(false);
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
        turnMeta: extractTurnMeta(resp.result),
        rawTurns: resp.result,
        composer: INITIAL_COMPOSER_STATE.text,
        attachments: INITIAL_COMPOSER_STATE.attachments,
        planArmed: INITIAL_COMPOSER_STATE.planArmed,
        selection: { modelId: null, reasoningEffort: null, serviceTier: null },
        contextUsage: null,
        activeTurnId: null,
        streamingText: '',
        isSending: false,
      });
      // Fire-and-forget context-window fetch. The pill stays "—" until this
      // resolves; older bridges without thread/contextWindow/read keep "—".
      void refreshContextUsage(thread.id);
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
    const hasAttachments = cur.attachments.length > 0;
    if ((!text && !hasAttachments) || cur.isSending) return;
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
      attachments: [],
      isSending: true,
      streamingText: '',
      activeTurnId: null,
    });

    // Encode each attachment to a base64 data URL up front so the rest of the
    // flow doesn't need to await per-image. expo-file-system.readAsStringAsync
    // is async but cheap for typical phone-camera sized images.
    let encodedAttachments: { dataUrl: string }[] = [];
    if (hasAttachments) {
      try {
        encodedAttachments = await Promise.all(
          cur.attachments.map(async (a) => ({
            dataUrl: await encodeAttachmentToDataURL(a, async (uri) =>
              FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
            ),
          })),
        );
      } catch (err) {
        const errTurn: TurnRow = {
          id: `att-err-${Date.now()}`,
          role: 'system',
          text: `[attachment encode failed] ${(err as Error)?.message ?? err}`,
          raw: err,
        };
        setStatus((prev) =>
          prev.kind === 'thread-ready'
            ? { ...prev, turns: [...prev.turns, errTurn], isSending: false }
            : prev,
        );
        return;
      }
    }

    // Mirrors iOS buildTurnStartRequestParams — top-level model/effort/
    // serviceTier are kept "legacy" alongside collaborationMode but the bridge
    // still honors them, and we don't send collaborationMode yet (plan mode is
    // visible-only until the developer-instructions payload is wired).
    const buildParams = (imageURLKey: 'url' | 'image_url'): Record<string, unknown> => {
      const params: Record<string, unknown> = {
        threadId: cur.thread.id,
        input: buildTurnInput({ text, attachments: encodedAttachments, imageURLKey }),
      };
      const sel = cur.selection;
      const selectedModel = selectedModelOption(availableModels, sel);
      if (selectedModel) params.model = selectedModel.model;
      const effort = effectiveReasoningEffort(selectedModel, sel);
      if (effort) params.effort = effort;
      const tier = normalizeServiceTier(selectedModel, sel.serviceTier);
      if (tier) params.serviceTier = tier;
      return params;
    };

    let resp = await client.sendRequest('turn/start', buildParams('url'));
    // Retry with `image_url` key if the bridge complains about that field
    // (older bridges expect the legacy key — mirrors iOS retry path).
    if (!resp.ok && encodedAttachments.length > 0 && shouldRetryWithImageURLKey(resp.error.message)) {
      resp = await client.sendRequest('turn/start', buildParams('image_url'));
    }

    if (resp.ok) {
      void refreshContextUsage(cur.thread.id);
    }

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

  function setPlanArmed(armed: boolean) {
    setStatus((prev) => (prev.kind === 'thread-ready' ? { ...prev, planArmed: armed } : prev));
  }

  function setSelection(update: (sel: RuntimeSelection) => RuntimeSelection) {
    setStatus((prev) =>
      prev.kind === 'thread-ready' ? { ...prev, selection: update(prev.selection) } : prev,
    );
  }

  async function transcribeVoiceClip(input: {
    uri: string;
    durationSeconds: number;
    byteCount: number;
  }): Promise<string> {
    const client = clientRef.current;
    if (!client) throw new Error('Not connected.');
    const failure = preflightVoiceClip({
      durationSeconds: input.durationSeconds,
      byteCount: input.byteCount,
    });
    if (failure) throw new Error(failure);

    async function resolveAuth(): Promise<string> {
      const resp = await client!.sendRequest('voice/resolveAuth', null);
      if (!resp.ok) {
        throw new Error(resp.error.message || 'voice/resolveAuth failed.');
      }
      const result = resp.result as { token?: unknown } | null;
      const token = result?.token;
      if (typeof token !== 'string' || token.trim().length === 0) {
        throw new Error('voice/resolveAuth did not return a token.');
      }
      return token;
    }

    const audio = { uri: input.uri, name: 'voice.m4a', type: 'audio/m4a' };
    let token = await resolveAuth();
    try {
      return await postTranscribe({ token, audio });
    } catch (err) {
      if (err instanceof VoiceAuthExpired) {
        token = await resolveAuth();
        return await postTranscribe({ token, audio });
      }
      throw err;
    }
  }

  function appendToComposer(text: string) {
    setStatus((prev) =>
      prev.kind === 'thread-ready'
        ? {
            ...prev,
            composer:
              prev.composer.trim().length === 0
                ? text
                : prev.composer.endsWith(' ')
                  ? prev.composer + text
                  : `${prev.composer} ${text}`,
          }
        : prev,
    );
  }

  async function refreshContextUsage(threadId: string) {
    const client = clientRef.current;
    if (!client) return;
    try {
      const resp = await client.sendRequest('thread/contextWindow/read', { threadId });
      if (!resp.ok) return;
      const usage = extractContextWindowUsage(resp.result);
      setStatus((prev) =>
        prev.kind === 'thread-ready' && prev.thread.id === threadId
          ? { ...prev, contextUsage: usage }
          : prev,
      );
    } catch {
      // Older bridges may not expose this method — pill stays "—".
    }
  }

  function removeAttachment(id: string) {
    setStatus((prev) =>
      prev.kind === 'thread-ready'
        ? { ...prev, attachments: prev.attachments.filter((a) => a.id !== id) }
        : prev,
    );
  }

  async function pickImagesFromLibrary() {
    const cur = status;
    if (cur.kind !== 'thread-ready') return;
    const remaining = remainingAttachmentSlots({
      ...INITIAL_COMPOSER_STATE,
      attachments: cur.attachments,
    });
    if (remaining === 0) return;
    const perm = await ImagePicker.getMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      const req = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!req.granted) {
        Alert.alert('Photos access', 'Enable photo library access in Settings to attach images.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 0.85,
    });
    if (result.canceled || !result.assets?.length) return;
    const items: ComposerAttachment[] = result.assets.map((a, i) => ({
      id: `att-${Date.now()}-${i}-${a.assetId ?? a.uri.slice(-12)}`,
      uri: a.uri,
      width: a.width,
      height: a.height,
    }));
    setStatus((prev) =>
      prev.kind === 'thread-ready'
        ? { ...prev, attachments: prev.attachments.concat(items).slice(0, prev.attachments.length + remaining) }
        : prev,
    );
  }

  async function takePhoto() {
    const cur = status;
    if (cur.kind !== 'thread-ready') return;
    const remaining = remainingAttachmentSlots({
      ...INITIAL_COMPOSER_STATE,
      attachments: cur.attachments,
    });
    if (remaining === 0) return;
    const perm = await ImagePicker.getCameraPermissionsAsync();
    if (!perm.granted) {
      const req = await ImagePicker.requestCameraPermissionsAsync();
      if (!req.granted) {
        Alert.alert('Camera access', 'Enable camera access in Settings to take photos.');
        return;
      }
    }
    const result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 0.85 });
    if (result.canceled || !result.assets?.length) return;
    const a = result.assets[0];
    const item: ComposerAttachment = {
      id: `att-${Date.now()}-cam`,
      uri: a.uri,
      width: a.width,
      height: a.height,
    };
    setStatus((prev) =>
      prev.kind === 'thread-ready' ? { ...prev, attachments: prev.attachments.concat(item) } : prev,
    );
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
        <WelcomeView
          session={status.session}
          mode={status.mode}
          threadCount={status.threads.length}
          onOpenSidebar={() => setSidebarOpen(true)}
        />
      )}

      {(status.kind === 'thread-loading' || status.kind === 'thread-ready' || status.kind === 'thread-error') && (
        <View style={{ flex: 1 }}>
          <ThreadHeader thread={status.thread} onMenu={() => setSidebarOpen(true)} />
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
                data={buildTurnDisplays(status.turns, status.turnMeta)}
                keyExtractor={(t, i) => t.id || `turn-${i}`}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.body50}>This thread has no turns yet.</Text>
                  </View>
                }
                ListFooterComponent={
                  status.streamingText ? (
                    <View style={styles.assistantBlock}>
                      <Markdown style={markdownStyles}>
                        {status.streamingText + ' ▍'}
                      </Markdown>
                    </View>
                  ) : null
                }
                renderItem={({ item }) => (
                  <TurnDisplayView
                    turn={item}
                    onApprove={(t) => decideApproval(t, 'accept')}
                    onReject={(t) => decideApproval(t, 'reject')}
                  />
                )}
                contentContainerStyle={styles.turnsPad}
              />
              <Composer
                text={status.composer}
                attachments={status.attachments}
                planArmed={status.planArmed}
                models={availableModels}
                selection={status.selection}
                contextUsage={status.contextUsage}
                isSending={status.isSending}
                onChange={setComposer}
                onSend={sendPrompt}
                onPickImages={pickImagesFromLibrary}
                onTakePhoto={takePhoto}
                onTogglePlan={() => setPlanArmed(!status.planArmed)}
                onRemoveAttachment={removeAttachment}
                onSelectModel={(modelId) =>
                  setSelection((sel) => ({ ...sel, modelId }))
                }
                onSelectReasoningEffort={(effort) =>
                  setSelection((sel) => ({ ...sel, reasoningEffort: effort }))
                }
                onSelectServiceTier={(tier) =>
                  setSelection((sel) => ({ ...sel, serviceTier: tier }))
                }
                onTranscribe={transcribeVoiceClip}
                onTranscribed={appendToComposer}
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
      {/* Sidebar drawer — overlays everything when open. Slides in from the
          left, has a tappable backdrop. Only available once we have a session
          and threads to render. */}
      {(status.kind === 'sessions-ready'
        || status.kind === 'thread-loading'
        || status.kind === 'thread-ready'
        || status.kind === 'thread-error') && (
        <SidebarDrawer
          visible={sidebarOpen}
          threads={status.threads}
          activeThreadId={
            status.kind === 'thread-loading' || status.kind === 'thread-ready' || status.kind === 'thread-error'
              ? status.thread.id
              : null
          }
          onSelect={openThread}
          onClose={() => setSidebarOpen(false)}
          onRescan={rescan}
        />
      )}
    </View>
  );
}

function WelcomeView({
  session,
  mode,
  threadCount,
  onOpenSidebar,
}: {
  session: SecureSession;
  mode: HandshakeMode;
  threadCount: number;
  onOpenSidebar: () => void;
}) {
  return (
    <View style={styles.welcomeRoot}>
      <Pressable onPress={onOpenSidebar} hitSlop={12} style={styles.welcomeHamburger}>
        <Text style={styles.welcomeHamburgerIcon}>☰</Text>
      </Pressable>

      <View style={styles.welcomeCenter}>
        <View style={styles.welcomeIconBubble}>
          <Icon name="checkmark" size={36} color={colors.bg} />
        </View>
        <Text style={styles.welcomeTitle}>
          {mode === 'trusted_reconnect' ? 'Reconnected' : 'Paired'}
        </Text>
        <Text style={styles.welcomeSub}>
          End-to-end encrypted with {fingerprint(session.macIdentityPublicKey)}
        </Text>
        <Text style={styles.welcomeCount}>
          {threadCount} thread{threadCount === 1 ? '' : 's'} ready
        </Text>
        <PrimaryWelcomeBtn label="Open sessions" onPress={onOpenSidebar} />
        <Text style={styles.welcomeHint}>
          Or swipe in from the left
        </Text>
      </View>
    </View>
  );
}

function PrimaryWelcomeBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.welcomePrimaryBtn, pressed && { opacity: 0.85 }]}>
      <Text style={styles.welcomePrimaryBtnText}>{label}</Text>
    </Pressable>
  );
}

type SidebarSection = {
  key: string;
  label: string;
  fullPath: string;
  hiddenCount: number;
  totalCount: number;
  isChats: boolean;
  data: ThreadRow[];
};

// Builds the SectionList sections from the (already archive-filtered) threads:
//   1. groups by cwd → project sections (only when cwd is a real filesystem path)
//   2. moves non-path / cwd-less threads into a "Chats" section pinned at the bottom
//   3. caps each section at SIDEBAR_THREADS_PER_GROUP (with the active thread
//      pinned so it never disappears behind "Show all")
function buildSidebarSections(
  threads: ThreadRow[],
  limit: number,
  expandedKeys: ReadonlySet<string>,
  activeThreadId: string | null,
): SidebarSection[] {
  const { projects, chats } = splitProjectsAndChats(threads);
  const pinned = activeThreadId ? new Set([activeThreadId]) : undefined;

  const projectSections: SidebarSection[] = applyGroupLimit(
    projects,
    limit,
    expandedKeys,
    pinned,
  ).map((g) => ({
    key: g.key,
    label: g.label,
    fullPath: g.fullPath,
    hiddenCount: g.hiddenCount,
    totalCount: g.threads.length,
    isChats: false,
    data: g.visible,
  }));

  if (chats.length === 0) return projectSections;

  // Chats section at the bottom — same limit, also honors the active-thread pin.
  const chatsExpanded = expandedKeys.has('__chats__');
  let chatVisible = chatsExpanded || chats.length <= limit ? chats : chats.slice(0, limit);
  let chatsHidden = chatsExpanded ? 0 : Math.max(0, chats.length - chatVisible.length);
  if (!chatsExpanded && activeThreadId && chats.length > limit) {
    const tail = chats.slice(limit);
    const pinnedFromTail = tail.filter((t) => t.id === activeThreadId);
    if (pinnedFromTail.length > 0) {
      chatVisible = [...chats.slice(0, limit), ...pinnedFromTail];
      chatsHidden = chats.length - chatVisible.length;
    }
  }

  projectSections.push({
    key: '__chats__',
    label: 'Chats',
    fullPath: '',
    hiddenCount: chatsHidden,
    totalCount: chats.length,
    isChats: true,
    data: chatVisible,
  });
  return projectSections;
}

// activeThreadId is also used as a "pinned" id passed into applyGroupLimit so
// the open thread never falls behind "Show all" if it's older than the top-5.
function SidebarDrawer({
  visible,
  threads,
  activeThreadId,
  onSelect,
  onClose,
  onRescan,
}: {
  visible: boolean;
  threads: ThreadRow[];
  activeThreadId: string | null;
  onSelect: (t: ThreadRow) => void;
  onClose: () => void;
  onRescan: () => void;
}) {
  const screenW = Dimensions.get('window').width;
  const drawerWidth = Math.min(360, Math.round(screenW * 0.82));
  const slide = useRef(new Animated.Value(visible ? 0 : -drawerWidth)).current;
  const backdropOpacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: visible ? 0 : -drawerWidth,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: visible ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible, drawerWidth, slide, backdropOpacity]);

  if (!visible && (slide as any)._value === -drawerWidth) {
    // Fully off-screen + backdrop hidden → don't waste rendering. The
    // pointerEvents trick below is enough during animation.
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'auto' : 'box-none'}>
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[styles.drawerBackdrop, { opacity: backdropOpacity }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.drawer,
          { width: drawerWidth, transform: [{ translateX: slide }] },
        ]}>
        <SafeAreaView edges={['top']} style={styles.drawerHeader}>
          <Text style={styles.drawerTitle}>Sessions</Text>
          <Text style={styles.drawerCount}>
            {threads.length}
          </Text>
        </SafeAreaView>
        {threads.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.body50}>
              No threads. Start one in Codex CLI on your Mac.
            </Text>
          </View>
        ) : (
          <SectionList
            sections={buildSidebarSections(
              threads,
              SIDEBAR_THREADS_PER_GROUP,
              expandedGroups,
              activeThreadId,
            )}
            keyExtractor={(t, i) => t.id || `thread-${i}`}
            stickySectionHeadersEnabled={false}
            renderSectionHeader={({ section }) => (
              <View style={section.isChats ? styles.chatsSectionHeader : styles.projectSectionHeader}>
                <Text
                  style={section.isChats ? styles.chatsSectionLabel : styles.projectSectionLabel}
                  numberOfLines={1}>
                  {section.label}
                </Text>
                <Text style={styles.projectSectionCount}>{section.totalCount}</Text>
              </View>
            )}
            renderSectionFooter={({ section }) =>
              section.hiddenCount > 0 || (expandedGroups.has(section.key) && section.totalCount > SIDEBAR_THREADS_PER_GROUP) ? (
                <Pressable
                  onPress={() => toggleGroup(section.key)}
                  style={({ pressed }) => [styles.showMoreRow, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.showMoreText}>
                    {expandedGroups.has(section.key)
                      ? 'Show less'
                      : `Show all (${section.totalCount})`}
                  </Text>
                </Pressable>
              ) : null
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onSelect(item)}
                style={({ pressed }) => [
                  pressed && { opacity: 0.6 },
                  item.id === activeThreadId && styles.threadRowActive,
                ]}>
                <ThreadRowView thread={item} />
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={styles.threadRowSep} />}
            contentContainerStyle={styles.listPad}
          />
        )}
        <View style={styles.drawerFooter}>
          <Pressable onPress={onRescan} style={styles.footerBtn}>
            <Text style={styles.footerBtnText}>Re-pair</Text>
          </Pressable>
        </View>
      </Animated.View>
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

function ThreadHeader({ thread, onMenu }: { thread: ThreadRow; onMenu: () => void }) {
  return (
    <SafeAreaView edges={['top']}>
      <View style={styles.threadHeaderBar}>
        <Pressable onPress={onMenu} hitSlop={12} style={styles.backBtnSmall}>
          <Text style={styles.welcomeHamburgerIcon}>☰</Text>
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
    </SafeAreaView>
  );
}

// Composer card — mirrors iOS TurnComposerView.swift. One rounded card holds:
//   - attachments preview row (only when there's at least one attachment)
//   - multi-line TextInput
//   - bottom bar: [+ menu] [model pill ▾] [Plan pill?] (spacer) [ctx pill] [mic] [send]
//
// The "+" menu is a custom modal sheet (RN's ActionSheetIOS doesn't exist on
// Android). Mic + model picker + ctx pill are visible-but-stubbed: the UI is
// in place so the layout reads right, but the JSON-RPC channels behind them
// (runtime/list-models, context-window-usage events, voice transcription)
// aren't reverse-engineered yet — see Docs/STATE.md "Next chunks".
function Composer({
  text,
  attachments,
  planArmed,
  models,
  selection,
  contextUsage,
  isSending,
  onTranscribe,
  onTranscribed,
  onChange,
  onSend,
  onPickImages,
  onTakePhoto,
  onTogglePlan,
  onRemoveAttachment,
  onSelectModel,
  onSelectReasoningEffort,
  onSelectServiceTier,
}: {
  text: string;
  attachments: ComposerAttachment[];
  planArmed: boolean;
  models: ModelOption[];
  selection: RuntimeSelection;
  contextUsage: ContextWindowUsage | null;
  isSending: boolean;
  onChange: (s: string) => void;
  onSend: () => void;
  onPickImages: () => void;
  onTakePhoto: () => void;
  onTogglePlan: () => void;
  onRemoveAttachment: (id: string) => void;
  onSelectModel: (modelId: string) => void;
  onSelectReasoningEffort: (effort: string) => void;
  onSelectServiceTier: (tier: ServiceTier | null) => void;
  onTranscribe: (input: { uri: string; durationSeconds: number; byteCount: number }) => Promise<string>;
  onTranscribed: (text: string) => void;
}) {
  const [plusOpen, setPlusOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const sendable = isComposerSendable({
    ...INITIAL_COMPOSER_STATE,
    text,
    attachments,
  });
  const sendDisabled = !sendable || isSending;
  const modelLabel = compactRuntimeLabel(models, selection);
  const showsBolt = selection.serviceTier === 'fast';

  return (
    <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}>
      <View style={styles.composerCard}>
        {attachments.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.attachmentsRow}>
            {attachments.map((a) => (
              <View key={a.id} style={styles.attachmentTile}>
                <Image source={{ uri: a.uri }} style={styles.attachmentThumb} />
                <Pressable
                  onPress={() => onRemoveAttachment(a.id)}
                  hitSlop={8}
                  style={styles.attachmentRemove}>
                  <Icon name="xmark" size={10} color={colors.fg} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}

        <TextInput
          style={styles.composerInput}
          value={text}
          onChangeText={onChange}
          placeholder="Send a prompt to Codex…"
          placeholderTextColor={colors.fg40}
          multiline
          editable={!isSending}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <View style={styles.composerBar}>
          <Pressable
            onPress={() => setPlusOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            <Icon name="plus" size={18} color={colors.fg70} />
          </Pressable>

          <Pressable
            onPress={() => setPickerOpen(true)}
            disabled={models.length === 0}
            style={({ pressed }) => [styles.modelPill, pressed && { opacity: 0.7 }]}>
            {showsBolt ? (
              <Icon name="bolt.fill" size={11} color={colors.fg} />
            ) : null}
            <Text style={styles.modelPillText} numberOfLines={1}>
              {modelLabel}
            </Text>
            <Icon name="chevron.down" size={10} color={colors.fg45} />
          </Pressable>

          {planArmed ? (
            <View style={styles.planPill}>
              <Icon name="checklist" size={11} color={colors.plan} />
              <Text style={styles.planPillText}>Plan</Text>
            </View>
          ) : null}

          <View style={{ flex: 1 }} />

          <ContextWindowPill usage={contextUsage} />

          <Pressable
            onPress={() => setRecorderOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            <Icon name="mic" size={18} color={colors.fg70} />
          </Pressable>

          <Pressable
            onPress={onSend}
            disabled={sendDisabled}
            style={({ pressed }) => [
              styles.sendBtn,
              sendDisabled && styles.sendBtnDisabled,
              pressed && !sendDisabled && { opacity: 0.85 },
            ]}>
            {isSending ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : (
              <Icon name="arrow.up" size={16} color={sendDisabled ? colors.fg45 : colors.bg} />
            )}
          </Pressable>
        </View>
      </View>

      <PlusMenu
        visible={plusOpen}
        planArmed={planArmed}
        onClose={() => setPlusOpen(false)}
        onTogglePlan={() => {
          onTogglePlan();
          setPlusOpen(false);
        }}
        onPickImages={() => {
          setPlusOpen(false);
          onPickImages();
        }}
        onTakePhoto={() => {
          setPlusOpen(false);
          onTakePhoto();
        }}
      />

      <ModelPickerSheet
        visible={pickerOpen}
        models={models}
        selection={selection}
        onClose={() => setPickerOpen(false)}
        onSelectModel={onSelectModel}
        onSelectReasoningEffort={onSelectReasoningEffort}
        onSelectServiceTier={onSelectServiceTier}
      />

      <VoiceRecorderModal
        visible={recorderOpen}
        onClose={() => setRecorderOpen(false)}
        onTranscribe={onTranscribe}
        onTranscribed={(text) => {
          onTranscribed(text);
          setRecorderOpen(false);
        }}
      />
    </View>
  );
}

// Bottom-sheet menu mirroring the SwiftUI Menu attached to the iOS "+" button.
// Plain Modal + tap-outside-to-dismiss; no native action sheet because Android
// doesn't surface one identical to iOS.
function PlusMenu({
  visible,
  planArmed,
  onClose,
  onTogglePlan,
  onPickImages,
  onTakePhoto,
}: {
  visible: boolean;
  planArmed: boolean;
  onClose: () => void;
  onTogglePlan: () => void;
  onPickImages: () => void;
  onTakePhoto: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.plusMenuBackdrop} onPress={onClose}>
        <Pressable style={styles.plusMenu} onPress={(e) => e.stopPropagation()}>
          <PlusMenuRow
            icon="checklist"
            label={planArmed ? 'Plan mode (on)' : 'Plan mode'}
            tint={planArmed ? colors.plan : colors.fg}
            onPress={onTogglePlan}
          />
          <View style={styles.plusMenuDivider} />
          <PlusMenuRow icon="photo" label="Photo library" onPress={onPickImages} />
          <PlusMenuRow icon="camera" label="Take a photo" onPress={onTakePhoto} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Hierarchical runtime menu mirroring iOS ComposerRuntimeMenuControl. iOS uses
// a SwiftUI Menu with three sections (Effort / Change model / Speed) — on
// Android we reproduce the hierarchy in a single Modal that swaps "levels":
// root shows reasoning options inline and pushes Model / Speed sub-levels.
function ModelPickerSheet({
  visible,
  models,
  selection,
  onClose,
  onSelectModel,
  onSelectReasoningEffort,
  onSelectServiceTier,
}: {
  visible: boolean;
  models: ModelOption[];
  selection: RuntimeSelection;
  onClose: () => void;
  onSelectModel: (modelId: string) => void;
  onSelectReasoningEffort: (effort: string) => void;
  onSelectServiceTier: (tier: ServiceTier | null) => void;
}) {
  const [level, setLevel] = useState<'root' | 'model' | 'speed' | 'all-models'>('root');
  // Reset to root every time the sheet reopens so it doesn't remember a stale
  // submenu the user pushed last time.
  useEffect(() => {
    if (visible) setLevel('root');
  }, [visible]);

  const selectedModel = selectedModelOption(models, selection);
  const featured = featuredModelOptions(models, selection.modelId);
  const hasMore = hasNonFeaturedModels(models, selection.modelId);
  const supportsFast = selectedModel?.supportsFastMode ?? false;
  const reasoningOptions = selectedModel?.supportedReasoningEfforts ?? [];
  const activeEffort = effectiveReasoningEffort(selectedModel, selection);

  const title =
    level === 'model' ? 'Model'
    : level === 'speed' ? 'Speed'
    : level === 'all-models' ? 'Other models'
    : 'Intelligence';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.plusMenuBackdrop} onPress={onClose}>
        <Pressable style={styles.modelSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modelSheetHeader}>
            {level !== 'root' ? (
              <Pressable onPress={() => setLevel('root')} hitSlop={10} style={styles.modelSheetBack}>
                <Icon name="chevron.left" size={14} color={colors.fg70} />
              </Pressable>
            ) : (
              <View style={{ width: 22 }} />
            )}
            <Text style={styles.modelSheetTitle}>{title}</Text>
            <View style={{ width: 22 }} />
          </View>

          {level === 'root' ? (
            <>
              {reasoningOptions.length > 0 ? (
                reasoningOptions.map((opt) => (
                  <ModelSheetRow
                    key={opt.reasoningEffort}
                    label={reasoningTitle(opt.reasoningEffort)}
                    detail={opt.description}
                    selected={activeEffort === opt.reasoningEffort}
                    onPress={() => {
                      onSelectReasoningEffort(opt.reasoningEffort);
                    }}
                  />
                ))
              ) : (
                <Text style={styles.modelSheetEmpty}>
                  {models.length === 0 ? 'Loading models…' : 'No reasoning options.'}
                </Text>
              )}

              <View style={styles.modelSheetDivider} />

              <ModelSheetRow
                label={selectedModel ? selectedModel.displayName : 'Model'}
                trailingChevron
                onPress={() => setLevel('model')}
              />
              {supportsFast ? (
                <ModelSheetRow
                  label="Speed"
                  trailingChevron
                  onPress={() => setLevel('speed')}
                />
              ) : null}
            </>
          ) : null}

          {level === 'model' ? (
            <>
              {featured.map((m) => (
                <ModelSheetRow
                  key={m.id}
                  leadingIcon={m.supportsFastMode ? 'bolt.fill' : undefined}
                  label={m.displayName}
                  detail={m.description}
                  selected={selectedModel?.id === m.id}
                  onPress={() => {
                    onSelectModel(m.id);
                    setLevel('root');
                  }}
                />
              ))}
              {hasMore ? (
                <ModelSheetRow
                  label="Other models"
                  trailingChevron
                  onPress={() => setLevel('all-models')}
                />
              ) : null}
            </>
          ) : null}

          {level === 'all-models' ? (
            <ScrollView style={{ maxHeight: 360 }}>
              {models.map((m) => (
                <ModelSheetRow
                  key={m.id}
                  leadingIcon={m.supportsFastMode ? 'bolt.fill' : undefined}
                  label={m.displayName}
                  detail={m.description}
                  selected={selectedModel?.id === m.id}
                  onPress={() => {
                    onSelectModel(m.id);
                    setLevel('root');
                  }}
                />
              ))}
            </ScrollView>
          ) : null}

          {level === 'speed' ? (
            <>
              <ModelSheetRow
                label="Standard"
                detail="Default speed, normal usage"
                selected={selection.serviceTier === null}
                onPress={() => {
                  onSelectServiceTier(null);
                  setLevel('root');
                }}
              />
              <ModelSheetRow
                leadingIcon="bolt.fill"
                label="Fast"
                detail="1.5× speed, increased usage"
                selected={selection.serviceTier === 'fast'}
                onPress={() => {
                  onSelectServiceTier('fast');
                  setLevel('root');
                }}
              />
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Compact context-window pill = a small progress ring, no text. Tap to open
// the detail modal with raw token counts. Mirrors iOS ContextWindowProgressRing.
function ContextWindowPill({ usage }: { usage: ContextWindowUsage | null }) {
  const [open, setOpen] = useState(false);
  const fraction = usage ? fractionUsed(usage) : 0;
  const ringColor =
    fraction > 0.9 ? '#ff8b8b'
    : fraction > 0.7 ? '#ff9f0a'
    : '#9be39a';

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={!usage}
        hitSlop={6}
        style={({ pressed }) => [styles.ctxRingWrap, pressed && { opacity: 0.7 }]}>
        <ProgressRing size={18} strokeWidth={2.5} fraction={fraction} color={ringColor} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.plusMenuBackdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.modelSheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.modelSheetHeader}>
              <View style={{ width: 22 }} />
              <Text style={styles.modelSheetTitle}>Context window</Text>
              <View style={{ width: 22 }} />
            </View>
            {usage ? (
              <View style={{ padding: spacing.lg, gap: spacing.md, alignItems: 'center' }}>
                <ProgressRing size={72} strokeWidth={6} fraction={fraction} color={ringColor} />
                <Text style={styles.ctxPanelBig}>
                  {Math.round(fraction * 100)}% used
                </Text>
                <Text style={styles.ctxPanelDetail}>
                  {usage.tokensUsed.toLocaleString()} / {usage.tokenLimit.toLocaleString()} tokens
                </Text>
              </View>
            ) : (
              <Text style={styles.modelSheetEmpty}>
                The bridge hasn’t reported context usage for this thread yet.
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

// SVG-based progress arc. Renders a faint background circle + a colored arc
// from 12 o'clock clockwise. fraction in [0..1].
function ProgressRing({
  size,
  strokeWidth,
  fraction,
  color,
}: {
  size: number;
  strokeWidth: number;
  fraction: number;
  color: string;
}) {
  const safe = Math.max(0, Math.min(1, fraction));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - safe);
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={colors.fg10}
        strokeWidth={strokeWidth}
        fill="none"
      />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke={color}
        strokeWidth={strokeWidth}
        fill="none"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  );
}

// Voice recording modal. Wraps expo-audio's useAudioRecorder. Tap mic →
// permission check → live timer + pulsing dot → tap stop → upload + transcribe
// → onTranscribed(text). Cancel discards. Mirrors iOS VoiceRecordingCapsule
// minus the audio-level waveform — Android's recorder doesn't expose levels
// uniformly enough across devices to reproduce that polish today.
function VoiceRecorderModal({
  visible,
  onClose,
  onTranscribe,
  onTranscribed,
}: {
  visible: boolean;
  onClose: () => void;
  onTranscribe: (input: { uri: string; durationSeconds: number; byteCount: number }) => Promise<string>;
  onTranscribed: (text: string) => void;
}) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [phase, setPhase] = useState<'idle' | 'recording' | 'transcribing' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);

  // Auto-start recording the moment the modal becomes visible. On dismiss we
  // ensure the recorder is stopped so the file handle doesn't linger.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      setErrorMsg(null);
      try {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          if (cancelled) return;
          setErrorMsg('Microphone permission denied.');
          setPhase('error');
          return;
        }
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        if (cancelled) return;
        startedAtRef.current = Date.now();
        setPhase('recording');
      } catch (err) {
        if (cancelled) return;
        setErrorMsg((err as Error)?.message ?? 'Failed to start recording.');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      // Stop the recorder if the modal closes mid-record without an explicit stop.
      if (recorder.isRecording) recorder.stop().catch(() => {});
    };
  }, [visible]);

  const elapsedMs = phase === 'recording' && recorderState.durationMillis !== undefined
    ? recorderState.durationMillis
    : phase === 'recording'
      ? Date.now() - startedAtRef.current
      : 0;
  const elapsedLabel = formatDuration(elapsedMs);

  async function handleStop() {
    try {
      setPhase('transcribing');
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error('Recording produced no file.');
      const info = await FileSystem.getInfoAsync(uri);
      const byteCount = info.exists && info.size ? info.size : 0;
      const durationSeconds = (recorderState.durationMillis ?? Date.now() - startedAtRef.current) / 1000;
      const text = await onTranscribe({ uri, durationSeconds, byteCount });
      onTranscribed(text);
    } catch (err) {
      setErrorMsg((err as Error)?.message ?? 'Transcription failed.');
      setPhase('error');
    }
  }

  function handleCancel() {
    if (recorder.isRecording) recorder.stop().catch(() => {});
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleCancel}>
      <Pressable style={styles.plusMenuBackdrop} onPress={handleCancel}>
        <Pressable style={styles.modelSheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.modelSheetHeader}>
            <View style={{ width: 22 }} />
            <Text style={styles.modelSheetTitle}>
              {phase === 'transcribing' ? 'Transcribing…' : 'Recording'}
            </Text>
            <View style={{ width: 22 }} />
          </View>
          <View style={{ padding: spacing.lg, gap: spacing.md, alignItems: 'center' }}>
            {phase === 'recording' ? (
              <>
                <View style={styles.voiceDot} />
                <Text style={styles.voiceTimer}>{elapsedLabel || '0s'}</Text>
                <Text style={styles.voiceHint}>
                  Up to {VOICE_LIMITS.maxDurationSeconds}s — tap Stop to transcribe.
                </Text>
                <View style={{ flexDirection: 'row', gap: spacing.md }}>
                  <Pressable onPress={handleCancel} style={styles.voiceSecondaryBtn}>
                    <Text style={styles.voiceSecondaryBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable onPress={handleStop} style={styles.voicePrimaryBtn}>
                    <Text style={styles.voicePrimaryBtnText}>Stop</Text>
                  </Pressable>
                </View>
              </>
            ) : phase === 'transcribing' ? (
              <>
                <ActivityIndicator color={colors.plan} />
                <Text style={styles.voiceHint}>Sending audio to ChatGPT…</Text>
              </>
            ) : phase === 'error' ? (
              <>
                <Text style={[styles.voiceHint, { color: '#ff8b8b' }]}>{errorMsg}</Text>
                <Pressable onPress={onClose} style={styles.voicePrimaryBtn}>
                  <Text style={styles.voicePrimaryBtnText}>Close</Text>
                </Pressable>
              </>
            ) : (
              <ActivityIndicator color={colors.plan} />
            )}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ModelSheetRow({
  label,
  detail,
  leadingIcon,
  trailingChevron,
  selected,
  onPress,
}: {
  label: string;
  detail?: string;
  leadingIcon?: string;
  trailingChevron?: boolean;
  selected?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.modelSheetRow, pressed && { backgroundColor: colors.fg10 }]}>
      {leadingIcon ? (
        <Icon name={leadingIcon} size={13} color={colors.fg} />
      ) : (
        <View style={{ width: 13 }} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.modelSheetRowLabel}>{label}</Text>
        {detail ? <Text style={styles.modelSheetRowDetail}>{detail}</Text> : null}
      </View>
      {selected ? (
        <Icon name="checkmark" size={14} color={colors.fg} />
      ) : trailingChevron ? (
        <Text style={styles.modelSheetChevron}>›</Text>
      ) : (
        <View style={{ width: 14 }} />
      )}
    </Pressable>
  );
}

function PlusMenuRow({
  icon,
  label,
  tint,
  onPress,
}: {
  icon: string;
  label: string;
  tint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.plusMenuRow, pressed && { backgroundColor: colors.fg10 }]}>
      <Icon name={icon} size={18} color={tint ?? colors.fg} />
      <Text style={[styles.plusMenuLabel, tint ? { color: tint } : null]}>{label}</Text>
    </Pressable>
  );
}

function TurnDisplayView({
  turn,
  onApprove,
  onReject,
}: {
  turn: TurnDisplay;
  onApprove: (turn: TurnRow) => void;
  onReject: (turn: TurnRow) => void;
}) {
  const primaryUser = turn.userPrompts[0] ?? null;
  return (
    <View style={styles.turnBlock}>
      {primaryUser ? <MessageBubble turn={primaryUser} side="right" /> : null}
      {turn.intermediate.length > 0 ? (
        <WorkedForCard turn={turn} onApprove={onApprove} onReject={onReject} />
      ) : null}
      {turn.finalAnswer ? <MessageBubble turn={turn.finalAnswer} side="left" /> : null}
    </View>
  );
}

function WorkedForCard({
  turn,
  onApprove,
  onReject,
}: {
  turn: TurnDisplay;
  onApprove: (turn: TurnRow) => void;
  onReject: (turn: TurnRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = turn.totalDurationMs > 0
    ? `Worked for ${formatDuration(turn.totalDurationMs)}`
    : `Working…`;
  return (
    <View style={styles.workedFor}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.workedForHeader, pressed && { opacity: 0.7 }]}>
        <Text style={styles.workedForLabel}>{label}</Text>
        <Text style={styles.workedForChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.workedForBody}>
          {turn.intermediate.map((b, i) => (
            <IntermediateBlockView
              key={`${turn.id}-i-${i}`}
              block={b}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function IntermediateBlockView({
  block,
  onApprove,
  onReject,
}: {
  block: IntermediateBlock;
  onApprove: (turn: TurnRow) => void;
  onReject: (turn: TurnRow) => void;
}) {
  switch (block.kind) {
    case 'narration':
      return (
        <View style={styles.narration}>
          <Markdown style={markdownStyles}>{block.row.text || ''}</Markdown>
        </View>
      );
    case 'user-steered':
      return (
        <View style={styles.steeredRow}>
          <Text style={styles.steeredLabel}>Steered conversation</Text>
          <View style={styles.bubble_user}>
            <Text style={styles.bubble_userText}>{block.row.text}</Text>
          </View>
        </View>
      );
    case 'commands-batch':
      return <CommandsBatch rows={block.rows} totalDurationMs={block.durationMs} />;
    case 'tool-call':
      return <ToolCallPill turn={block.row} />;
    case 'system':
      if (block.row.role === 'approval') {
        return <ApprovalCard turn={block.row} onApprove={onApprove} onReject={onReject} />;
      }
      return null;
  }
}

function CommandsBatch({ rows, totalDurationMs }: { rows: TurnRow[]; totalDurationMs: number }) {
  const [expanded, setExpanded] = useState(false);
  const label = rows.length === 1
    ? rows[0].command || '(command)'
    : `Ran ${rows.length} commands`;
  return (
    <View style={styles.batchWrap}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.batchHeader, pressed && { opacity: 0.7 }]}>
        <Icon name="terminal" size={11} color={colors.fg45} />
        <Text style={styles.batchLabel} numberOfLines={1} ellipsizeMode="tail">
          {label}
        </Text>
        <Text style={styles.batchChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.batchChildren}>
          {rows.map((r) => (
            <ToolGroupChild key={r.id} turn={r} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolCallPill({ turn }: { turn: TurnRow }) {
  const [expanded, setExpanded] = useState(false);
  const label = turn.toolServer
    ? `Used ${prettyServer(turn.toolServer)}`
    : turn.command || '(tool)';
  return (
    <View style={styles.pillWrap}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.pillHeader, pressed && { opacity: 0.7 }]}>
        <Icon name="link" size={10} color={colors.fg45} />
        <Text style={styles.pillLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.batchChevron}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.pillBody}>
          {turn.toolName ? (
            <Text style={styles.pillSubLabel}>{turn.toolName}</Text>
          ) : null}
          {turn.output ? <CommandOutput text={turn.output} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function prettyServer(server: string): string {
  // codex_apps → Codex Apps; gmail → Gmail; etc.
  return server
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function MessageBubble({ turn, side }: { turn: TurnRow; side: 'left' | 'right' }) {
  // iOS-Codex style: only user prompts are bubble'd (right-aligned dark
  // rectangle with uniform rounded corners). Assistant responses render
  // edge-to-edge on the bg with full markdown — bubbles would constrain text
  // width and break the airy reading layout the user wants.
  if (side === 'right') {
    return (
      <View style={styles.bubbleRow_right}>
        <View style={styles.bubble_user}>
          <Text style={styles.bubble_userText}>{turn.text}</Text>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.assistantBlock}>
      <Markdown style={markdownStyles}>{turn.text}</Markdown>
    </View>
  );
}

function ToolGroupChild({ turn }: { turn: TurnRow }) {
  const [expanded, setExpanded] = useState(false);
  const exitOk = turn.exitCode === undefined ? null : turn.exitCode === 0;
  return (
    <View style={styles.toolChild}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={({ pressed }) => [styles.toolChildHeader, pressed && { opacity: 0.7 }]}>
        <Text style={styles.toolGroupChevron}>{expanded ? '▾' : '▸'}</Text>
        <Text style={styles.toolChildCommand} numberOfLines={1} ellipsizeMode="middle">
          {turn.command || '(tool)'}
        </Text>
        <Text
          style={[
            styles.toolChildStatus,
            exitOk === false ? { color: '#ff8b8b' } : { color: colors.fg45 },
          ]}>
          {exitOk === true
            ? '✓'
            : exitOk === false
              ? `✕${turn.exitCode}`
              : turn.toolStatus || ''}
        </Text>
        {turn.durationMs ? (
          <Text style={styles.toolChildDuration}>{formatDuration(turn.durationMs)}</Text>
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.toolChildBody}>
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
      ) : null}
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

// formatDuration moved to lib/format.ts (fixture-tested) so the production
// function is the same one tests exercise.

// Markdown styles for assistant bubbles — matches our dark theme tokens.
// react-native-markdown-display takes a flat object keyed by markdown rule
// names; we override the ones that show up the most in chat content.
const markdownStyles = StyleSheet.create({
  body: { color: colors.fg82, fontSize: fontSize.body, lineHeight: fontSize.body + 7 },
  heading1: { color: colors.fg, fontSize: fontSize.title2, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  heading2: { color: colors.fg, fontSize: fontSize.title3, fontWeight: '700', marginTop: 8, marginBottom: 4 },
  heading3: { color: colors.fg, fontSize: fontSize.headline, fontWeight: '600', marginTop: 6, marginBottom: 2 },
  heading4: { color: colors.fg, fontSize: fontSize.body, fontWeight: '600', marginTop: 6, marginBottom: 2 },
  strong: { color: colors.fg, fontWeight: '700' },
  em: { fontStyle: 'italic' },
  link: { color: colors.plan, textDecorationLine: 'underline' },
  // Minimal indentation — iOS-Codex style. Default react-native-markdown-display
  // sets icon margins to 10/10 (20pt total), pushing text far right. We pull it
  // way in: 0/6, plus zero list margin, so bullets sit just inside the bubble.
  bullet_list: { marginVertical: 4, marginLeft: 0 },
  ordered_list: { marginVertical: 4, marginLeft: 0 },
  list_item: { marginVertical: 2, flexDirection: 'row' },
  bullet_list_icon: { color: colors.fg45, marginLeft: 0, marginRight: 6, lineHeight: fontSize.body + 7 },
  ordered_list_icon: { color: colors.fg45, marginLeft: 0, marginRight: 6, lineHeight: fontSize.body + 7 },
  bullet_list_content: { flex: 1 },
  ordered_list_content: { flex: 1 },
  code_inline: {
    color: colors.fg,
    backgroundColor: colors.bg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote + 1,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 4,
  },
  fence: {
    backgroundColor: colors.bg,
    color: colors.fg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.fg10,
    marginVertical: 6,
  },
  code_block: {
    backgroundColor: colors.bg,
    color: colors.fg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote,
    padding: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.fg10,
    marginVertical: 6,
  },
  blockquote: {
    backgroundColor: colors.fg5,
    borderLeftColor: colors.plan,
    borderLeftWidth: 3,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    marginVertical: 4,
  },
  hr: { backgroundColor: colors.fg10, height: 1, marginVertical: spacing.sm },
  table: { borderColor: colors.fg10, borderWidth: 1, borderRadius: radius.sm, marginVertical: 6 },
  thead: { backgroundColor: colors.fg5 },
  th: { color: colors.fg, fontWeight: '600', padding: 6 },
  td: { color: colors.fg82, padding: 6 },
});

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
  // The "Chats" section header is set apart with a top divider so it visually
  // separates the bottom-pinned chats list from the project groups above.
  chatsSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.lg + 4,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.fg10,
    marginTop: spacing.md,
  },
  chatsSectionLabel: {
    color: colors.fg45,
    fontSize: fontSize.footnote,
    fontWeight: weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 1,
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
  threadRowActive: {
    backgroundColor: colors.fg6,
    borderRadius: radius.md,
  },
  threadRowSep: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.fg10,
    marginLeft: 24, // align with title (skip the dot slot)
  },
  showMoreRow: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginLeft: 24,
  },
  showMoreText: {
    color: colors.plan,
    fontSize: fontSize.footnote,
    fontWeight: weight.regular,
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
  composerWrap: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    backgroundColor: colors.bg,
  },
  composerCard: {
    backgroundColor: colors.fg6,
    borderWidth: 1,
    borderColor: colors.fg10,
    borderRadius: 26, // matches iOS RoundedRectangle(cornerRadius: 26)
    overflow: 'hidden',
  },
  attachmentsRow: {
    paddingTop: 10,
    paddingHorizontal: 12,
    gap: 8,
    flexDirection: 'row',
  },
  attachmentTile: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: colors.fg10,
    overflow: 'visible',
    position: 'relative',
  },
  attachmentThumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
  },
  attachmentRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.bg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.fg40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    minHeight: 36,
    maxHeight: 160,
    color: colors.fg,
    fontSize: fontSize.body,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  composerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 8,
  },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modelPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
    paddingVertical: 6,
    maxWidth: 180,
  },
  modelPillText: {
    color: colors.fg70,
    fontSize: fontSize.subheadline,
    fontWeight: weight.regular,
  },
  planPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 4,
    paddingVertical: 6,
  },
  planPillText: {
    color: colors.plan,
    fontSize: fontSize.subheadline,
  },
  ctxRingWrap: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctxPanelBig: {
    color: colors.fg,
    fontSize: fontSize.title3,
    fontWeight: weight.semibold,
  },
  ctxPanelDetail: {
    color: colors.fg70,
    fontSize: fontSize.body,
    fontFamily: 'Menlo',
  },
  sendBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.fg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: colors.fg10,
  },
  plusMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  plusMenu: {
    backgroundColor: colors.bg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.fg10,
    overflow: 'hidden',
  },
  plusMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
  },
  plusMenuLabel: {
    color: colors.fg,
    fontSize: fontSize.body,
  },
  plusMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.fg10,
    marginHorizontal: spacing.lg,
  },
  modelSheet: {
    backgroundColor: colors.bg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.fg10,
    overflow: 'hidden',
  },
  modelSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.fg10,
  },
  modelSheetBack: {
    width: 22,
    height: 22,
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  modelSheetTitle: {
    flex: 1,
    color: colors.fg45,
    fontSize: fontSize.footnote,
    textTransform: 'uppercase',
    letterSpacing: 1,
    textAlign: 'center',
    fontWeight: weight.semibold,
  },
  modelSheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  modelSheetRowLabel: {
    color: colors.fg,
    fontSize: fontSize.body,
  },
  modelSheetRowDetail: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    marginTop: 2,
  },
  modelSheetChevron: {
    color: colors.fg45,
    fontSize: 18,
    width: 14,
    textAlign: 'right',
  },
  modelSheetDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.fg10,
    marginHorizontal: spacing.lg,
  },
  modelSheetEmpty: {
    color: colors.fg45,
    fontSize: fontSize.body,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
  },
  voiceDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ff5b5b',
  },
  voiceTimer: {
    color: colors.fg,
    fontSize: fontSize.title3,
    fontWeight: weight.semibold,
    fontFamily: 'Menlo',
  },
  voiceHint: {
    color: colors.fg45,
    fontSize: fontSize.subheadline,
    textAlign: 'center',
  },
  voicePrimaryBtn: {
    backgroundColor: colors.fg,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.capsule,
  },
  voicePrimaryBtnText: {
    color: colors.bg,
    fontSize: fontSize.body,
    fontWeight: weight.semibold,
  },
  voiceSecondaryBtn: {
    backgroundColor: colors.fg10,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.capsule,
  },
  voiceSecondaryBtnText: {
    color: colors.fg,
    fontSize: fontSize.body,
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

  // ---- Bubbles (user only) and assistant block (full-width plain)
  bubbleRow_right: { alignItems: 'flex-end', paddingVertical: 4 },
  bubble_user: {
    maxWidth: '85%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.card,
    backgroundColor: colors.fg10,
  },
  bubble_userText: {
    color: colors.fg,
    fontSize: fontSize.body,
    lineHeight: fontSize.body + 7,
  },
  assistantBlock: {
    paddingVertical: spacing.sm,
    paddingHorizontal: 0,
  },

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

  // ---- Welcome view (shown when paired but no thread selected)
  welcomeRoot: { flex: 1 },
  welcomeHamburger: {
    position: 'absolute',
    top: 56,
    left: spacing.xl,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.fg10,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  welcomeHamburgerIcon: {
    color: colors.fg,
    fontSize: 22,
    lineHeight: 24,
  },
  welcomeCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xxxl,
    gap: spacing.lg,
  },
  welcomeIconBubble: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#9be39a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  welcomeTitle: {
    color: colors.fg,
    fontSize: fontSize.pageHero,
    fontWeight: weight.bold,
  },
  welcomeSub: {
    color: colors.fg50,
    fontSize: fontSize.subheadline,
    fontFamily: 'Menlo',
    textAlign: 'center',
  },
  welcomeCount: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    marginTop: -spacing.sm,
  },
  welcomePrimaryBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl + 4,
    paddingVertical: 14,
    borderRadius: radius.capsule,
    backgroundColor: colors.fg,
  },
  welcomePrimaryBtnText: {
    color: colors.bg,
    fontSize: fontSize.body,
    fontWeight: weight.semibold,
  },
  welcomeHint: { color: colors.fg45, fontSize: fontSize.caption },

  // ---- Drawer (sidebar overlay)
  drawerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  drawer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.bg,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.fg10,
  },
  drawerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.fg10,
  },
  drawerTitle: {
    color: colors.fg,
    fontSize: fontSize.title3,
    fontWeight: weight.bold,
  },
  drawerCount: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    fontFamily: 'Menlo',
  },
  drawerFooter: {
    padding: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.fg10,
  },

  // ---- Per-turn block (one user prompt + worked-for + final answer)
  turnBlock: {
    paddingBottom: spacing.lg,
    gap: spacing.sm,
  },
  // ---- "Worked for Xs" expandable
  workedFor: {
    marginVertical: spacing.xs,
  },
  workedForHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
  },
  workedForLabel: {
    color: colors.fg70,
    fontSize: fontSize.subheadline,
    fontWeight: weight.medium,
  },
  workedForChevron: {
    color: colors.fg45,
    fontSize: 12,
  },
  workedForBody: {
    paddingLeft: 0,
    paddingTop: 4,
    gap: spacing.sm,
  },
  // ---- Narration / steered
  narration: {
    paddingVertical: 4,
  },
  steeredRow: {
    alignItems: 'flex-end',
    gap: 4,
    marginVertical: spacing.sm,
  },
  steeredLabel: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  // ---- Compact command batch (no card border)
  batchWrap: { paddingVertical: 2 },
  batchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  batchLabel: {
    flex: 1,
    color: colors.fg70,
    fontSize: fontSize.subheadline,
    fontFamily: 'Menlo',
  },
  batchChevron: { color: colors.fg45, fontSize: 12 },
  batchChildren: {
    paddingTop: 4,
    paddingLeft: spacing.md,
    gap: 2,
  },
  // ---- "Used Gmail" pill (compact, no card border)
  pillWrap: { paddingVertical: 2 },
  pillHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  pillLabel: {
    flex: 1,
    color: colors.fg70,
    fontSize: fontSize.subheadline,
  },
  pillSubLabel: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    fontFamily: 'Menlo',
  },
  pillBody: {
    paddingLeft: spacing.md,
    paddingTop: 4,
    gap: 4,
  },
  // ---- Legacy tool group styles (not used after refactor — kept for now)
  toolGroup: {
    marginVertical: spacing.sm,
  },
  toolGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  toolGroupChevron: {
    color: colors.fg45,
    fontSize: 14,
    fontFamily: 'Menlo',
  },
  toolGroupLabel: {
    color: colors.fg82,
    fontSize: fontSize.subheadline,
    fontWeight: weight.medium,
  },
  toolGroupSub: {
    color: colors.fg45,
    fontSize: fontSize.caption,
    flex: 1,
  },
  toolGroupChildren: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.fg10,
    paddingVertical: 4,
  },
  toolChild: {
    paddingHorizontal: spacing.md,
  },
  toolChildHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  toolChildCommand: {
    flex: 1,
    color: colors.fg,
    fontFamily: 'Menlo',
    fontSize: fontSize.footnote,
  },
  toolChildStatus: {
    fontSize: fontSize.caption,
    fontFamily: 'Menlo',
    fontWeight: weight.medium,
  },
  toolChildDuration: {
    color: colors.fg45,
    fontSize: fontSize.caption2,
    fontFamily: 'Menlo',
    minWidth: 32,
    textAlign: 'right',
  },
  toolChildBody: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.lg,
    gap: spacing.sm,
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
