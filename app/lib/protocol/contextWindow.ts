// Context-window usage. Mirrors iOS ContextWindowUsage.swift +
// extractContextWindowUsage in IncomingSupport.swift — the bridge ships several
// field-name spellings, so this stays as forgiving as the iOS decoder.
//
// Method:  thread/contextWindow/read
// Params:  { threadId, turnId? }
// Result:  { usage: { ...one of many key spellings... } }

export type ContextWindowUsage = {
  tokensUsed: number;
  tokenLimit: number;
};

const ZERO: ContextWindowUsage = { tokensUsed: 0, tokenLimit: 0 };

const TOKENS_USED_KEYS = [
  'tokensUsed',
  'tokens_used',
  'totalTokens',
  'total_tokens',
  'usedTokens',
  'used_tokens',
  'inputTokens',
  'input_tokens',
];

const TOKEN_LIMIT_KEYS = [
  'tokenLimit',
  'token_limit',
  'maxTokens',
  'max_tokens',
  'contextWindow',
  'context_window',
  'contextSize',
  'context_size',
  'maxContextTokens',
  'max_context_tokens',
  'inputTokenLimit',
  'input_token_limit',
  'maxInputTokens',
  'max_input_tokens',
];

const TOKENS_REMAINING_KEYS = [
  'tokensRemaining',
  'tokens_remaining',
  'remainingTokens',
  'remaining_tokens',
  'remainingInputTokens',
  'remaining_input_tokens',
];

// Top-level extractor for `thread/contextWindow/read` responses. The bridge
// wraps usage one level deep (`{ usage: { ... } }`) but some legacy paths
// expose the fields at the root, so we try both.
export function extractContextWindowUsage(result: unknown): ContextWindowUsage | null {
  if (!result || typeof result !== 'object') return null;
  const root = result as Record<string, unknown>;
  const wrapped = root.usage;
  if (wrapped && typeof wrapped === 'object') {
    const usage = decodeUsage(wrapped as Record<string, unknown>);
    if (usage) return usage;
  }
  return decodeUsage(root);
}

function decodeUsage(obj: Record<string, unknown>): ContextWindowUsage | null {
  const tokensUsed = firstInt(obj, TOKENS_USED_KEYS) ?? 0;
  const explicitLimit = firstInt(obj, TOKEN_LIMIT_KEYS);
  const tokensRemaining = firstInt(obj, TOKENS_REMAINING_KEYS);

  let tokenLimit: number | null = null;
  if (explicitLimit !== null) {
    tokenLimit = explicitLimit;
  } else if (tokensRemaining !== null) {
    tokenLimit = Math.max(0, tokensUsed) + Math.max(0, tokensRemaining);
  }
  if (tokenLimit === null || tokenLimit <= 0) return null;

  const clampedUsed = Math.min(Math.max(0, tokensUsed), tokenLimit);
  return { tokensUsed: clampedUsed, tokenLimit };
}

export function fractionUsed(u: ContextWindowUsage): number {
  if (u.tokenLimit <= 0) return 0;
  return Math.max(0, Math.min(1, u.tokensUsed / u.tokenLimit));
}

export function percentRemaining(u: ContextWindowUsage): number {
  return Math.max(0, 100 - Math.round(fractionUsed(u) * 100));
}

// "12.5K", "1.2M", "850". Matches iOS formatTokenCount.
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return '0';
  if (count >= 1_000_000) {
    const value = count / 1_000_000;
    return `${value.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const value = count / 1_000;
    return value % 1 === 0 ? `${Math.round(value)}K` : `${value.toFixed(1)}K`;
  }
  return `${Math.floor(count)}`;
}

// Compact pill label: "85K / 200K" (iOS shows a ring instead, we show text).
// When usage is zero/unavailable we render an em-dash so the pill stays
// width-stable.
export function compactUsageLabel(u: ContextWindowUsage | null): string {
  if (!u || u.tokenLimit <= 0) return '—';
  return `${formatTokenCount(u.tokensUsed)}/${formatTokenCount(u.tokenLimit)}`;
}

export const CONTEXT_USAGE_ZERO = ZERO;

function firstInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.floor(n);
    }
  }
  return null;
}
