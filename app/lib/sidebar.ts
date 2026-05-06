// Sidebar grouping + relative-time formatting that mirrors the iOS sidebar.
// Reference: SidebarThreadGrouping.swift, SidebarRelativeTimeFormatter.swift,
// CodexThread.normalizeProjectPath, CodexThread.isLikelyFilesystemPath.

export type ThreadLike = {
  id: string;
  title?: string;
  status?: string;
  cwd?: string;
  updatedAt?: number | string;
};

// Mirrors iOS CodexThread.isLikelyFilesystemPath. The bridge sometimes sets
// `cwd` to non-path values (e.g. "Cloud" for app-server / agent threads), so
// we only treat the cwd as a project anchor when it actually looks like a
// filesystem path. Everything else falls into the "Chats" bucket.
export function isLikelyFilesystemPath(value: string): boolean {
  if (!value) return false;
  if (value === '/' || value.startsWith('/') || value.startsWith('~/')) return true;
  // Windows drive letter: "C:\..." or "C:/..."
  if (
    value.length >= 3
    && /^[A-Za-z]:[\\/]/.test(value)
  ) return true;
  // UNC path: "\\server\share"
  if (value.startsWith('\\\\')) return true;
  return false;
}

export function normalizeProjectPath(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const trimmed = cwd.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!isLikelyFilesystemPath(trimmed)) return null;
  return trimmed;
}

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
//
// `pinnedIds` (typically just the currently-open thread) are always included
// in `visible[]` regardless of where they fall in the recency order, so the
// thread the user is reading never disappears behind "Show all".
export function applyGroupLimit<T extends { id: string }>(
  groups: ThreadGroup<T>[],
  limit: number,
  expandedKeys: ReadonlySet<string> = new Set(),
  pinnedIds: ReadonlySet<string> = new Set(),
): LimitedThreadGroup<T>[] {
  const safe = Math.max(0, Math.floor(limit));
  return groups.map((g) => {
    const expanded = expandedKeys.has(g.key);
    if (expanded || g.threads.length <= safe) {
      return { ...g, visible: g.threads, hiddenCount: 0 };
    }
    const head = g.threads.slice(0, safe);
    const tail = g.threads.slice(safe);
    const pinnedFromTail = pinnedIds.size === 0
      ? []
      : tail.filter((t) => pinnedIds.has(t.id));
    const visible = pinnedFromTail.length === 0 ? head : [...head, ...pinnedFromTail];
    return { ...g, visible, hiddenCount: g.threads.length - visible.length };
  });
}

// Groups by the cwd path (one section per project), like iOS does. Threads
// whose cwd doesn't look like a filesystem path (e.g. cloud / agent-managed
// chats with "Cloud" or empty cwd) land in a no-project bucket — they get
// rendered as the bottom "Chats" section, not as their own project.
const NO_PROJECT_KEY = '__no_cwd__';

export function groupThreadsByProject<T extends ThreadLike>(threads: T[]): ThreadGroup<T>[] {
  const buckets = new Map<string, ThreadGroup<T>>();

  for (const t of threads) {
    const normalized = normalizeProjectPath(t.cwd);
    const path = normalized ?? NO_PROJECT_KEY;
    const isReal = normalized !== null;
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

// Drops threads whose id appears in `archivedIds`. The bridge's `thread/list`
// (active call, no `archived` param) still includes archived threads — iOS
// makes a parallel `thread/list { archived: true }` call, builds the id set,
// and uses it to filter / mark threads. We mirror that.
export function filterActiveThreads<T extends { id: string }>(
  threads: T[],
  archivedIds: ReadonlySet<string>,
): T[] {
  if (archivedIds.size === 0) return threads;
  return threads.filter((t) => !archivedIds.has(t.id));
}

// Splits threads into project-bound groups (with cwd) and project-less chats.
// Mirrors iOS where the bottom of the sidebar pins a separate "Chats" section
// for ad-hoc threads not tied to a code project.
export function splitProjectsAndChats<T extends ThreadLike>(threads: T[]): {
  projects: ThreadGroup<T>[];
  chats: T[];
} {
  const projects: ThreadGroup<T>[] = [];
  let chats: T[] = [];
  for (const g of groupThreadsByProject(threads)) {
    if (g.key === '__no_cwd__') {
      chats = g.threads;
    } else {
      projects.push(g);
    }
  }
  return { projects, chats };
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
