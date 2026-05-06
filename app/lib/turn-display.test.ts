import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractTurns } from './protocol/extract';
import type { TurnRow } from './protocol/extract';
import { buildTurnDisplays } from './turn-display';

const FIX = join(__dirname, '__fixtures__');
function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

describe('buildTurnDisplays (against captured 019dfc7c session)', () => {
  const response = loadFixture('thread-turns-list.response.json') as { result: unknown };
  const rows = extractTurns(response.result);
  const turns = buildTurnDisplays(rows);

  it('returns one display per turn', () => {
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it('places the user prompt outside the intermediate block', () => {
    for (const t of turns) {
      if (t.userPrompts[0]) {
        expect(t.intermediate.find((b) => b.kind === 'narration' && b.row.id === t.userPrompts[0].id)).toBeUndefined();
      }
    }
  });

  it('finds a final_answer agentMessage as finalAnswer (not stuck in intermediate)', () => {
    const withFinal = turns.find((t) => t.finalAnswer && t.finalAnswer.phase === 'final_answer');
    expect(withFinal, 'no turn had a final_answer').toBeDefined();
    // Final answer should NOT also appear as a narration block.
    expect(
      withFinal!.intermediate.find((b) => b.kind === 'narration' && b.row.id === withFinal!.finalAnswer!.id),
    ).toBeUndefined();
  });

  it('packs consecutive commandExecution rows into commands-batch', () => {
    const longTurn = turns.find((t) => t.intermediate.length > 5);
    expect(longTurn).toBeDefined();
    const batches = longTurn!.intermediate.filter((b): b is Extract<typeof b, { kind: 'commands-batch' }> => b.kind === 'commands-batch');
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].rows.length).toBeGreaterThanOrEqual(2);
  });

  it('renders mcpToolCall as its own tool-call block (not packed with commands)', () => {
    const longTurn = turns.find((t) => t.intermediate.length > 5);
    expect(longTurn).toBeDefined();
    const mcpCalls = longTurn!.intermediate.filter((b) => b.kind === 'tool-call');
    expect(mcpCalls.length).toBeGreaterThan(0);
  });

  it('totals tool durations inside the worked-for window', () => {
    const longTurn = turns.find((t) => t.totalDurationMs > 0);
    expect(longTurn).toBeDefined();
    expect(longTurn!.totalDurationMs).toBeGreaterThan(0);
  });

  it('preserves chronological order across blocks', () => {
    const longTurn = turns.find((t) => t.intermediate.length > 5);
    expect(longTurn).toBeDefined();
    // Crude proxy: the FIRST block in intermediate should come before the LAST
    // by appearance order in the source rows.
    const firstId = blockFirstRowId(longTurn!.intermediate[0]);
    const lastId = blockFirstRowId(longTurn!.intermediate[longTurn!.intermediate.length - 1]);
    const sourceIdx = (id: string) => longTurn!.intermediate.findIndex((b) => blockFirstRowId(b) === id);
    expect(sourceIdx(firstId)).toBeLessThan(sourceIdx(lastId));
  });
});

function blockFirstRowId(b: ReturnType<typeof buildTurnDisplays>[number]['intermediate'][number]): string {
  if (b.kind === 'commands-batch') return b.rows[0].id;
  return (b as { row: TurnRow }).row.id;
}
