import { describe, expect, it } from 'vitest';

import {
  INITIAL_COMPOSER_STATE,
  MAX_ATTACHMENTS_PER_TURN,
  composerReducer,
  isComposerSendable,
  remainingAttachmentSlots,
} from './composer-state';

describe('composerReducer', () => {
  it('updates text and is reference-stable when value is unchanged', () => {
    const a = composerReducer(INITIAL_COMPOSER_STATE, { type: 'set-text', text: 'hello' });
    expect(a.text).toBe('hello');
    const b = composerReducer(a, { type: 'set-text', text: 'hello' });
    expect(b).toBe(a);
  });

  it('appends attachments while honoring MAX_ATTACHMENTS_PER_TURN', () => {
    const items = Array.from({ length: MAX_ATTACHMENTS_PER_TURN + 3 }, (_, i) => ({
      id: `a${i}`,
      uri: `file:///img${i}.png`,
    }));
    const out = composerReducer(INITIAL_COMPOSER_STATE, { type: 'add-attachments', items });
    expect(out.attachments).toHaveLength(MAX_ATTACHMENTS_PER_TURN);
    expect(out.attachments[0].id).toBe('a0');
  });

  it('does not mutate when adding an empty list', () => {
    const out = composerReducer(INITIAL_COMPOSER_STATE, { type: 'add-attachments', items: [] });
    expect(out).toBe(INITIAL_COMPOSER_STATE);
  });

  it('removes a specific attachment by id', () => {
    const seeded = composerReducer(INITIAL_COMPOSER_STATE, {
      type: 'add-attachments',
      items: [
        { id: 'x', uri: 'file:///x.png' },
        { id: 'y', uri: 'file:///y.png' },
      ],
    });
    const out = composerReducer(seeded, { type: 'remove-attachment', id: 'x' });
    expect(out.attachments.map((a) => a.id)).toEqual(['y']);
  });

  it('clears all attachments', () => {
    const seeded = composerReducer(INITIAL_COMPOSER_STATE, {
      type: 'add-attachments',
      items: [{ id: 'x', uri: 'file:///x.png' }],
    });
    const out = composerReducer(seeded, { type: 'clear-attachments' });
    expect(out.attachments).toEqual([]);
  });

  it('toggles plan-armed without churn when value matches', () => {
    const a = composerReducer(INITIAL_COMPOSER_STATE, { type: 'set-plan-armed', armed: true });
    const b = composerReducer(a, { type: 'set-plan-armed', armed: true });
    expect(a.planArmed).toBe(true);
    expect(b).toBe(a);
  });

  it('reset returns to initial state', () => {
    const dirty = composerReducer(INITIAL_COMPOSER_STATE, { type: 'set-text', text: 'wip' });
    expect(composerReducer(dirty, { type: 'reset' })).toEqual(INITIAL_COMPOSER_STATE);
  });
});

describe('isComposerSendable', () => {
  it('false when text is whitespace and no attachments', () => {
    expect(isComposerSendable({ ...INITIAL_COMPOSER_STATE, text: '   \n\t' })).toBe(false);
  });

  it('true with non-empty text', () => {
    expect(isComposerSendable({ ...INITIAL_COMPOSER_STATE, text: 'hi' })).toBe(true);
  });

  it('true with attachments even if text is empty', () => {
    expect(
      isComposerSendable({
        ...INITIAL_COMPOSER_STATE,
        attachments: [{ id: 'a', uri: 'file:///a.png' }],
      }),
    ).toBe(true);
  });
});

describe('remainingAttachmentSlots', () => {
  it('reports MAX when empty', () => {
    expect(remainingAttachmentSlots(INITIAL_COMPOSER_STATE)).toBe(MAX_ATTACHMENTS_PER_TURN);
  });

  it('decrements as attachments are added', () => {
    const seeded = composerReducer(INITIAL_COMPOSER_STATE, {
      type: 'add-attachments',
      items: [
        { id: 'a', uri: 'file:///a.png' },
        { id: 'b', uri: 'file:///b.png' },
      ],
    });
    expect(remainingAttachmentSlots(seeded)).toBe(MAX_ATTACHMENTS_PER_TURN - 2);
  });
});
