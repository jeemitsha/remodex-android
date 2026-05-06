// Fixture-backed tests for thread + turn extraction. Drive these from real
// captured bridge responses (lib/__fixtures__/*.response.json) so we stop
// guessing about JSON-RPC shapes.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractThreads, extractTurns } from './extract';

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
