import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  compactModelTitle,
  compactRuntimeLabel,
  effectiveReasoningEffort,
  extractModels,
  featuredModelOptions,
  hasNonFeaturedModels,
  normalizeServiceTier,
  reasoningTitle,
  selectedModelOption,
} from './runtime';

const FIX = join(__dirname, '..', '__fixtures__');
const fixture = JSON.parse(readFileSync(join(FIX, 'model-list.response.json'), 'utf8')) as {
  result: unknown;
};

describe('extractModels', () => {
  const models = extractModels(fixture.result);

  it('decodes all four models from the captured shape', () => {
    expect(models.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o']);
  });

  it('tolerates snake_case fields (gpt-5.4-mini uses supports_fast_mode)', () => {
    const mini = models.find((m) => m.id === 'gpt-5.4-mini')!;
    expect(mini.supportsFastMode).toBe(true);
    expect(mini.defaultReasoningEffort).toBe('low');
    expect(mini.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual(['low', 'medium']);
  });

  it('marks isDefault from the bridge flag', () => {
    expect(models.find((m) => m.id === 'gpt-5.5')!.isDefault).toBe(true);
    expect(models.find((m) => m.id === 'gpt-4o')!.isDefault).toBe(false);
  });

  it('returns [] for missing/empty result', () => {
    expect(extractModels(null)).toEqual([]);
    expect(extractModels({})).toEqual([]);
    expect(extractModels({ items: [] })).toEqual([]);
  });

  it('honors the static fast-mode fallback when the bridge omits the flag', () => {
    const out = extractModels({
      items: [
        { id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' }, // no supportsFastMode
        { id: 'gpt-4o', model: 'gpt-4o', displayName: 'GPT-4o' },
      ],
    });
    expect(out.find((m) => m.id === 'gpt-5.5')!.supportsFastMode).toBe(true);
    expect(out.find((m) => m.id === 'gpt-4o')!.supportsFastMode).toBe(false);
  });

  it('accepts data[] and models[] alternates for the items array', () => {
    const list = [{ id: 'gpt-5.5', model: 'gpt-5.5', displayName: 'GPT-5.5' }];
    expect(extractModels({ data: list }).map((m) => m.id)).toEqual(['gpt-5.5']);
    expect(extractModels({ models: list }).map((m) => m.id)).toEqual(['gpt-5.5']);
  });
});

describe('featuredModelOptions / hasNonFeaturedModels', () => {
  const models = extractModels(fixture.result);

  it('pins gpt-5.5 + gpt-5.4 even when later in the list', () => {
    const featured = featuredModelOptions(models, null);
    expect(featured.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4']);
  });

  it('appends the currently-selected model if not already featured', () => {
    const featured = featuredModelOptions(models, 'gpt-4o');
    expect(featured.map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-4o']);
  });

  it('hasNonFeaturedModels true when there are non-featured options', () => {
    expect(hasNonFeaturedModels(models, null)).toBe(true);
    expect(hasNonFeaturedModels(models, 'gpt-4o')).toBe(true);
  });
});

describe('selectedModelOption / compactRuntimeLabel', () => {
  const models = extractModels(fixture.result);

  it('returns "Default" when no models are loaded', () => {
    expect(compactRuntimeLabel([], { modelId: null, reasoningEffort: null, serviceTier: null })).toBe(
      'Default',
    );
  });

  it('matches the iOS "5.5 Medium" pill label for an empty selection', () => {
    expect(
      compactRuntimeLabel(models, { modelId: null, reasoningEffort: null, serviceTier: null }),
    ).toBe('5.5 Medium');
  });

  it('matches the user-selected reasoning effort', () => {
    expect(
      compactRuntimeLabel(models, { modelId: 'gpt-5.5', reasoningEffort: 'high', serviceTier: null }),
    ).toBe('5.5 High');
  });

  it('falls back to gpt-5.5 when a stale model id is selected', () => {
    const opt = selectedModelOption(models, {
      modelId: 'something-removed',
      reasoningEffort: null,
      serviceTier: null,
    });
    expect(opt!.id).toBe('gpt-5.5');
  });
});

describe('compactModelTitle / reasoningTitle', () => {
  it('strips GPT- prefix and replaces hyphens with spaces', () => {
    expect(compactModelTitle('GPT-5.5')).toBe('5.5');
    expect(compactModelTitle('GPT-5.4-mini')).toBe('5.4 mini');
    expect(compactModelTitle('claude-sonnet')).toBe('claude sonnet');
  });

  it('renders Extra High for extra_high regardless of separator', () => {
    expect(reasoningTitle('extra_high')).toBe('Extra High');
    expect(reasoningTitle('extrahigh')).toBe('Extra High');
    expect(reasoningTitle('extra-high')).toBe('Extra High');
    expect(reasoningTitle('high')).toBe('High');
  });
});

describe('effectiveReasoningEffort', () => {
  const models = extractModels(fixture.result);

  it('returns the selection when supported by the model', () => {
    const m55 = models.find((m) => m.id === 'gpt-5.5')!;
    expect(
      effectiveReasoningEffort(m55, { modelId: null, reasoningEffort: 'high', serviceTier: null }),
    ).toBe('high');
  });

  it('falls back to the model default when the selection is unsupported', () => {
    const mini = models.find((m) => m.id === 'gpt-5.4-mini')!;
    // mini supports only low + medium, default low
    expect(
      effectiveReasoningEffort(mini, { modelId: null, reasoningEffort: 'high', serviceTier: null }),
    ).toBe('low');
  });

  it('returns null when the model has no reasoning options at all', () => {
    const gpt4o = models.find((m) => m.id === 'gpt-4o')!;
    expect(
      effectiveReasoningEffort(gpt4o, { modelId: null, reasoningEffort: 'high', serviceTier: null }),
    ).toBeNull();
  });
});

describe('normalizeServiceTier', () => {
  const models = extractModels(fixture.result);
  const m55 = models.find((m) => m.id === 'gpt-5.5')!;
  const gpt4o = models.find((m) => m.id === 'gpt-4o')!;

  it('returns the tier when the model supports fast mode', () => {
    expect(normalizeServiceTier(m55, 'fast')).toBe('fast');
  });

  it('strips fast tier when the model does not support fast mode', () => {
    expect(normalizeServiceTier(gpt4o, 'fast')).toBeNull();
  });

  it('returns null on null input regardless of model', () => {
    expect(normalizeServiceTier(m55, null)).toBeNull();
  });
});
