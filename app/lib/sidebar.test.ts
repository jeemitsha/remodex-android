import { describe, expect, it } from 'vitest';

import { groupThreadsByProject, relativeTime, statusColor } from './sidebar';

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
