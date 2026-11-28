import type { CredentialReader } from './credentials.js';
import type { Api, AnthropicMessagesCompat, Model, ModelThinkingLevel, ThinkingLevelMap } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { summaryEnvelope } from './context.js';
import {
  addsToolsInPlace,
  atModelPath,
  effectiveThinkingLevel,
  independentModelUses,
  modelBudget,
  modelUse,
  supportedThinkingLevels,
  validateMediaInput,
  validateModelConfig,
  type ModelConfig,
  type ModelOwner,
  type ModelSystemConfig,
  type ModelUseSummary,
} from './model-config.js';

const canonicalProviderRank = new Map([
  'anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral', 'moonshotai', 'zai', 'minimax', 'openrouter',
].map((provider, index) => [provider, index]));

/**
 * Only model-intrinsic compat keys are inherited onto custom gateway endpoints.
 * Gateway-dependent flags (mid-conversation tool additions, strict mode, fallback models,
 * routing, long cache retention) stay off unless the operator or probe enables them.
 */
const INTRINSIC_COMPAT_KEYS: Record<string, readonly string[]> = {
  'anthropic-messages': ['forceAdaptiveThinking', 'supportsTemperature'],
  'openai-completions': [
    'supportsStore',
    'supportsDeveloperRole',
    'maxTokensField',
    'requiresToolResultName',
    'requiresAssistantAfterToolResult',
    'requiresThinkingAsText',
    'requiresReasoningContentOnAssistantMessages',
    'thinkingFormat',
    'thinkingTokenBudgetField',
    'supportsThinkingTokenBudget',
    'chatTemplateKwargs',
    'chatTemplateArgs',
    'zaiToolStream',
  ],
  'openai-responses': ['supportsDeveloperRole'],
};

/** False-only intrinsic flags: inherit `false` (model/provider lacks feature), never assume `true` on an unknown gateway. */
const FALSE_ONLY_INHERITED_COMPAT = new Set(['supportsStore', 'supportsDeveloperRole']);

/**
 * Find a built-in Pi catalog model to inherit model-intrinsic metadata from on a custom endpoint.
 * Matches explicit `baseModel` first, otherwise exact `id`, provider-stripped `id` (`provider/id`),
 * or longest catalog-ID prefix followed by a version separator (`-`, `.`, `:`, `@`, `_`).
 */
export function findCatalogTemplate(config: Pick<ModelConfig, 'provider' | 'id' | 'api' | 'baseModel'>): Model<Api> | undefined {
  const catalog = builtinModels();
  const all = catalog.getModels();
  const rank = (candidate: Model<Api>) =>
    (config.api && candidate.api === config.api ? 0 : 100) +
    (candidate.provider === config.provider ? 0 : 20) +
    (canonicalProviderRank.get(candidate.provider) ?? 50);

  if (config.baseModel) {
    const query = config.baseModel.trim();
    const slash = query.indexOf('/');
    if (slash > 0) {
      const direct = catalog.getModel(query.slice(0, slash), query.slice(slash + 1));
      if (direct) return direct;
    }
    const lower = query.toLowerCase();
    const stripped = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
    const matches = all.filter(item => item.id.toLowerCase() === lower || item.id.toLowerCase() === stripped);
    if (matches.length) return matches.sort((a, b) => rank(a) - rank(b))[0];
    throw new Error(`model.baseModel "${config.baseModel}" was not found in the Pi model catalog.`);
  }

  const lower = config.id.trim().toLowerCase();
  const stripped = lower.includes('/') ? lower.slice(lower.lastIndexOf('/') + 1) : lower;
  const exact = all.filter(item => item.id.toLowerCase() === lower || item.id.toLowerCase() === stripped);
  if (exact.length) return exact.sort((a, b) => rank(a) - rank(b))[0];

  const prefix = all.filter(item => {
    const candidateId = item.id.toLowerCase();
    if (candidateId.length < 4) return false;
    for (const target of [lower, stripped]) {
      if (target.startsWith(candidateId) && target.length > candidateId.length && /[-.:@_]/.test(target[candidateId.length]!)) {
        return true;
      }
    }
    return false;
  });
  if (prefix.length) return prefix.sort((a, b) => (b.id.length - a.id.length) || (rank(a) - rank(b)))[0];
  return undefined;
}

function intrinsicCompatFrom(template: Model<Api> | undefined, api: string): Record<string, unknown> | undefined {
  if (!template || template.api !== api || !template.compat) return undefined;
  const allowed = INTRINSIC_COMPAT_KEYS[api];
  if (!allowed?.length) return undefined;
  const source = template.compat as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(source, key) || source[key] === undefined) continue;
    if (FALSE_ONLY_INHERITED_COMPAT.has(key) && source[key] !== false) continue;
    picked[key] = source[key];
  }
  return Object.keys(picked).length ? picked : undefined;
}

/**
 * Custom Google Generative AI reasoning models not yet in Pi's catalog lack `thinkingLevelMap`, so Pi's `off` fallback
 * would otherwise send `thinkingBudget: 0` even for Gemini 3+/4+ models that reject budgets.
 */
function googleThinkingLevelMap(id: string): ThinkingLevelMap | undefined {
  const builtin = builtinModels().getModel('google', id);
  if (builtin?.thinkingLevelMap) return builtin.thinkingLevelMap;
  const lower = id.toLowerCase();
  if (/gemma-?4/.test(lower)) return { off: null, minimal: 'minimal', low: null, medium: null, high: 'high' };
  if (/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(lower) || /gemini-(?:[4-9]|[1-9]\d)/.test(lower) || lower === 'gemini-flash-latest' || lower === 'gemini-flash-lite-latest' || lower === 'gemini-pro-latest') {
    return { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' };
  }
  return undefined;
}

export interface ResolvedModelInfo {
  model: Model<Api>;
  inheritedFrom?: string;
  supportedThinkingLevels: ModelThinkingLevel[];
  effectiveThinkingLevel: ModelThinkingLevel;
}

export function resolveModelWithInfo(config: ModelConfig, options: { requireVision?: boolean } = {}): ResolvedModelInfo {
  const requireVision = options.requireVision ?? true;
  validateModelConfig(config);
  let model: Model<Api> | undefined;
  let inheritedFrom: string | undefined;

  if (config.api) {
    const template = findCatalogTemplate(config);
    if (template) inheritedFrom = `${template.provider}/${template.id}`;
    const sameApiTemplate = template?.api === config.api ? template : undefined;
    const inheritedCompat = intrinsicCompatFrom(template, config.api);
    const mergedCompat = inheritedCompat || config.compat
      ? { ...(inheritedCompat ?? {}), ...(config.compat as Record<string, unknown> | undefined) }
      : undefined;
    const inheritedThinkingMap = config.reasoning
      ? (sameApiTemplate?.thinkingLevelMap ?? (config.api === 'google-generative-ai' ? googleThinkingLevelMap(config.id) : undefined))
      : undefined;
    const thinkingLevelMap = inheritedThinkingMap || config.thinkingLevelMap
      ? { ...(inheritedThinkingMap ?? {}), ...(config.thinkingLevelMap ?? {}) }
      : undefined;
    const samplingParams = sameApiTemplate?.samplingParams || config.samplingParams
      ? { ...(sameApiTemplate?.samplingParams ?? {}), ...(config.samplingParams ?? {}) }
      : undefined;
    model = {
      provider: config.provider, id: config.id, name: config.id,
      api: config.api, baseUrl: config.baseUrl!, input: config.input as Model<Api>['input'],
      contextWindow: config.contextWindow!, maxTokens: config.maxTokens!, reasoning: config.reasoning ?? false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(mergedCompat ? { compat: mergedCompat as Model<Api>['compat'] } : {}),
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(template?.inputLimits ? { inputLimits: template.inputLimits } : {}),
      ...(sameApiTemplate?.promptCache ? { promptCache: sameApiTemplate.promptCache } : {}),
      ...(samplingParams ? { samplingParams } : {}),
      ...(sameApiTemplate?.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: sameApiTemplate.samplingParamsByThinkingLevel } : {}),
      ...(config.headers ? { headers: { ...config.headers } } : {}),
    };
  } else {
    const builtin = builtinModels().getModel(config.provider, config.id);
    if (builtin) {
      const hasOverride = Boolean(config.baseUrl || config.compat || config.headers || config.thinkingLevelMap || config.samplingParams || config.input);
      if (!hasOverride) {
        model = builtin;
      } else {
        model = {
          ...builtin,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
          // Pi's catalog lists text and image alone, so what else a model takes is the operator's to say (ADR-0029).
          ...(config.input ? { input: config.input as Model<Api>['input'] } : {}),
          ...(config.compat ? { compat: { ...(builtin.compat as Record<string, unknown> | undefined), ...(config.compat as Record<string, unknown>) } as Model<Api>['compat'] } : {}),
          ...(config.headers ? { headers: { ...(builtin.headers ?? {}), ...config.headers } } : {}),
          ...(config.thinkingLevelMap ? { thinkingLevelMap: { ...(builtin.thinkingLevelMap ?? {}), ...config.thinkingLevelMap } } : {}),
          ...(config.samplingParams ? { samplingParams: { ...(builtin.samplingParams ?? {}), ...config.samplingParams } } : {}),
        };
      }
    }
  }

  if (!model) throw new Error('The specified model is not in the Pi model catalog; use the models command to check, or configure model.api, baseUrl, input, contextWindow, and maxTokens for a custom model.');
  if (requireVision && !model.input.includes('image')) throw new Error('Image understanding is required; select a model that supports image input.');
  validateMediaInput(model);
  if ((config.thinkingLevel ?? 'off') !== 'off' && !model.reasoning) throw new Error('model.thinkingLevel requires a reasoning model; for a custom model, set model.reasoning to true.');

  return {
    model,
    inheritedFrom,
    supportedThinkingLevels: supportedThinkingLevels(model),
    effectiveThinkingLevel: effectiveThinkingLevel(model, config.thinkingLevel ?? 'off'),
  };
}

export function resolveModel(config: ModelConfig, options?: { requireVision?: boolean }): Model<Api> {
  return resolveModelWithInfo(config, options).model;
}

/**
 * Seldom-used tools are deferred across all resolvable models by default (`deferredTools: 'auto'`) so every model
 * avoids tool bloat and schema-count caps (ADR-0023). Operators can opt into `in-place-only` or `never`.
 * False when the model cannot be resolved; starting with it fails elsewhere, with the reason.
 */
export function loadsToolsOnDemand(config: ModelSystemConfig, owner: ModelOwner): boolean {
  const selected = modelUse(config, owner).thinking;
  const mode = selected.deferredTools ?? 'auto';
  if (mode === 'never') return false;
  try {
    const model = resolveModel(selected);
    if (mode === 'in-place-only') return addsToolsInPlace(model);
    return true;
  } catch { return false; }
}

/** Offline model/capability/budget checks; an optional reader adds credential readiness without disclosing values. */
export function modelReadiness(config: ModelSystemConfig, credential?: CredentialReader) {
  const problems: string[] = [];
  const warnings: string[] = [];
  const uses: ModelUseSummary[] = [];
  for (const owner of ['main', 'review'] as const) {
    const use = modelUse(config, owner);
    let ownerBudget: number | undefined;
    for (const purpose of ['thinking', 'compaction'] as const) {
      const selected = use[purpose];
      const source = purpose === 'thinking' ? use.thinkingSource : use.compactionSource;
      try {
        const resolved = atModelPath(source, () => resolveModelWithInfo(selected, { requireVision: purpose !== 'compaction' }));
        const { model, inheritedFrom } = resolved;
        const contextTokens = purpose === 'thinking' ? use.limits.contextTokens : use.compactionContextTokens;
        const reserve = purpose === 'thinking' ? use.limits.outputReserveTokens : config.compaction.summaryMaxTokens;
        const outputCap = Math.min(model.maxTokens, purpose === 'thinking' ? reserve : reserve - summaryEnvelope(Array(8).fill(`ctx:${'0'.repeat(64)}`)).reserve);
        const requestedLevel = purpose === 'thinking' ? selected.thinkingLevel ?? 'off' : use.compactionThinkingLevel;
        const effectiveLevel = effectiveThinkingLevel(model, requestedLevel);
        const supported = supportedThinkingLevels(model);
        const { window, budget } = modelBudget(model, contextTokens, reserve, config.limits.contextSafetyTokens);
        if (budget <= 0) throw new Error(`window ${window} is too small for output reserve ${reserve} and safety margin ${config.limits.contextSafetyTokens}.`);
        if (purpose === 'thinking') ownerBudget = budget;
        else if (independentModelUses(config)) {
          if (outputCap < 64) throw new Error('summaryMaxTokens must leave at least 64 tokens of content after framing and source references.');
          if (ownerBudget !== undefined && budget < ownerBudget) throw new Error(`summary input budget ${budget} cannot cover the ${owner} input budget ${ownerBudget}; increase compaction.contextTokens or reduce the owner's context window.`);
        }
        if (model.api === 'anthropic-messages' && effectiveLevel !== 'off' && (model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking !== true && outputCap <= 1024) {
          throw new Error('Anthropic budget-based reasoning needs more than 1024 output tokens after any summary framing; increase the reserve or turn reasoning off.');
        }
        if (purpose === 'thinking' && requestedLevel !== effectiveLevel) {
          warnings.push(`${owner} ${purpose}: requested thinkingLevel "${requestedLevel}" is not supported by ${model.id} (supported: ${supported.join(', ')}); effective level will be "${effectiveLevel}".`);
        }
        uses.push({
          owner,
          purpose: purpose === 'compaction' ? 'compaction' : owner === 'main' ? 'thought' : 'review',
          source,
          provider: model.provider,
          id: model.id,
          api: model.api,
          apiKeyEnv: selected.apiKeyEnv,
          contextWindow: window,
          inputBudget: budget,
          thinkingLevel: requestedLevel,
          effectiveThinkingLevel: effectiveLevel,
          supportedThinkingLevels: supported,
          ...(inheritedFrom ? { inheritedFrom } : {}),
          addsToolsInPlace: addsToolsInPlace(model),
        });
      } catch (error) { problems.push(`${owner} ${purpose}: ${error instanceof Error ? error.message : String(error)}`); }
      if (credential && !credential(selected.apiKeyEnv)) problems.push(`${owner} ${purpose}: missing credential ${selected.apiKeyEnv}.`);
    }
  }
  return { uses, problems: [...new Set(problems)], warnings: [...new Set(warnings)] };
}
