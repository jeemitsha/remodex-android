// Runtime config: parses the `model/list` JSON-RPC response and computes the
// compact bottom-bar label iOS shows ("5.5 High"). Wire-format reference:
//   - iOS CodexService+RuntimeConfig.swift::listModels()
//   - iOS CodexModelOption.swift (camelCase + snake_case key tolerance)
//   - iOS CodexReasoningEffortOption.swift
//
// Method:  model/list
// Params:  { cursor: null, limit: 50, includeHidden: false }
// Result:  { items|data|models: ModelOption[] }

export type ReasoningEffortOption = {
  // "low" | "medium" | "high" | ... — the wire string. Don't title-case here.
  reasoningEffort: string;
  description?: string;
};

export type ModelOption = {
  id: string;
  // The actual model identifier sent to turn/start (e.g. "gpt-5.5"). Distinct
  // from `id` only when the bridge gives them as separate fields.
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportsFastMode: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string | null;
};

export type ServiceTier = 'fast';

// Compact representation of the user's runtime selection. Mirrors the iOS
// per-thread overrides record minus the persistence layer — we keep it in
// memory until persistRuntimeSelections-equivalent lands.
export type RuntimeSelection = {
  modelId: string | null;
  reasoningEffort: string | null;
  serviceTier: ServiceTier | null;
};

const REASONING_TITLE_OVERRIDES: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  extrahigh: 'Extra High',
  extra_high: 'Extra High',
  'extra-high': 'Extra High',
  minimal: 'Minimal',
};

// Models with these ids/names get pinned to the top of the picker, mirroring
// iOS featuredModelOptions. The currently-selected model is also pinned even
// if it's not in this set.
export const FEATURED_MODEL_IDS = new Set(['gpt-5.5', 'gpt-5.4']);

// Static fast-mode fallback when the bridge omits explicit metadata. Mirrors
// CodexModelCapabilityResolver.staticFastModeModelIdentifiers in iOS.
const STATIC_FAST_MODE_IDS = new Set([
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.2-codex',
  'gpt-5.2',
]);

export function extractModels(result: unknown): ModelOption[] {
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const raw = (Array.isArray(obj.items) ? obj.items
    : Array.isArray(obj.data) ? obj.data
    : Array.isArray(obj.models) ? obj.models
    : []) as unknown[];

  const out: ModelOption[] = [];
  for (const item of raw) {
    const m = decodeModel(item);
    if (m) out.push(m);
  }
  return out;
}

function decodeModel(raw: unknown): ModelOption | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const model = (pickString(r, 'model') ?? pickString(r, 'slug') ?? pickString(r, 'id') ?? '').trim();
  const id = (pickString(r, 'id') ?? pickString(r, 'slug') ?? model).trim();
  if (!id && !model) return null;

  const displayName = (
    pickString(r, 'displayName') ?? pickString(r, 'display_name') ?? pickString(r, 'name') ?? model
  ).trim();
  const description = (pickString(r, 'description') ?? '').trim();
  const isDefault = pickBool(r, 'isDefault') ?? pickBool(r, 'is_default') ?? false;

  const efforts = decodeReasoningEfforts(
    r.supportedReasoningEfforts ?? r['supported_reasoning_efforts'],
  );
  const defaultEffortRaw = pickString(r, 'defaultReasoningEffort')
    ?? pickString(r, 'default_reasoning_effort')
    ?? null;
  const defaultReasoningEffort = defaultEffortRaw && defaultEffortRaw.trim().length > 0
    ? defaultEffortRaw.trim()
    : null;

  const explicitFastMode =
    pickBool(r, 'supportsFastMode')
    ?? pickBool(r, 'supports_fast_mode')
    ?? pickBool(r, 'fastMode')
    ?? pickBool(r, 'fast_mode')
    ?? pickBool(r, 'fastServiceTier')
    ?? pickBool(r, 'fast_service_tier')
    ?? null;
  const additionalSpeedTiers = pickStringArray(r, 'additionalSpeedTiers')
    .concat(pickStringArray(r, 'additional_speed_tiers'));
  const supportsFastMode = resolveFastMode({
    id, model, explicitFastMode, additionalSpeedTiers,
  });

  return {
    id: id || model,
    model: model || id,
    displayName: displayName || model || id,
    description,
    isDefault,
    supportsFastMode,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort,
  };
}

function decodeReasoningEfforts(raw: unknown): ReasoningEffortOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningEffortOption[] = [];
  for (const e of raw) {
    if (typeof e === 'string') {
      const trimmed = e.trim();
      if (trimmed) out.push({ reasoningEffort: trimmed });
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const effort = (
      pickString(r, 'reasoningEffort')
      ?? pickString(r, 'reasoning_effort')
      ?? pickString(r, 'value')
      ?? ''
    ).trim();
    if (!effort) continue;
    const description = (
      pickString(r, 'description') ?? pickString(r, 'label') ?? ''
    ).trim();
    out.push({ reasoningEffort: effort, description: description || undefined });
  }
  return out;
}

function resolveFastMode(input: {
  id: string;
  model: string;
  explicitFastMode: boolean | null;
  additionalSpeedTiers: string[];
}): boolean {
  if (input.explicitFastMode !== null) return input.explicitFastMode;
  for (const tier of input.additionalSpeedTiers) {
    if (tier.trim().toLowerCase() === 'fast') return true;
  }
  if (STATIC_FAST_MODE_IDS.has(input.id.toLowerCase())) return true;
  if (STATIC_FAST_MODE_IDS.has(input.model.toLowerCase())) return true;
  return false;
}

// Picks the iOS-style featured-models list: pinned IDs first, plus the
// currently-selected model even if it's not pinned.
export function featuredModelOptions(
  models: ModelOption[],
  selectedModelId: string | null,
): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of models) {
    const idLower = m.id.toLowerCase();
    const modelLower = m.model.toLowerCase();
    if (FEATURED_MODEL_IDS.has(idLower) || FEATURED_MODEL_IDS.has(modelLower)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  if (selectedModelId) {
    const sel = models.find((m) => m.id === selectedModelId);
    if (sel && !seen.has(sel.id)) {
      seen.add(sel.id);
      out.push(sel);
    }
  }
  return out;
}

export function hasNonFeaturedModels(
  models: ModelOption[],
  selectedModelId: string | null,
): boolean {
  const featured = new Set(featuredModelOptions(models, selectedModelId).map((m) => m.id));
  return models.some((m) => !featured.has(m.id));
}

// Resolves a model option from a selection id, with the same fallback chain
// iOS uses (gpt-5.5 preferred, then isDefault, then first).
export function selectedModelOption(
  models: ModelOption[],
  selection: RuntimeSelection,
): ModelOption | null {
  if (models.length === 0) return null;
  if (selection.modelId) {
    const direct = models.find((m) => m.id === selection.modelId || m.model === selection.modelId);
    if (direct) return direct;
  }
  const preferred = models.find(
    (m) => m.id.toLowerCase() === 'gpt-5.5' || m.model.toLowerCase() === 'gpt-5.5',
  );
  if (preferred) return preferred;
  const def = models.find((m) => m.isDefault);
  if (def) return def;
  return models[0];
}

// Display text for the small bottom-bar pill: "5.5 High". Falls back to
// "Default" when models are still loading or none are present.
export function compactRuntimeLabel(
  models: ModelOption[],
  selection: RuntimeSelection,
): string {
  if (models.length === 0) return 'Default';
  const model = selectedModelOption(models, selection);
  if (!model) return 'Default';
  const modelTitle = compactModelTitle(model.displayName || model.model || model.id);
  const effort = effectiveReasoningEffort(model, selection);
  const effortTitle = effort ? reasoningTitle(effort) : '';
  return effortTitle ? `${modelTitle} ${effortTitle}`.trim() : modelTitle;
}

// Strips the common "GPT-" prefix and turns hyphens into spaces, matching
// iOS compactModelTitle. Keeps trailing version qualifiers ("Codex", "Mini")
// intact so the user can still tell variants apart.
export function compactModelTitle(displayName: string): string {
  let s = displayName.trim();
  if (s.toLowerCase().startsWith('gpt-')) s = s.slice('GPT-'.length);
  return s.replace(/-/g, ' ');
}

export function reasoningTitle(effort: string): string {
  const norm = effort.trim().toLowerCase();
  if (REASONING_TITLE_OVERRIDES[norm]) return REASONING_TITLE_OVERRIDES[norm];
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

// Resolves the effort that should be active given a selected model. Uses
// selection.reasoningEffort when supported by the model, else the model's
// defaultReasoningEffort, else "medium" if supported, else first available.
export function effectiveReasoningEffort(
  model: ModelOption | null,
  selection: RuntimeSelection,
): string | null {
  if (!model) return selection.reasoningEffort ?? null;
  const supported = new Set(model.supportedReasoningEfforts.map((e) => e.reasoningEffort));
  if (supported.size === 0) return null;
  if (selection.reasoningEffort && supported.has(selection.reasoningEffort)) {
    return selection.reasoningEffort;
  }
  if (model.defaultReasoningEffort && supported.has(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  if (supported.has('medium')) return 'medium';
  return model.supportedReasoningEfforts[0]?.reasoningEffort ?? null;
}

// Normalizes a service tier to null when the selected model doesn't support it
// — iOS does this to avoid sending fast-mode for models that can't honor it.
export function normalizeServiceTier(
  model: ModelOption | null,
  tier: ServiceTier | null,
): ServiceTier | null {
  if (!tier) return null;
  if (!model) return tier;
  return model.supportsFastMode ? tier : null;
}

function pickString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function pickBool(o: Record<string, unknown>, key: string): boolean | null {
  const v = o[key];
  return typeof v === 'boolean' ? v : null;
}

function pickStringArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}
