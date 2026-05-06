// Walks a chat-ordered list of TurnRows and packs every consecutive run of
// tool rows (commandExecution, mcpToolCall, fileChange, etc.) into a single
// "tool group" so the chat doesn't flood with 24 separate command cards.
//
// The user can then expand the group to see individual tool rows, and expand
// each individual tool row for its full command + output. iOS Codex does the
// same thing via its "thinking" / "ran tools" collapsible.

import type { TurnRow } from './protocol/extract';

export type ToolGroup = {
  kind: 'tool-group';
  id: string;
  tools: TurnRow[];
  totalDurationMs: number;
  failureCount: number;
};

export type DisplayItem = TurnRow | ToolGroup;

export function groupTurns(turns: TurnRow[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  let buffer: TurnRow[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    if (buffer.length === 1) {
      out.push(buffer[0]);
    } else {
      out.push(toGroup(buffer));
    }
    buffer = [];
  };

  for (const t of turns) {
    if (t.role === 'tool') {
      buffer.push(t);
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

function toGroup(tools: TurnRow[]): ToolGroup {
  let totalDurationMs = 0;
  let failureCount = 0;
  for (const t of tools) {
    if (typeof t.durationMs === 'number') totalDurationMs += t.durationMs;
    if (t.exitCode !== undefined && t.exitCode !== 0) failureCount += 1;
    if (t.toolStatus === 'failed' || t.toolStatus === 'error') failureCount += 1;
  }
  return {
    kind: 'tool-group',
    id: `tool-group-${tools[0].id}-${tools.length}`,
    tools,
    totalDurationMs,
    failureCount,
  };
}
