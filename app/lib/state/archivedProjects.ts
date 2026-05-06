// Locally-archived project paths. The bridge has its own per-thread archived
// flag (which we already filter via thread/list { archived: true }), but
// users often want to hide entire *projects* the bridge still considers
// active — e.g. old Trading repos that aren't relevant today.
//
// We store a Set<projectPath> in expo-secure-store keyed per Mac device id
// so that repairing to a different Mac doesn't carry stale archives over.
//
// Storage strategy:
//   - One JSON-encoded array per macDeviceId at
//     `remodex.archivedProjects.<macDeviceId>` (SecureStore)
//   - Capped at 200 entries. Rare to exceed.

import * as SecureStore from 'expo-secure-store';

const KEY_PREFIX = 'remodex.archivedProjects.v1';
const MAX_ENTRIES = 200;

function keyFor(macDeviceId: string): string {
  return `${KEY_PREFIX}.${macDeviceId}`;
}

export async function loadArchivedProjects(macDeviceId: string): Promise<Set<string>> {
  if (!macDeviceId) return new Set();
  try {
    const raw = await SecureStore.getItemAsync(keyFor(macDeviceId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return new Set();
  }
}

export async function saveArchivedProjects(
  macDeviceId: string,
  projects: ReadonlySet<string>,
): Promise<void> {
  if (!macDeviceId) return;
  const arr = Array.from(projects).slice(0, MAX_ENTRIES);
  try {
    await SecureStore.setItemAsync(keyFor(macDeviceId), JSON.stringify(arr));
  } catch {
    // SecureStore writes are best-effort — don't break the UI on a disk hiccup.
  }
}

export async function archiveProject(macDeviceId: string, projectPath: string): Promise<Set<string>> {
  const cur = await loadArchivedProjects(macDeviceId);
  cur.add(projectPath);
  await saveArchivedProjects(macDeviceId, cur);
  return cur;
}

export async function unarchiveProject(macDeviceId: string, projectPath: string): Promise<Set<string>> {
  const cur = await loadArchivedProjects(macDeviceId);
  cur.delete(projectPath);
  await saveArchivedProjects(macDeviceId, cur);
  return cur;
}
