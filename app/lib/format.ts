// Human-friendly formatters used across the chat UI. Pure, fixture-tested.

// Precise human duration — never rounds to a coarser unit when finer precision
// would be more informative. e.g. 169986ms → "2m 49s", 3600500ms → "1h 0m 0s",
// 43210ms → "43s". Sub-second truncates to ms; sub-second precision below 1ms
// shows "0ms".
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(0, Math.floor(ms))}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
