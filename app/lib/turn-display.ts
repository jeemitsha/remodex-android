// Restructures a flat TurnRow[] (chronological, post-extract) into per-turn
// display blocks that match iOS Codex's chat layout:
//
//   [user prompt bubble]
//   [Worked for {duration} ▼ — wraps everything intermediate]
//     ├── narration (intermediate agentMessage with phase=commentary)
//     ├── steered user prompts (mid-turn userMessage)
//     ├── commands-batch (consecutive commandExecution rows, collapsible)
//     └── tool-call (mcpToolCall, each rendered as its own pill: "Used Gmail")
//   [final assistant text — plain markdown, full width]
//
// Driven entirely off the `turnIndex`, `phase`, and `toolKind` fields that
// extract.ts now sets on each row. Pure function; tested with fixtures.

import type { FileChange, TurnMeta, TurnRow } from './protocol/extract';

export type TurnDisplay = {
  id: string;
  userPrompts: TurnRow[];
  intermediate: IntermediateBlock[];
  finalAnswer: TurnRow | null;
  // All file edits from every fileChange row in this turn, deduped by path
  // (later edits to the same file shadow earlier ones). Drives the
  // "N files changed +X -Y" summary card pinned at the bottom of the turn.
  fileChanges: FileChange[];
  // Wall-clock duration of the entire turn (start → completion) when the
  // bridge supplied turn metadata. Falls back to `toolDurationMs` (the sum of
  // tool execution times) when wall-clock isn't available — that's a lower
  // bound but at least non-zero for in-flight or legacy responses.
  totalDurationMs: number;
  toolDurationMs: number;
  status?: string;
};

export type IntermediateBlock =
  | { kind: 'narration'; row: TurnRow }
  | { kind: 'user-steered'; row: TurnRow }
  | { kind: 'commands-batch'; rows: TurnRow[]; durationMs: number }
  | { kind: 'tool-call'; row: TurnRow }
  | { kind: 'system'; row: TurnRow };

export function buildTurnDisplays(rows: TurnRow[], meta: TurnMeta[] = []): TurnDisplay[] {
  const metaByIndex = new Map<number, TurnMeta>();
  for (const m of meta) metaByIndex.set(m.turnIndex, m);
  return buildTurnDisplaysImpl(rows, metaByIndex);
}

function buildTurnDisplaysImpl(rows: TurnRow[], metaByIndex: Map<number, TurnMeta>): TurnDisplay[] {
  // Bucket by turnIndex. Rows without a turnIndex (e.g., live-streamed
  // optimistic rows from compose) get bucketed into a synthetic last turn.
  const byTurn = new Map<number, TurnRow[]>();
  let maxIndex = -1;
  let unindexedFallback: TurnRow[] = [];

  for (const r of rows) {
    if (typeof r.turnIndex === 'number') {
      maxIndex = Math.max(maxIndex, r.turnIndex);
      const bucket = byTurn.get(r.turnIndex) ?? [];
      bucket.push(r);
      byTurn.set(r.turnIndex, bucket);
    } else {
      unindexedFallback.push(r);
    }
  }

  if (unindexedFallback.length > 0) {
    const idx = maxIndex + 1;
    byTurn.set(idx, unindexedFallback);
    maxIndex = idx;
  }

  const out: TurnDisplay[] = [];
  for (let i = 0; i <= maxIndex; i++) {
    const bucket = byTurn.get(i);
    if (bucket && bucket.length > 0) out.push(buildOne(bucket, i, metaByIndex.get(i)));
  }
  return out;
}

function buildOne(rows: TurnRow[], turnIdx: number, meta?: TurnMeta): TurnDisplay {
  const userPrompts: TurnRow[] = [];
  let finalAnswer: TurnRow | null = null;

  // Find the LAST assistant row whose phase looks final.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role === 'assistant' && isFinalPhase(r.phase)) {
      finalAnswer = r;
      break;
    }
  }
  // Fallback: if no explicit final_answer marker, treat the last assistant
  // row as the final answer. Useful for in-flight turns and legacy shapes.
  if (!finalAnswer) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'assistant') {
        finalAnswer = rows[i];
        break;
      }
    }
  }

  // Collect all userMessages — the first becomes the bubble at the top of
  // the turn, the rest are "steered" messages embedded inside the work.
  for (const r of rows) if (r.role === 'user') userPrompts.push(r);

  // Build intermediate blocks: everything that's NOT the primary user prompt
  // and NOT the final answer.
  const primaryUser = userPrompts[0] ?? null;
  const intermediate: IntermediateBlock[] = [];
  let cmdBuffer: TurnRow[] = [];
  let cmdDuration = 0;

  const flushCommands = () => {
    if (cmdBuffer.length === 0) return;
    intermediate.push({ kind: 'commands-batch', rows: cmdBuffer, durationMs: cmdDuration });
    cmdBuffer = [];
    cmdDuration = 0;
  };

  let toolDurationMs = 0;

  for (const r of rows) {
    if (r === primaryUser) continue;
    if (r === finalAnswer) continue;

    if (r.role === 'tool' && r.toolKind === 'command') {
      cmdBuffer.push(r);
      if (typeof r.durationMs === 'number') {
        cmdDuration += r.durationMs;
        toolDurationMs += r.durationMs;
      }
      continue;
    }
    flushCommands();

    if (r.role === 'tool' && r.toolKind === 'mcp') {
      intermediate.push({ kind: 'tool-call', row: r });
      if (typeof r.durationMs === 'number') toolDurationMs += r.durationMs;
      continue;
    }
    if (r.role === 'tool') {
      // Other tool kinds (file, generic) — render as a single tool-call too.
      intermediate.push({ kind: 'tool-call', row: r });
      if (typeof r.durationMs === 'number') toolDurationMs += r.durationMs;
      continue;
    }
    if (r.role === 'user') {
      intermediate.push({ kind: 'user-steered', row: r });
      continue;
    }
    if (r.role === 'assistant') {
      // Intermediate agentMessage (phase != final_answer)
      intermediate.push({ kind: 'narration', row: r });
      continue;
    }
    if (r.role === 'system' || r.role === 'unknown') {
      intermediate.push({ kind: 'system', row: r });
      continue;
    }
  }
  flushCommands();

  // Prefer wall-clock duration from bridge meta; fall back to tool sum.
  const totalDurationMs = typeof meta?.durationMs === 'number' && meta.durationMs > 0
    ? meta.durationMs
    : toolDurationMs;

  // Aggregate every fileChange row's per-file edits into a single, dedup'd
  // list — last edit to a path wins so the summary always reflects the
  // turn's final state for that file.
  const fileChangesByPath = new Map<string, FileChange>();
  for (const r of rows) {
    if (!r.fileChanges) continue;
    for (const fc of r.fileChanges) {
      fileChangesByPath.set(fc.path, fc);
    }
  }
  const fileChanges = Array.from(fileChangesByPath.values());

  return {
    id: meta?.id ?? rows[0]?.id ?? `turn-${turnIdx}`,
    userPrompts,
    intermediate,
    finalAnswer,
    fileChanges,
    totalDurationMs,
    toolDurationMs,
    status: meta?.status,
  };
}

function isFinalPhase(phase: string | undefined): boolean {
  if (!phase) return false;
  return phase === 'final_answer' || phase === 'final';
}
