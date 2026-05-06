import { describe, expect, it } from 'vitest';

import { groupTurns, type ToolGroup } from './group-turns';
import type { TurnRow } from './protocol/extract';

const u = (id: string, text: string): TurnRow => ({ id, role: 'user', text, raw: null });
const a = (id: string, text: string): TurnRow => ({ id, role: 'assistant', text, raw: null });
const tool = (id: string, command: string, opts: Partial<TurnRow> = {}): TurnRow => ({
  id,
  role: 'tool',
  text: command,
  command,
  raw: null,
  ...opts,
});

describe('groupTurns', () => {
  it('does not group when no tools present', () => {
    const items = groupTurns([u('1', 'hi'), a('2', 'hello')]);
    expect(items).toHaveLength(2);
    expect(items.every((x) => 'role' in x)).toBe(true);
  });

  it('does not group a single tool — keeps it as a regular row', () => {
    const items = groupTurns([u('1', 'run git diff'), tool('2', 'git diff'), a('3', 'done')]);
    expect(items).toHaveLength(3);
    // Single tool stays as TurnRow, not a group, since there's nothing to collapse
    expect((items[1] as TurnRow).role).toBe('tool');
  });

  it('groups consecutive tools into a single group', () => {
    const items = groupTurns([
      u('1', 'do stuff'),
      tool('2', 'cmd a'),
      tool('3', 'cmd b'),
      tool('4', 'cmd c'),
      a('5', 'done'),
    ]);
    expect(items).toHaveLength(3);
    expect((items[0] as TurnRow).role).toBe('user');
    const group = items[1] as ToolGroup;
    expect(group.kind).toBe('tool-group');
    expect(group.tools).toHaveLength(3);
    expect((items[2] as TurnRow).role).toBe('assistant');
  });

  it('starts a new group after a non-tool row interrupts', () => {
    const items = groupTurns([
      tool('1', 'a'),
      tool('2', 'b'),
      a('3', 'thinking…'),
      tool('4', 'c'),
      tool('5', 'd'),
    ]);
    expect(items).toHaveLength(3);
    expect((items[0] as ToolGroup).tools).toHaveLength(2);
    expect((items[1] as TurnRow).role).toBe('assistant');
    expect((items[2] as ToolGroup).tools).toHaveLength(2);
  });

  it('sums totalDurationMs across the group', () => {
    const items = groupTurns([
      tool('1', 'a', { durationMs: 100 }),
      tool('2', 'b', { durationMs: 250 }),
      tool('3', 'c', { durationMs: 50 }),
    ]);
    const group = items[0] as ToolGroup;
    expect(group.totalDurationMs).toBe(400);
  });

  it('counts failures in the group', () => {
    const items = groupTurns([
      tool('1', 'a', { exitCode: 0 }),
      tool('2', 'b', { exitCode: 1 }),
      tool('3', 'c', { toolStatus: 'failed' }),
      tool('4', 'd', { exitCode: 2 }),
    ]);
    const group = items[0] as ToolGroup;
    expect(group.failureCount).toBe(3);
  });
});
