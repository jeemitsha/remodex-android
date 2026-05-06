import { describe, expect, it } from 'vitest';

import { applyGroupLimit, groupThreadsByProject, relativeTime, statusColor } from './sidebar';

describe('groupThreadsByProject', () => {
  it('groups threads by their cwd path with basename labels', () => {
    const out = groupThreadsByProject([
      { id: 't1', cwd: '/Users/dev/auth-middleware', updatedAt: 100 },
      { id: 't2', cwd: '/Users/dev/auth-middleware/', updatedAt: 200 },
      { id: 't3', cwd: '/Users/dev/payments', updatedAt: 50 },
    ]);

    expect(out).toHaveLength(3);
    // Same cwd modulo trailing slash → still distinct buckets, since iOS treats them as separate
    expect(out.map((g) => g.label).sort()).toEqual(['auth-middleware', 'auth-middleware', 'payments']);
  });

  it('puts threads without cwd in an "Other" bucket', () => {
    const out = groupThreadsByProject([
      { id: 't1', updatedAt: 100 },
      { id: 't2', cwd: '/Users/dev/x', updatedAt: 50 },
    ]);
    const other = out.find((g) => g.label === 'Other');
    expect(other).toBeDefined();
    expect(other!.threads.map((t) => t.id)).toEqual(['t1']);
  });

  it('sorts threads inside each group by recency (newest first)', () => {
    const out = groupThreadsByProject([
      { id: 'old', cwd: '/p', updatedAt: 100 },
      { id: 'new', cwd: '/p', updatedAt: 500 },
      { id: 'mid', cwd: '/p', updatedAt: 300 },
    ]);
    expect(out[0].threads.map((t) => t.id)).toEqual(['new', 'mid', 'old']);
  });

  it('sorts groups by their most-recent-thread, newest first', () => {
    const out = groupThreadsByProject([
      { id: 'a', cwd: '/old-project', updatedAt: 100 },
      { id: 'b', cwd: '/new-project', updatedAt: 1000 },
    ]);
    expect(out[0].label).toBe('new-project');
  });
});

describe('relativeTime', () => {
  const now = 1_700_000_000_000;

  it('returns seconds for under a minute', () => {
    expect(relativeTime(now - 30_000, now)).toBe('30s');
  });
  it('returns minutes for under an hour', () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m');
  });
  it('returns hours for under a day', () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
  });
  it('returns days for under a month', () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d');
  });
  it('handles seconds-since-epoch (smaller numbers) gracefully', () => {
    // Some bridges send seconds, not ms. Auto-detect.
    const seconds = (now - 5 * 60_000) / 1000;
    expect(relativeTime(seconds, now)).toBe('5m');
  });
  it('handles ISO strings', () => {
    const iso = new Date(now - 10 * 60_000).toISOString();
    expect(relativeTime(iso, now)).toBe('10m');
  });
  it('returns empty string for missing input', () => {
    expect(relativeTime(undefined, now)).toBe('');
  });
});

describe('applyGroupLimit', () => {
  const groups = groupThreadsByProject([
    { id: 'a1', cwd: '/p/alpha', updatedAt: 100 },
    { id: 'a2', cwd: '/p/alpha', updatedAt: 200 },
    { id: 'a3', cwd: '/p/alpha', updatedAt: 300 },
    { id: 'a4', cwd: '/p/alpha', updatedAt: 400 },
    { id: 'a5', cwd: '/p/alpha', updatedAt: 500 },
    { id: 'a6', cwd: '/p/alpha', updatedAt: 600 },
    { id: 'a7', cwd: '/p/alpha', updatedAt: 700 },
    { id: 'b1', cwd: '/p/beta', updatedAt: 100 },
    { id: 'b2', cwd: '/p/beta', updatedAt: 200 },
  ]);

  it('caps each group to the limit and reports hiddenCount', () => {
    const out = applyGroupLimit(groups, 5);
    const alpha = out.find((g) => g.label === 'alpha')!;
    const beta = out.find((g) => g.label === 'beta')!;
    expect(alpha.visible).toHaveLength(5);
    expect(alpha.hiddenCount).toBe(2);
    expect(beta.visible).toHaveLength(2);
    expect(beta.hiddenCount).toBe(0);
  });

  it('keeps the most-recent threads in the visible slice', () => {
    const out = applyGroupLimit(groups, 5);
    const alpha = out.find((g) => g.label === 'alpha')!;
    expect(alpha.visible.map((t) => t.id)).toEqual(['a7', 'a6', 'a5', 'a4', 'a3']);
  });

  it('reveals everything when the group key is in expandedKeys', () => {
    const out = applyGroupLimit(groups, 5, new Set([groups[0].key]));
    const alpha = out.find((g) => g.label === 'alpha')!;
    expect(alpha.visible).toHaveLength(7);
    expect(alpha.hiddenCount).toBe(0);
  });

  it('treats limit=0 as "show none until expanded"', () => {
    const out = applyGroupLimit(groups, 0);
    const alpha = out.find((g) => g.label === 'alpha')!;
    expect(alpha.visible).toHaveLength(0);
    expect(alpha.hiddenCount).toBe(7);
  });

  it('preserves the original group ordering and metadata', () => {
    const out = applyGroupLimit(groups, 5);
    expect(out.map((g) => g.label)).toEqual(groups.map((g) => g.label));
    for (let i = 0; i < out.length; i++) {
      expect(out[i].key).toBe(groups[i].key);
      expect(out[i].fullPath).toBe(groups[i].fullPath);
      expect(out[i].threads).toBe(groups[i].threads);
    }
  });
});

describe('statusColor', () => {
  it('green for running variants', () => {
    expect(statusColor('running')).toBe('#9be39a');
    expect(statusColor('in_progress')).toBe('#9be39a');
    expect(statusColor('active')).toBe('#9be39a');
  });
  it('orange for archived', () => {
    expect(statusColor('archived')).toBe('#ff9f0a');
  });
  it('red for failures', () => {
    expect(statusColor('failed')).toBe('#ff8b8b');
    expect(statusColor('error')).toBe('#ff8b8b');
  });
  it('null (no dot) for idle states', () => {
    expect(statusColor('idle')).toBeNull();
    expect(statusColor('completed')).toBeNull();
    expect(statusColor(undefined)).toBeNull();
  });
});
