// Sidebar grouping + relative-time formatting that mirrors the iOS sidebar.
// Reference: SidebarThreadGrouping.swift, SidebarRelativeTimeFormatter.swift.

export type ThreadLike = {
  id: string;
  title?: string;
  status?: string;
  cwd?: string;
  updatedAt?: number | string;
};

export type ThreadGroup<T> = {
  key: string;
  label: string; // basename of the project path (e.g. "auth-middleware")
  fullPath: string;
  threads: T[];
  mostRecentMs: number;
};

export type LimitedThreadGroup<T> = ThreadGroup<T> & {
  visible: T[];
  hiddenCount: number;
};

// Per-project sidebar limit. iOS shows everything in a scrolling list, but on
// a phone we want to keep the drawer skimmable — pick the N most-recent threads
// per project and stash the rest behind a "Show all (M)" toggle.
export function applyGroupLimit<T>(
  groups: ThreadGroup<T>[],
  limit: number,
  expandedKeys: ReadonlySet<string> = new Set(),
): LimitedThreadGroup<T>[] {
  const safe = Math.max(0, Math.floor(limit));
  return groups.map((g) => {
    const expanded = expandedKeys.has(g.key);
    const visible = expanded || g.threads.length <= safe ? g.threads : g.threads.slice(0, safe);
    const hiddenCount = expanded ? 0 : Math.max(0, g.threads.length - visible.length);
    return { ...g, visible, hiddenCount };
  });
}

// Groups by the cwd path (one section per project), like iOS does.
// Threads without a cwd land in an "Other" group.
export function groupThreadsByProject<T extends ThreadLike>(threads: T[]): ThreadGroup<T>[] {
  const buckets = new Map<string, ThreadGroup<T>>();

  for (const t of threads) {
    const path = (t.cwd && t.cwd.trim()) || '__no_cwd__';
    const isReal = path !== '__no_cwd__';
    if (!buckets.has(path)) {
      buckets.set(path, {
        key: path,
        label: isReal ? basenameOf(path) : 'Other',
        fullPath: isReal ? path : '',
        threads: [],
        mostRecentMs: 0,
      });
    }
    const g = buckets.get(path)!;
    g.threads.push(t);
    const ms = updatedAtToMs(t.updatedAt);
    if (ms > g.mostRecentMs) g.mostRecentMs = ms;
  }

  // Sort threads inside each group by recency (newest first), then groups by recency.
  for (const g of buckets.values()) {
    g.threads.sort((a, b) => updatedAtToMs(b.updatedAt) - updatedAtToMs(a.updatedAt));
  }

  return Array.from(buckets.values()).sort((a, b) => b.mostRecentMs - a.mostRecentMs);
}

export function relativeTime(updatedAt: number | string | undefined, now: number = Date.now()): string {
  const ms = updatedAtToMs(updatedAt);
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

export function statusColor(status: string | undefined): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === 'running' || s === 'in_progress' || s === 'active') return '#9be39a';
  if (s === 'archived' || s === 'archived_local') return '#ff9f0a';
  if (s === 'failed' || s === 'error') return '#ff8b8b';
  if (s === 'ready' || s === 'idle' || s === 'completed' || s === 'done') return null; // no dot for idle, like iOS
  return null;
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) return trimmed || path;
  const base = trimmed.slice(idx + 1);
  return base || path;
}

function updatedAtToMs(updatedAt: number | string | undefined): number {
  if (typeof updatedAt === 'number') return updatedAt > 1e12 ? updatedAt : updatedAt * 1000;
  if (typeof updatedAt === 'string') {
    const n = Number(updatedAt);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(updatedAt);
    if (!Number.isNaN(d)) return d;
  }
  return 0;
}
