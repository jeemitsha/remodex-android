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

export type TurnRow = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'approval' | 'unknown';
  text: string;
  status?: string;
  createdAt?: number;
  raw: unknown;

  // tool-call extras (role === 'tool')
  command?: string;
  toolStatus?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  cwd?: string;

  // approval extras (role === 'approval')
  approvalRequestId?: number | string;
  approvalMethod?: string;
  approvalCommand?: string;
  approvalReason?: string;
  approvalDecision?: 'accept' | 'reject';
};

// ---------- threads ----------

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
  const rows: TurnRow[] = [];
  for (const t of list) {
    if (!isRecord(t)) continue;
    const turnId = pickString(t.id, t.turnId) || `turn-${rows.length}`;
    const items = Array.isArray(t.items) ? t.items : [];
    if (items.length === 0) {
      rows.push(...flatTurnRows(turnId, t));
      continue;
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!isRecord(item)) continue;
      const row = itemToTurnRow(turnId, i, item);
      if (row) rows.push(row);
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
      return { ...mkRow(itemId, 'assistant', text, item), status: phase };
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
      const command = pickString(item.path, item.summary) || '(file change)';
      const status = pickString(item.status);
      return {
        ...mkRow(itemId, 'tool', command, item),
        command,
        toolStatus: status,
      };
    }

    case 'toolCall':
    case 'tool_call':
    case 'mcpToolCall':
    case 'mcp_tool_call': {
      const command = pickString(item.name, item.tool, item.toolName) || '(tool call)';
      const status = pickString(item.status);
      const output = pickString(item.aggregatedOutput, item.output, item.text);
      return {
        ...mkRow(itemId, 'tool', command, item),
        command,
        toolStatus: status,
        output,
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
