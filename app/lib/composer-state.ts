// Composer state — pure types + reducer the chat screen drives. Mirrors the
// per-thread fields iOS keeps in TurnComposerViewState.swift, but trimmed to
// what we actually wire today: text, attachments, plan-mode flag, and the
// runtime/model label. Live transcription state, queued drafts, autocomplete
// panels, and access-mode pill are deferred until the matching JSON-RPC
// channels are reverse-engineered (see Docs/STATE.md).

export type ComposerAttachment = {
  // Local content URI from expo-image-picker (e.g. file:///… or assets-library://…).
  // We store the URI for thumbnail rendering only; uploading to the bridge
  // requires `input[].image_url` payload work that's not done yet.
  uri: string;
  // Stable id so removing one re-renders the right tile.
  id: string;
  // Optional dimensions if the picker returned them — used for aspect-ratio.
  width?: number;
  height?: number;
};

export type ComposerState = {
  text: string;
  attachments: ComposerAttachment[];
  planArmed: boolean;
  // Display-only label until we wire `runtime/list-models` from the bridge.
  modelLabel: string;
};

export const INITIAL_COMPOSER_STATE: ComposerState = {
  text: '',
  attachments: [],
  planArmed: false,
  modelLabel: 'Default',
};

export type ComposerAction =
  | { type: 'set-text'; text: string }
  | { type: 'add-attachments'; items: ComposerAttachment[] }
  | { type: 'remove-attachment'; id: string }
  | { type: 'clear-attachments' }
  | { type: 'set-plan-armed'; armed: boolean }
  | { type: 'set-model-label'; label: string }
  | { type: 'reset' };

// Cap mirrors iOS — Codex limits image attachments per turn so we don't blow
// the wire-format budget. Keep consistent so later we can render the same
// "remaining slots" hint iOS shows.
export const MAX_ATTACHMENTS_PER_TURN = 8;

export function composerReducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'set-text':
      return state.text === action.text ? state : { ...state, text: action.text };
    case 'add-attachments': {
      if (action.items.length === 0) return state;
      const remaining = Math.max(0, MAX_ATTACHMENTS_PER_TURN - state.attachments.length);
      if (remaining === 0) return state;
      const next = state.attachments.concat(action.items.slice(0, remaining));
      return { ...state, attachments: next };
    }
    case 'remove-attachment':
      return { ...state, attachments: state.attachments.filter((a) => a.id !== action.id) };
    case 'clear-attachments':
      return state.attachments.length === 0 ? state : { ...state, attachments: [] };
    case 'set-plan-armed':
      return state.planArmed === action.armed ? state : { ...state, planArmed: action.armed };
    case 'set-model-label':
      return state.modelLabel === action.label ? state : { ...state, modelLabel: action.label };
    case 'reset':
      return INITIAL_COMPOSER_STATE;
  }
}

// "Empty" enough that the send button should be disabled. Matches iOS:
// trimmed text empty AND no attachments → can't send.
export function isComposerSendable(state: ComposerState): boolean {
  return state.text.trim().length > 0 || state.attachments.length > 0;
}

export function remainingAttachmentSlots(state: ComposerState): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_TURN - state.attachments.length);
}
