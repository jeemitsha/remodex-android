// Persists the most recent `thread/list` result so the sidebar can paint
// instantly on app launch while the bridge connection is being re-established
// in the background. Stale-while-revalidate.
//
// Storage:
//   - One JSON file per Mac device id at
//     ${documentDirectory}/remodex/threads.<macDeviceId>.json
//   - Wiped if it can't be parsed (no migration story yet — small file).
//   - Capped at 200 threads per write to keep IO + parse time predictable.
//
// We deliberately do NOT cache turn content here. The sidebar only needs the
// thread list metadata (id, title, preview, cwd, status, branch, updatedAt).
// Turn content is fetched on demand when the user taps a thread.

import * as FileSystem from 'expo-file-system/legacy';

import type { ThreadRow } from '../protocol/extract';

const MAX_CACHED_THREADS = 200;
const CACHE_VERSION = 1;

export type ThreadsCacheEntry = {
  version: number;
  savedAt: number;
  macDeviceId: string;
  threads: ThreadRow[];
};

function cacheDirectory(): string {
  const docDir = FileSystem.documentDirectory;
  if (!docDir) {
    // Web / SSR — no filesystem available. Caller should handle null returns
    // from save/load gracefully.
    return '';
  }
  return `${docDir}remodex/`;
}

function cachePathFor(macDeviceId: string): string | null {
  const dir = cacheDirectory();
  if (!dir) return null;
  // Sanitize the id: bridges generally use UUIDs but be defensive.
  const safe = macDeviceId.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safe) return null;
  return `${dir}threads.${safe}.json`;
}

export async function saveThreadsCache(
  macDeviceId: string,
  threads: ThreadRow[],
): Promise<void> {
  const path = cachePathFor(macDeviceId);
  if (!path) return;
  const dir = cacheDirectory();
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  } catch {
    // Already exists, or filesystem refused the call — write below will
    // surface the real error.
  }
  const trimmed = threads.length > MAX_CACHED_THREADS ? threads.slice(0, MAX_CACHED_THREADS) : threads;
  const entry: ThreadsCacheEntry = {
    version: CACHE_VERSION,
    savedAt: Date.now(),
    macDeviceId,
    threads: trimmed,
  };
  try {
    await FileSystem.writeAsStringAsync(path, JSON.stringify(entry), {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    // Cache writes are advisory — never break the actual session-loading
    // flow because of a disk hiccup.
  }
}

export async function loadThreadsCache(
  macDeviceId: string,
): Promise<ThreadsCacheEntry | null> {
  const path = cachePathFor(macDeviceId);
  if (!path) return null;
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return null;
    const raw = await FileSystem.readAsStringAsync(path, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const parsed = JSON.parse(raw) as ThreadsCacheEntry;
    if (
      typeof parsed !== 'object'
      || parsed.version !== CACHE_VERSION
      || !Array.isArray(parsed.threads)
      || parsed.macDeviceId !== macDeviceId
    ) {
      // Stale schema — drop quietly so the bridge result re-seeds it.
      void clearThreadsCache(macDeviceId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearThreadsCache(macDeviceId: string): Promise<void> {
  const path = cachePathFor(macDeviceId);
  if (!path) return;
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    // Nothing to clean up.
  }
}
