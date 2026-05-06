// Permissive but correct extractors for the bridge's `thread/list` and
// `thread/turns/list` JSON-RPC responses. Driven by real captured fixtures
// (see lib/protocol/extract.test.ts) so we don't guess at field names.
//
// Upstream shape highlights (verified against a live bridge):
//
// thread/list → result.data[]:
//   {
//     id, name, preview, cwd, source, status: { type: "notLoaded" | "running" | ... },
//     createdAt, updatedAt           // SECONDS since epoch (not ms),
//     gitInfo: { branch, sha, originUrl }, modelProvider, ...
//   }
//
// thread/turns/list → result.data[]:
//   {
//     id,                            // turn id
//     items: [
//       { type: "userMessage", content: [{ type: "text", text }] },
//       { type: "agentMessage", text, phase },             // text is top-level
//       { type: "commandExecution", command, cwd, status, aggregatedOutput, exitCode, durationMs },
//       // potentially: reasoning, fileChange, plan, toolCall, ...
//     ],
//   }

export type ThreadRow = {
  id: string;
  title?: string;
  preview?: string;
  status?: string;
  cwd?: string;
  source?: string;
  branch?: string;
  createdAt?: number; // ms since epoch (normalized from seconds)
  updatedAt?: number;
};

// One file edit returned inside a fileChange item's `changes[]` array.
export type FileChange = {
  path: string;
  // 'update' (default), 'add', 'delete', 'rename', etc.
  kind: string;
  // Unified diff text (may be empty if the bridge omits the patch).
  diff: string;
  additions: number;
  deletions: number;
};

export type TurnRow = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'approval' | 'unknown';
  text: string;
  status?: string;
  // Which Codex turn this row came from (chronologically — 0 = oldest).
  // Set by extractTurns; used by lib/turn-display.ts to wrap intermediate
  // items in a "Worked for" container.
  turnIndex?: number;
  // For agentMessage: the agent phase (`commentary` for intermediate
  // narration, `final_answer` for the actual response, plus the iOS-only
  // `reasoning`/etc). For tool rows: undefined.
  phase?: string;
  // For mcpToolCall rows: which MCP server.tool was used. Used so the UI
  // can render "Used Gmail" badges alongside command batches.
  toolKind?: 'command' | 'mcp' | 'file' | 'other';
  toolServer?: string;
  toolName?: string;
  createdAt?: number;
  raw: unknown;

  // tool-call extras (role === 'tool')
  command?: string;
  toolStatus?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  cwd?: string;

  // fileChange extras (toolKind === 'file'): one row may contain multiple
  // file edits when the bridge batches them. Each entry has the unified
  // diff text + per-file additions/deletions counts so the UI can render
  // a compact summary card.
  fileChanges?: FileChange[];

  // approval extras (role === 'approval')
  approvalRequestId?: number | string;
  approvalMethod?: string;
  approvalCommand?: string;
  approvalReason?: string;
  approvalDecision?: 'accept' | 'reject';
};

// ---------- threads ----------

// Per-turn metadata extracted alongside the flat row list. Used by
// lib/turn-display.ts to render the iOS-style "Worked for X" wall-clock
// duration (sum of tool durations is much shorter than reality — e.g. a 2m 39s
// turn has only ~43s of actual tool execution; the rest is thinking).
export type TurnMeta = {
  id: string;
  turnIndex: number;
  startedAt?: number; // ms epoch
  completedAt?: number; // ms epoch
  durationMs?: number; // wall-clock from the bridge
  status?: string;
  error?: string;
};

export function extractTurnMeta(result: unknown): TurnMeta[] {
  const list = pickArray(result, ['data', 'items', 'turns']);
  const ordered = list.slice().reverse();
  const out: TurnMeta[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i];
    if (!isRecord(t)) continue;
    out.push({
      id: pickString(t.id, t.turnId) || `turn-${i}`,
      turnIndex: i,
      startedAt: normalizeTimestamp(t.startedAt),
      completedAt: normalizeTimestamp(t.completedAt),
      durationMs: typeof t.durationMs === 'number' ? t.durationMs : undefined,
      status: pickString(isRecord(t.status) ? t.status.type : t.status),
      error: typeof t.error === 'string' ? t.error : undefined,
    });
  }
  return out;
}

// Pulls the next-page cursor out of a thread/turns/list (or thread/list)
// response. Bridges have shipped both `nextCursor` and `next_cursor`. Returns
// null when there are no more pages — paging stops on null/undefined/"".
export function extractNextCursor(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  for (const key of ['nextCursor', 'next_cursor'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
    // Some bridges nest cursor objects { cursor: { value: "..." } } — keep
    // tolerance loose.
    if (v && typeof v === 'object') {
      const nested = (v as Record<string, unknown>).value;
      if (typeof nested === 'string' && nested.length > 0) return nested;
    }
  }
  return null;
}

export function extractThreads(result: unknown): ThreadRow[] {
  const list = pickArray(result, ['data', 'items', 'threads']);
  return list.map(toThreadRow).filter((t): t is ThreadRow => !!t);
}

function toThreadRow(value: unknown): ThreadRow | null {
  if (!isRecord(value)) return null;
  const id = pickString(value.id, value.threadId);
  if (!id) return null;
  return {
    id,
    title: pickString(value.name, value.title),
    preview: pickString(value.preview, value.summary),
    status: extractThreadStatus(value.status),
    cwd: pickString(value.cwd, value.workingDirectory),
    source: pickString(value.source),
    branch: extractBranch(value.gitInfo),
    createdAt: normalizeTimestamp(value.createdAt),
    updatedAt: normalizeTimestamp(value.updatedAt),
  };
}

function extractThreadStatus(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.type === 'string') return value.type;
  return undefined;
}

function extractBranch(gitInfo: unknown): string | undefined {
  if (!isRecord(gitInfo)) return undefined;
  return typeof gitInfo.branch === 'string' ? gitInfo.branch : undefined;
}

// ---------- turns ----------

export function extractTurns(result: unknown): TurnRow[] {
  const list = pickArray(result, ['data', 'items', 'turns']);
  // The bridge returns thread/turns/list with sortDirection=desc — newest turn
  // first. For a chat UI we want chronological top-to-bottom, so reverse the
  // outer turn order. Items inside each turn are already chronological.
  const ordered = list.slice().reverse();
  const rows: TurnRow[] = [];
  for (let turnIndex = 0; turnIndex < ordered.length; turnIndex++) {
    const t = ordered[turnIndex];
    if (!isRecord(t)) continue;
    const turnId = pickString(t.id, t.turnId) || `turn-${rows.length}`;
    const items = Array.isArray(t.items) ? t.items : [];
    if (items.length === 0) {
      const flat = flatTurnRows(turnId, t).map((r) => ({ ...r, turnIndex }));
      rows.push(...flat);
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isRecord(item)) continue;
      const row = itemToTurnRow(turnId, i, item);
      if (row) rows.push({ ...row, turnIndex });
    }
  }
  return rows;
}

function itemToTurnRow(turnId: string, index: number, item: Record<string, unknown>): TurnRow | null {
  const itemId = pickString(item.id, item.itemId) || `${turnId}-item-${index}`;
  const type = pickString(item.type);

  switch (type) {
    case 'userMessage':
    case 'user_message': {
      const text = textFromContent(item.content) || pickString(item.text);
      return mkRow(itemId, 'user', text, item);
    }

    case 'agentMessage':
    case 'agent_message':
    case 'assistantMessage':
    case 'assistant_message': {
      const text = pickString(item.text) || textFromContent(item.content);
      const phase = pickString(item.phase);
      return { ...mkRow(itemId, 'assistant', text, item), status: phase, phase };
    }

    case 'reasoning':
    case 'reasoning_summary': {
      const text = textFromContent(item.content) || pickString(item.text, item.summary);
      return mkRow(itemId, 'system', text || '(reasoning)', item);
    }

    case 'commandExecution':
    case 'command_execution': {
      const command = pickString(item.command);
      const status = pickString(item.status);
      const output = pickString(item.aggregatedOutput, item.output);
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : undefined;
      const durationMs = typeof item.durationMs === 'number' ? item.durationMs : undefined;
      const cwd = pickString(item.cwd);
      return {
        ...mkRow(itemId, 'tool', command || '(command)', item),
        toolKind: 'command',
        command,
        toolStatus: status,
        exitCode,
        durationMs,
        output,
        cwd,
      };
    }

    case 'fileChange':
    case 'file_change':
    case 'patch': {
      const status = pickString(item.status);
      const fileChanges = decodeFileChanges(item.changes);
      // Single-file legacy shape: top-level path + diff fields.
      if (fileChanges.length === 0) {
        const path = pickString(item.path, item.file, item.filePath) || '';
        const diff = pickString(item.diff, item.unified_diff, item.unifiedDiff, item.patch) || '';
        if (path || diff) {
          fileChanges.push({
            path: path || '(unknown file)',
            kind: pickString(item.kind, item.action) || 'update',
            diff,
            ...computeDiffTotals(diff),
          });
        }
      }
      const summary = fileChanges.length === 0
        ? '(file change)'
        : fileChanges.length === 1
          ? fileChanges[0].path
          : `${fileChanges.length} files changed`;
      return {
        ...mkRow(itemId, 'tool', summary, item),
        toolKind: 'file',
        command: summary,
        toolStatus: status,
        fileChanges,
      };
    }

    case 'toolCall':
    case 'tool_call':
    case 'mcpToolCall':
    case 'mcp_tool_call': {
      const server = pickString(item.server);
      const tool = pickString(item.tool, item.toolName, item.name);
      const command = server && tool ? `${server}.${tool}` : tool || server || '(tool call)';
      const status = pickString(item.status);
      const args = isRecord(item.arguments) ? item.arguments : null;
      const argsText = args ? JSON.stringify(args, null, 2) : '';
      let output = '';
      if (typeof item.result === 'string') output = item.result;
      else if (item.result !== null && item.result !== undefined) {
        try {
          output = JSON.stringify(item.result, null, 2);
        } catch {
          output = String(item.result);
        }
      }
      if (item.error) {
        const err = typeof item.error === 'string' ? item.error : JSON.stringify(item.error);
        output = output ? `${output}\n\n[error] ${err}` : `[error] ${err}`;
      }
      const durationMs = typeof item.durationMs === 'number' ? item.durationMs : undefined;
      return {
        ...mkRow(itemId, 'tool', command, item),
        toolKind: 'mcp',
        toolServer: server,
        toolName: tool,
        command,
        toolStatus: status,
        output: output || argsText,
        durationMs,
      };
    }

    default: {
      const fallback = pickString(item.text) || textFromContent(item.content) || `[${type ?? 'item'}]`;
      return mkRow(itemId, 'system', fallback, item);
    }
  }
}

function flatTurnRows(turnId: string, t: Record<string, unknown>): TurnRow[] {
  const rows: TurnRow[] = [];
  const userText =
    pickString(t.userInput, t.input, t.prompt, t.user) ||
    textFromContent(t.userInput) ||
    textFromContent(t.input);
  const assistantText =
    pickString(t.assistantOutput, t.output, t.response, t.assistant, t.text) ||
    textFromContent(t.assistantOutput) ||
    textFromContent(t.output);
  if (userText) rows.push(mkRow(`${turnId}-u`, 'user', userText, t));
  if (assistantText) rows.push(mkRow(`${turnId}-a`, 'assistant', assistantText, t));
  return rows;
}

function mkRow(id: string, role: TurnRow['role'], text: string, raw: unknown): TurnRow {
  return { id, role, text: text || '', raw };
}

// ---------- helpers ----------

function pickString(...candidates: unknown[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c;
  }
  return '';
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      chunks.push(part);
    } else if (isRecord(part)) {
      const t = pickString(part.text, part.value);
      if (t) chunks.push(t);
    }
  }
  return chunks.join('\n');
}

function pickArray(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const k of keys) {
    if (Array.isArray(value[k])) return value[k] as unknown[];
  }
  return [];
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------- file changes ----------

// Mirrors iOS decodeFileChangeEntries: accepts either an array of change
// objects or an object map keyed by path. Tolerates the various spellings
// the bridge has shipped (kind / action / diff / unified_diff / additions /
// lines_added / etc.).
export function decodeFileChanges(raw: unknown): FileChange[] {
  if (!raw) return [];
  let objects: Record<string, unknown>[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (isRecord(v)) objects.push(v);
    }
  } else if (isRecord(raw)) {
    for (const key of Object.keys(raw).sort()) {
      const inner = raw[key];
      if (!isRecord(inner)) continue;
      const cloned = { ...inner };
      if (cloned.path === undefined) cloned.path = key;
      objects.push(cloned);
    }
  }

  return objects.map(decodeOneFileChange).filter((c): c is FileChange => c !== null);
}

function decodeOneFileChange(obj: Record<string, unknown>): FileChange | null {
  const path = pickString(obj.path, obj.file, obj.file_path, obj.filePath);
  const kind = decodeFileChangeKind(obj);
  const diff = pickString(
    obj.diff,
    obj.unified_diff,
    obj.unifiedDiff,
    obj.patch,
    obj.delta,
  ).trim();
  const totals = decodeFileChangeTotals(obj) ?? computeDiffTotals(diff);
  if (!path && !diff) return null;
  return {
    path: path || '(unknown file)',
    kind: kind || 'update',
    diff,
    additions: totals.additions,
    deletions: totals.deletions,
  };
}

function decodeFileChangeKind(obj: Record<string, unknown>): string {
  if (typeof obj.kind === 'string' && obj.kind.trim()) return obj.kind.trim();
  if (typeof obj.action === 'string' && obj.action.trim()) return obj.action.trim();
  if (isRecord(obj.kind) && typeof obj.kind.type === 'string') return obj.kind.type;
  if (typeof obj.type === 'string' && obj.type.trim()) return obj.type.trim();
  return '';
}

function decodeFileChangeTotals(
  obj: Record<string, unknown>,
): { additions: number; deletions: number } | null {
  const additions = pickFirstInt(obj, [
    'additions', 'lines_added', 'line_additions', 'lineAdditions', 'added',
    'insertions', 'inserted', 'num_added',
  ]);
  const deletions = pickFirstInt(obj, [
    'deletions', 'lines_deleted', 'line_deletions', 'lineDeletions', 'removed',
    'deleted', 'num_deleted', 'num_removed',
  ]);
  if (additions === null && deletions === null) return null;
  return { additions: additions ?? 0, deletions: deletions ?? 0 };
}

// Counts +/- lines from a unified-diff string, ignoring the `+++ ` / `--- `
// file-header lines. Used as the fallback when the bridge doesn't ship
// pre-computed totals.
export function computeDiffTotals(diff: string): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

function pickFirstInt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.floor(n);
    }
  }
  return null;
}
