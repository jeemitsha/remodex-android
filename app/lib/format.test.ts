import { describe, expect, it } from 'vitest';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

describe('formatDuration', () => {
  it('handles ms', () => { expect(formatDuration(500)).toBe('500ms'); });
  it('handles seconds', () => { expect(formatDuration(43210)).toBe('43s'); });
  it('m+s for 169986ms', () => { expect(formatDuration(169986)).toBe('2m 49s'); });
  it('h+m+s', () => { expect(formatDuration(3661000)).toBe('1h 1m 1s'); });
});
