import { describe, expect, it } from 'vitest';

import {
  applyGroupLimit,
  filterActiveThreads,
  groupThreadsByProject,
  isLikelyFilesystemPath,
  normalizeProjectPath,
  relativeTime,
  splitProjectsAndChats,
  statusColor,
} from './sidebar';

describe('groupThreadsByProject', () => {
  it('groups threads by their normalized cwd path with basename labels', () => {
    const out = groupThreadsByProject([
      { id: 't1', cwd: '/Users/dev/auth-middleware', updatedAt: 100 },
      { id: 't2', cwd: '/Users/dev/auth-middleware/', updatedAt: 200 }, // trailing slash → same bucket
      { id: 't3', cwd: '/Users/dev/payments', updatedAt: 50 },
    ]);

    expect(out).toHaveLength(2);
    expect(out.map((g) => g.label).sort()).toEqual(['auth-middleware', 'payments']);
    const auth = out.find((g) => g.label === 'auth-middleware')!;
    expect(auth.threads.map((t) => t.id)).toEqual(['t2', 't1']);
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

  it('pins the active-thread id into visible[] even when older than the top-5', () => {
    // a1 is the OLDEST in alpha (updatedAt: 100). Without pinning it would be
    // hidden behind "Show all".
    const out = applyGroupLimit(groups, 5, new Set(), new Set(['a1']));
    const alpha = out.find((g) => g.label === 'alpha')!;
    expect(alpha.visible.map((t) => t.id)).toContain('a1');
    expect(alpha.visible).toHaveLength(6); // top-5 + pinned
    expect(alpha.hiddenCount).toBe(1);
  });

  it('does nothing extra when the pinned id is already in the top-5', () => {
    const out = applyGroupLimit(groups, 5, new Set(), new Set(['a7']));
    const alpha = out.find((g) => g.label === 'alpha')!;
    expect(alpha.visible).toHaveLength(5);
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

describe('filterActiveThreads (drops by id-set)', () => {
  it('drops threads whose id is in the archived set', () => {
    const out = filterActiveThreads(
      [
        { id: 'live-1' },
        { id: 'old' },
        { id: 'live-2' },
        { id: 'archived-local' },
      ],
      new Set(['old', 'archived-local']),
    );
    expect(out.map((t) => t.id)).toEqual(['live-1', 'live-2']);
  });

  it('returns the input unchanged when the archived set is empty', () => {
    const input = [{ id: 'a' }, { id: 'b' }];
    expect(filterActiveThreads(input, new Set())).toBe(input);
  });
});

describe('normalizeProjectPath / isLikelyFilesystemPath', () => {
  it('returns null for empty / whitespace cwd', () => {
    expect(normalizeProjectPath(undefined)).toBeNull();
    expect(normalizeProjectPath('')).toBeNull();
    expect(normalizeProjectPath('   ')).toBeNull();
  });

  it('returns null for non-path values like "Cloud"', () => {
    expect(normalizeProjectPath('Cloud')).toBeNull();
    expect(normalizeProjectPath('agent-runtime')).toBeNull();
    expect(isLikelyFilesystemPath('Cloud')).toBe(false);
  });

  it('keeps unix paths and tilde-relative paths', () => {
    expect(normalizeProjectPath('/Users/me/proj')).toBe('/Users/me/proj');
    expect(normalizeProjectPath('/Users/me/proj/')).toBe('/Users/me/proj');
    expect(normalizeProjectPath('~/Code/foo')).toBe('~/Code/foo');
  });

  it('keeps Windows drive-letter paths', () => {
    expect(normalizeProjectPath('C:/Code/proj')).toBe('C:/Code/proj');
    expect(normalizeProjectPath('D:\\Code')).toBe('D:\\Code');
  });
});

describe('groupThreadsByProject (with normalization)', () => {
  it('moves threads with non-path cwd values into the no-project bucket', () => {
    const out = groupThreadsByProject([
      { id: 'p1', cwd: '/Users/dev/auth', updatedAt: 1 },
      { id: 'cloud1', cwd: 'Cloud', updatedAt: 2 },
      { id: 'cloud2', cwd: '', updatedAt: 3 },
      { id: 'p2', cwd: '/Users/dev/auth', updatedAt: 4 },
    ]);
    const auth = out.find((g) => g.label === 'auth');
    const other = out.find((g) => g.label === 'Other');
    expect(auth?.threads.map((t) => t.id)).toEqual(['p2', 'p1']);
    expect(other?.threads.map((t) => t.id)).toEqual(['cloud2', 'cloud1']);
  });
});

describe('splitProjectsAndChats', () => {
  it('moves cwd-less threads into chats and keeps cwd-bound ones in projects', () => {
    const out = splitProjectsAndChats([
      { id: 'a', cwd: '/Users/dev/auth', updatedAt: 1 },
      { id: 'b', updatedAt: 2 }, // no cwd → chat
      { id: 'c', cwd: '/Users/dev/auth', updatedAt: 3 },
      { id: 'd', updatedAt: 4 }, // no cwd → chat
    ]);
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].label).toBe('auth');
    expect(out.projects[0].threads.map((t) => t.id)).toEqual(['c', 'a']);
    expect(out.chats.map((t) => t.id)).toEqual(['d', 'b']);
  });

  it('returns empty chats array when every thread has a cwd', () => {
    const out = splitProjectsAndChats([{ id: 'a', cwd: '/p', updatedAt: 1 }]);
    expect(out.chats).toEqual([]);
    expect(out.projects).toHaveLength(1);
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
