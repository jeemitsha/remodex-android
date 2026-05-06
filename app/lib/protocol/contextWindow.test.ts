import { describe, expect, it } from 'vitest';

import {
  compactUsageLabel,
  extractContextWindowUsage,
  formatTokenCount,
  fractionUsed,
  percentRemaining,
} from './contextWindow';

describe('extractContextWindowUsage', () => {
  it('parses canonical { usage: { tokensUsed, tokenLimit } }', () => {
    const r = extractContextWindowUsage({ usage: { tokensUsed: 1234, tokenLimit: 200000 } });
    expect(r).toEqual({ tokensUsed: 1234, tokenLimit: 200000 });
  });

  it('falls back to root-level fields if no `usage` wrapper', () => {
    const r = extractContextWindowUsage({ tokensUsed: 50, tokenLimit: 1000 });
    expect(r).toEqual({ tokensUsed: 50, tokenLimit: 1000 });
  });

  it('accepts snake_case alternates', () => {
    const r = extractContextWindowUsage({ usage: { used_tokens: 12, max_tokens: 100 } });
    expect(r).toEqual({ tokensUsed: 12, tokenLimit: 100 });
  });

  it('infers limit from tokensRemaining + tokensUsed when explicit limit absent', () => {
    const r = extractContextWindowUsage({ usage: { tokensUsed: 30, tokensRemaining: 70 } });
    expect(r).toEqual({ tokensUsed: 30, tokenLimit: 100 });
  });

  it('clamps tokensUsed to tokenLimit', () => {
    const r = extractContextWindowUsage({ usage: { tokensUsed: 5000, tokenLimit: 1000 } });
    expect(r).toEqual({ tokensUsed: 1000, tokenLimit: 1000 });
  });

  it('returns null when tokenLimit cannot be inferred', () => {
    expect(extractContextWindowUsage({ usage: { tokensUsed: 100 } })).toBeNull();
    expect(extractContextWindowUsage({})).toBeNull();
    expect(extractContextWindowUsage(null)).toBeNull();
    expect(extractContextWindowUsage({ usage: {} })).toBeNull();
  });

  it('coerces string-encoded numbers (some bridges send strings)', () => {
    const r = extractContextWindowUsage({ usage: { tokensUsed: '500', tokenLimit: '8000' } });
    expect(r).toEqual({ tokensUsed: 500, tokenLimit: 8000 });
  });
});

describe('fractionUsed / percentRemaining', () => {
  it('reports remaining percent rounded', () => {
    const u = { tokensUsed: 250, tokenLimit: 1000 };
    expect(fractionUsed(u)).toBeCloseTo(0.25);
    expect(percentRemaining(u)).toBe(75);
  });

  it('caps at 0/100 when usage exceeds limit', () => {
    expect(percentRemaining({ tokensUsed: 5000, tokenLimit: 1000 })).toBe(0);
  });

  it('returns 0 fraction for zero/empty limits', () => {
    expect(fractionUsed({ tokensUsed: 100, tokenLimit: 0 })).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('prints raw count under 1K', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  it('renders thousands as Xk with decimal when not whole', () => {
    expect(formatTokenCount(1000)).toBe('1K');
    expect(formatTokenCount(12500)).toBe('12.5K');
    expect(formatTokenCount(200000)).toBe('200K');
  });

  it('renders millions as X.XM', () => {
    expect(formatTokenCount(1_500_000)).toBe('1.5M');
  });
});

describe('compactUsageLabel', () => {
  it('renders an em-dash for null / zero-limit usage', () => {
    expect(compactUsageLabel(null)).toBe('—');
    expect(compactUsageLabel({ tokensUsed: 0, tokenLimit: 0 })).toBe('—');
  });

  it('renders the used/limit pair with iOS-style formatting', () => {
    expect(compactUsageLabel({ tokensUsed: 12500, tokenLimit: 200000 })).toBe('12.5K/200K');
  });
});
