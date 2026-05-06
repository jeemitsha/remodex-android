// Fixture-backed tests for thread + turn extraction. Drive these from real
// captured bridge responses (lib/__fixtures__/*.response.json) so we stop
// guessing about JSON-RPC shapes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computeDiffTotals,
  decodeFileChanges,
  extractNextCursor,
  extractThreads,
  extractTurns,
} from './extract';

const FIX = join(__dirname, '..', '__fixtures__');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('extractThreads (against captured thread/list response)', () => {
  const response = loadFixture('thread-list.response.json') as { result: unknown };
  const threads = extractThreads(response.result);

  it('returns at least one thread', () => {
    expect(threads.length).toBeGreaterThan(0);
  });

  it('reads the upstream `name` field as the title', () => {
    // The bridge emits `name`, not `title`. Pull from any thread that has it.
    const named = threads.find((t) => !!t.title);
    expect(named, 'no thread has a non-empty title').toBeDefined();
    expect(typeof named!.title).toBe('string');
  });

  it('captures cwd for source-code threads', () => {
    const withCwd = threads.find((t) => !!t.cwd);
    expect(withCwd).toBeDefined();
    expect(withCwd!.cwd!.startsWith('/')).toBe(true);
  });

  it('normalizes status object → string', () => {
    // upstream sends status: { type: "notLoaded" | "running" | ... }
    const withStatus = threads.find((t) => !!t.status);
    expect(withStatus).toBeDefined();
    expect(typeof withStatus!.status).toBe('string');
  });

  it('converts updatedAt seconds → ms', () => {
    const withTs = threads.find((t) => typeof t.updatedAt === 'number');
    expect(withTs).toBeDefined();
    // Real epoch values must be > Jan 1 2024 in ms
    expect(withTs!.updatedAt as number).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('extractNextCursor', () => {
  it('returns null for missing/empty cursors', () => {
    expect(extractNextCursor({})).toBeNull();
    expect(extractNextCursor({ nextCursor: null })).toBeNull();
    expect(extractNextCursor({ nextCursor: '' })).toBeNull();
    expect(extractNextCursor({ next_cursor: '' })).toBeNull();
    expect(extractNextCursor(null)).toBeNull();
  });

  it('returns the cursor string when present', () => {
    expect(extractNextCursor({ nextCursor: 'abc123' })).toBe('abc123');
    expect(extractNextCursor({ next_cursor: 'snake' })).toBe('snake');
  });

  it('handles wrapped cursor objects { value: ... }', () => {
    expect(extractNextCursor({ nextCursor: { value: 'wrapped' } })).toBe('wrapped');
  });
});

describe('extractTurns (against captured thread/turns/list response)', () => {
  const response = loadFixture('thread-turns-list.response.json') as { result: unknown };
  const turns = extractTurns(response.result);

  it('emits at least one turn entry', () => {
    expect(turns.length).toBeGreaterThan(0);
  });

  it('produces a user row from userMessage content[].text', () => {
    const userRow = turns.find((t) => t.role === 'user');
    expect(userRow).toBeDefined();
    expect(userRow!.text.length).toBeGreaterThan(0);
    expect(userRow!.text).not.toMatch(/^\{/); // not raw JSON
  });

  it('produces an assistant row from agentMessage.text', () => {
    const assistant = turns.find((t) => t.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.text.length).toBeGreaterThan(0);
    // The agent's text may itself be structured JSON (e.g. code-review final
    // answer). What matters is the field is the assistant's actual reply, not
    // a serialized item wrapper. Detect that wrapper by checking for known
    // wrapper-only fields.
    expect(assistant!.text).not.toContain('"itemId"');
    expect(assistant!.text).not.toContain('"phase":');
  });

  it('produces tool rows for commandExecution items', () => {
    const tool = turns.find((t) => t.role === 'tool');
    expect(tool).toBeDefined();
    expect(tool!.command).toBeDefined();
    expect(tool!.command!.length).toBeGreaterThan(0);
  });

  it('never falls back to JSON.stringify (= parser hit a known shape)', () => {
    const fallback = turns.find((t) => t.role === 'unknown');
    expect(fallback, 'parser fell back to dumping JSON for some item').toBeUndefined();
  });
});

describe('decodeFileChanges', () => {
  it('parses an array of {path, kind, diff, additions, deletions} entries', () => {
    const out = decodeFileChanges([
      {
        path: 'src/users.service.ts',
        kind: 'update',
        diff: '+++ a/src/users.service.ts\n--- b/src/users.service.ts\n+new\n-old\n',
        additions: 155,
        deletions: 5,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      path: 'src/users.service.ts',
      kind: 'update',
      additions: 155,
      deletions: 5,
    });
    expect(out[0].diff.length).toBeGreaterThan(0);
  });

  it('accepts an object map keyed by path (alternate bridge shape)', () => {
    const out = decodeFileChanges({
      'a.ts': { kind: 'add', diff: '+x', additions: 1, deletions: 0 },
      'b.ts': { kind: 'update', diff: '-y\n+z', additions: 1, deletions: 1 },
    });
    expect(out.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to snake_case fields and `unified_diff` / `patch` aliases', () => {
    const out = decodeFileChanges([
      { file_path: 'x.ts', action: 'add', unified_diff: '+a', lines_added: 1, lines_deleted: 0 },
      { file: 'y.ts', kind: { type: 'delete' }, patch: '-z', deleted: 1 },
    ]);
    expect(out[0]).toMatchObject({ path: 'x.ts', kind: 'add', additions: 1, deletions: 0 });
    expect(out[1]).toMatchObject({ path: 'y.ts', kind: 'delete', additions: 0, deletions: 1 });
  });

  it('infers totals by counting +/- lines when the bridge omits them', () => {
    const out = decodeFileChanges([
      {
        path: 'z.ts',
        diff: '--- a/z.ts\n+++ b/z.ts\n-old line\n+new line\n+another new line\n',
      },
    ]);
    expect(out[0].additions).toBe(2);
    expect(out[0].deletions).toBe(1);
  });

  it('drops entries with neither path nor diff', () => {
    const out = decodeFileChanges([{ kind: 'update' }, { path: 'a.ts' }]);
    expect(out.map((c) => c.path)).toEqual(['a.ts']);
  });
});

describe('computeDiffTotals', () => {
  it('ignores the +++ / --- file headers', () => {
    const totals = computeDiffTotals('--- a/foo\n+++ b/foo\n-removed\n+added\n+added2\n');
    expect(totals).toEqual({ additions: 2, deletions: 1 });
  });

  it('returns zeros for empty input', () => {
    expect(computeDiffTotals('')).toEqual({ additions: 0, deletions: 0 });
  });
});
