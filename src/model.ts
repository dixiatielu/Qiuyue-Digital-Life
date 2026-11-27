import { environmentCredential, type CredentialReader } from './credentials.js';
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  type Api,
  type CacheRetention,
  type Model,
  type ModelThinkingLevel,
  type OpenAICompletionsCompat,
  type OpenAIResponsesCompat,
  type AnthropicMessagesCompat,
  type SamplingParams,
  type ThinkingBudgets,
  type ThinkingLevelMap,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { GEMINI_INTERACTIONS, geminiInteractionsApi } from './gemini-interactions.js';
import {
  AnthropicMessagesCompatSchema,
  CompatSchemasByApi,
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
} from '@earendil-works/pi-ai/providers/compat-schema';
import { Type, type TObject } from 'typebox';
import { Check } from 'typebox/value';
import { summaryEnvelope } from './context.js';

export interface ModelSystemConfig {
  model: ModelConfig;
  review?: { model?: ModelConfig; limits?: { contextTokens?: number; outputReserveTokens?: number } };
  limits: { contextTokens: number; outputReserveTokens: number; contextSafetyTokens: number };
  compaction: { model?: ModelConfig; contextTokens?: number; summaryMaxTokens: number };
}

const emptyCompatSchema = Type.Object({});
const apis = {
  'openai-completions': { create: openAICompletionsApi, compat: OpenAICompletionsCompatSchema },
  'openai-responses': { create: openAIResponsesApi, compat: OpenAIResponsesCompatSchema },
  'anthropic-messages': { create: anthropicMessagesApi, compat: AnthropicMessagesCompatSchema },
  'google-generative-ai': { create: googleGenerativeAIApi, compat: emptyCompatSchema },
  [GEMINI_INTERACTIONS]: { create: geminiInteractionsApi, compat: emptyCompatSchema },
};
export type CustomApi = keyof typeof apis;
export type DeferredToolsMode = 'auto' | 'always' | 'in-place-only' | 'never';

const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const cacheRetentions: CacheRetention[] = ['none', 'short', 'long'];
const deferredToolsModes: DeferredToolsMode[] = ['auto', 'always', 'in-place-only', 'never'];
const thinkingBudgetKeys = ['minimal', 'low', 'medium', 'high'] as const;

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

export interface ModelConfig {
  provider: string;
  id: string;
  apiKeyEnv: string;
  baseUrl?: string;
  /** An explicit API selects a custom model instead of the built-in catalog. */
  api?: CustomApi;
  /** Optional built-in catalog model ID (or `provider/id`) whose intrinsic metadata is inherited on a custom endpoint. */
  baseModel?: string;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
  /** How much the model thinks before each turn; off unless set, and only a reasoning model can think. */
  thinkingLevel?: ModelThinkingLevel;
  /** Optional per-level overrides for provider thinking-level mapping (`null` marks a level unsupported). */
  thinkingLevelMap?: ThinkingLevelMap;
  /** Optional token budgets for budget-based reasoning providers. */
  thinkingBudgets?: ThinkingBudgets;
  /** Prompt cache retention tier: `none`, `short` (default), or `long`. */
  cacheRetention?: CacheRetention;
  /** Optional extra HTTP headers sent with each model request. */
  headers?: Record<string, string>;
  /** Optional sampling parameters (for example `temperature` or `top_p`). */
  samplingParams?: SamplingParams;
  /** Automatic retries for transient provider errors (429/5xx/network). Defaults to 2. */
  maxRetries?: number;
  /** Maximum backoff delay in ms when honoring `Retry-After`. Defaults to 60000. */
  maxRetryDelayMs?: number;
  /** Seldom-used tool loading policy (ADR-0023): `auto` (default), `always`, `in-place-only`, or `never`. */
  deferredTools?: DeferredToolsMode;
  /** Merge consecutive user messages at the LLM wire boundary for strict role-alternation templates. */
  mergeConsecutiveUsers?: boolean;
}

export type ModelOwner = 'main' | 'review';
export type ModelPath = 'model' | 'review.model' | 'compaction.model';

function compatSchemaForApi(api: string): TObject {
  if (Object.hasOwn(apis, api)) return apis[api as CustomApi].compat as TObject;
  if (Object.hasOwn(CompatSchemasByApi, api)) return CompatSchemasByApi[api as keyof typeof CompatSchemasByApi] as TObject;
  return emptyCompatSchema;
}

/** Valid compat property names for a given API protocol. */
export function compatKeysForApi(api: string): string[] {
  return Object.keys(compatSchemaForApi(api).properties);
}

/** Return only compat entries accepted by the given API protocol (or undefined if empty). */
export function filterCompatForApi(api: string, compat: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!compat || typeof compat !== 'object' || Array.isArray(compat)) return undefined;
  const allowed = new Set(compatKeysForApi(api));
  const filtered = Object.fromEntries(Object.entries(compat).filter(([key]) => allowed.has(key)));
  return Object.keys(filtered).length ? filtered : undefined;
}

function validateCompat(api: string, compat: unknown) {
  const schema = compatSchemaForApi(api);
  if (
    !compat ||
    typeof compat !== 'object' ||
    Array.isArray(compat) ||
    !Check(schema, compat) ||
    Object.keys(compat).some(key => !Object.hasOwn(schema.properties, key))
  ) {
    throw new Error('model.compat contains options incompatible with the selected model.api.');
  }
}

export function supportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}

export function effectiveThinkingLevel(model: Model<Api>, requested: ModelThinkingLevel = 'off'): ModelThinkingLevel {
  return clampThinkingLevel(model, requested);
}

/** Initial Agent thinking level for a model, handling providers where `off` must clamp to a minimum level. */
export function initialThinkingLevel(model: Model<Api>, requested: ModelThinkingLevel = 'off'): ModelThinkingLevel {
  if (!model.reasoning) return requested;
  if (requested !== 'off') return effectiveThinkingLevel(model, requested);
  return model.api === 'anthropic-messages' && model.thinkingLevelMap?.off === null
    ? effectiveThinkingLevel(model, 'off')
    : 'off';
}

/** Attach the tool-loader name for transports that require it (such as Gemini Interactions API, ADR-0023). */
export function withToolLoader<S extends (target: Model<any>, context: any, options?: any) => any>(send: S, toolLoader?: string): S {
  if (!toolLoader) return send;
  return ((target, context, options) => target.api === GEMINI_INTERACTIONS
    ? send(target, context, { ...options, toolLoader })
    : send(target, context, options)) as S;
}

/** Whether consecutive user turns should be merged on the wire for this model. */
export function shouldMergeConsecutiveUsers(config: ModelConfig, model: Model<Api>): boolean {
  if (config.mergeConsecutiveUsers !== undefined) return config.mergeConsecutiveUsers;
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  return compat.requiresAssistantAfterToolResult === true || model.api === 'mistral-conversations';
}

/** Whole-model inheritance and context policies, shared by the brains and management interfaces. */
export function modelUse<T extends ModelSystemConfig>(config: T, owner: ModelOwner) {
  const thinkingSource: ModelPath = owner === 'review' && config.review?.model ? 'review.model' : 'model';
  const thinking = thinkingSource === 'review.model' ? config.review!.model! : config.model;
  const limits = { ...config.limits, ...(owner === 'review' ? config.review?.limits : {}) };
  const compactionSource: ModelPath = config.compaction.model ? 'compaction.model' : thinkingSource;
  return {
    owner, thinking, thinkingSource, limits,
    compaction: config.compaction.model ?? thinking, compactionSource,
    compactionContextTokens: config.compaction.contextTokens ?? limits.contextTokens,
    compactionThinkingLevel: config.compaction.model?.thinkingLevel ?? 'off',
  };
}

export function modelBudget(model: Model<Api>, contextTokens: number, reserve: number, safety: number) {
  const window = Math.min(contextTokens, model.contextWindow);
  return { window, budget: window - reserve - safety };
}

/**
 * Whether a tool can be declared to this model partway through a conversation without rewriting what came before it.
 * Pi's transports advertise this through compat flags, which its catalog sets for capable models and an operator sets
 * for a custom gateway that preserves mid-conversation tool additions.
 */
export function addsToolsInPlace(model: Model<Api>): boolean {
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  if (model.api === GEMINI_INTERACTIONS) return true;
  if (compat.supportsMidConvoSystemMessages !== true) return false;
  return model.api === 'anthropic-messages' ? compat.supportsMidConvoToolChanges === true
    : model.api === 'openai-responses' ? compat.supportsAdditionalTools === true
    : model.api === 'openai-completions' && compat.supportsMidConvoToolAdditions === true;
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

export function modelRoute(model: Model<Api>) { return JSON.stringify([model.provider, model.id, model.api, model.baseUrl]); }

/** Preserve field paths when the same model validator serves several independent configurations. */
export function atModelPath<T>(path: ModelPath, work: () => T): T {
  try { return work(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${message.replace(/\bmodel\./g, `${path}.`)}`);
  }
}

export function independentModelUses(config: ModelSystemConfig) {
  return Boolean(config.review?.model || Object.keys(config.review?.limits ?? {}).length || config.compaction.model || config.compaction.contextTokens !== undefined);
}

export interface ModelUseSummary {
  owner: ModelOwner;
  purpose: 'thought' | 'review' | 'compaction';
  source: ModelPath;
  provider: string;
  id: string;
  api: string;
  apiKeyEnv: string;
  contextWindow: number;
  inputBudget: number;
  thinkingLevel: string;
  effectiveThinkingLevel: ModelThinkingLevel;
  supportedThinkingLevels: ModelThinkingLevel[];
  inheritedFrom?: string;
  addsToolsInPlace: boolean;
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

export function validateModelConfig(config: ModelConfig) {
  for (const field of ['id', 'provider', 'apiKeyEnv'] as const) if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error(`model.${field} must not be empty.`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.apiKeyEnv)) throw new Error('model.apiKeyEnv must be a credential name.');
  if (config.baseUrl !== undefined) {
    if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) throw new Error('model.baseUrl must be a valid HTTP/HTTPS URL.');
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new Error('model.baseUrl must be a valid HTTP/HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('model.baseUrl must be an HTTP/HTTPS URL without credentials, query parameters, or a fragment.');
  }
  if (config.baseModel !== undefined && (typeof config.baseModel !== 'string' || !config.baseModel.trim())) throw new Error('model.baseModel must be a non-empty catalog model ID.');
  if (config.thinkingLevel !== undefined && !thinkingLevels.includes(config.thinkingLevel)) throw new Error(`model.thinkingLevel must be one of ${thinkingLevels.join(', ')}.`);
  if (config.thinkingLevelMap !== undefined) {
    if (!config.thinkingLevelMap || typeof config.thinkingLevelMap !== 'object' || Array.isArray(config.thinkingLevelMap)) throw new Error('model.thinkingLevelMap must be an object.');
    for (const [key, value] of Object.entries(config.thinkingLevelMap)) {
      if (!thinkingLevels.includes(key as ModelThinkingLevel)) throw new Error(`model.thinkingLevelMap contains unknown level "${key}".`);
      if (value !== null && typeof value !== 'string') throw new Error(`model.thinkingLevelMap.${key} must be a string or null.`);
    }
  }
  if (config.thinkingBudgets !== undefined) {
    if (!config.thinkingBudgets || typeof config.thinkingBudgets !== 'object' || Array.isArray(config.thinkingBudgets)) throw new Error('model.thinkingBudgets must be an object.');
    for (const [key, value] of Object.entries(config.thinkingBudgets)) {
      if (!(thinkingBudgetKeys as readonly string[]).includes(key)) throw new Error(`model.thinkingBudgets contains unknown level "${key}".`);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`model.thinkingBudgets.${key} must be a positive integer.`);
    }
  }
  if (config.cacheRetention !== undefined && !cacheRetentions.includes(config.cacheRetention)) throw new Error(`model.cacheRetention must be one of ${cacheRetentions.join(', ')}.`);
  if (config.headers !== undefined) {
    if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers) || Object.entries(config.headers).some(([key, value]) => !key.trim() || typeof value !== 'string')) {
      throw new Error('model.headers must map non-empty header names to strings.');
    }
  }
  if (config.samplingParams !== undefined && (!config.samplingParams || typeof config.samplingParams !== 'object' || Array.isArray(config.samplingParams))) {
    throw new Error('model.samplingParams must be an object.');
  }
  if (config.maxRetries !== undefined && (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10)) {
    throw new Error('model.maxRetries must be an integer between 0 and 10.');
  }
  if (config.maxRetryDelayMs !== undefined && (!Number.isSafeInteger(config.maxRetryDelayMs) || config.maxRetryDelayMs < 0 || config.maxRetryDelayMs > 600_000)) {
    throw new Error('model.maxRetryDelayMs must be an integer between 0 and 600000.');
  }
  if (config.deferredTools !== undefined && !deferredToolsModes.includes(config.deferredTools)) {
    throw new Error(`model.deferredTools must be one of ${deferredToolsModes.join(', ')}.`);
  }
  if (config.mergeConsecutiveUsers !== undefined && typeof config.mergeConsecutiveUsers !== 'boolean') {
    throw new Error('model.mergeConsecutiveUsers must be a boolean.');
  }

  if (config.api === undefined) {
    if (['input', 'contextWindow', 'maxTokens', 'reasoning'].some(key => config[key as keyof ModelConfig] !== undefined)) {
      throw new Error('Custom model capabilities require model.api.');
    }
    if (config.compat !== undefined) {
      const builtin = builtinModels().getModel(config.provider, config.id);
      if (!builtin) throw new Error('Custom model capabilities require model.api.');
      validateCompat(builtin.api, config.compat);
    }
    return;
  }
  if (typeof config.api !== 'string' || !Object.hasOwn(apis, config.api)) throw new Error(`model.api must be one of ${Object.keys(apis).join(', ')}.`);
  if (!config.baseUrl) throw new Error('A custom model requires model.baseUrl.');
  if (!Array.isArray(config.input) || !config.input.includes('text') || config.input.some(value => !['text', 'image'].includes(value))) throw new Error('model.input must be an array of input capabilities containing text and optionally image.');
  for (const key of ['contextWindow', 'maxTokens'] as const) if (!Number.isSafeInteger(config[key]) || config[key]! <= 0) throw new Error(`The custom model field model.${key} must be a positive integer.`);
  if (config.maxTokens! > config.contextWindow!) throw new Error('model.maxTokens cannot exceed model.contextWindow.');
  if (config.reasoning !== undefined && typeof config.reasoning !== 'boolean') throw new Error('model.reasoning must be a boolean.');
  if (config.compat !== undefined) validateCompat(config.api, config.compat);
}

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
      api: config.api, baseUrl: config.baseUrl!, input: config.input!,
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
      const hasOverride = Boolean(config.baseUrl || config.compat || config.headers || config.thinkingLevelMap || config.samplingParams);
      if (!hasOverride) {
        model = builtin;
      } else {
        model = {
          ...builtin,
          ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
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

export function createModelBackend(config: ModelConfig, credential: CredentialReader = environmentCredential, resolveOptions?: { requireVision?: boolean }) {
  const model = resolveModel(config, resolveOptions);
  const models = config.api ? createModels() : builtinModels();
  if (config.api) models.setProvider(createProvider({
    id: config.provider, baseUrl: model.baseUrl, models: [model],
    auth: { apiKey: { name: config.apiKeyEnv, async resolve({ credential: supplied }) { const apiKey = supplied?.key ?? credential(config.apiKeyEnv); return apiKey ? { auth: { apiKey } } : undefined; } } },
    api: apis[config.api].create(),
  }));
  const defaultRetries = config.maxRetries ?? 2;
  const defaultRetryDelayMs = config.maxRetryDelayMs ?? 60_000;
  const defaultCacheRetention = config.cacheRetention ?? 'short';
  const stream: typeof models.streamSimple = (target, context, options) => {
    const apiKey = options?.apiKey ?? credential(config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing credential ${config.apiKeyEnv}.`);
    // Some adapters add a reasoning budget to maxTokens. Keep reasoning inside the caller's total reserve.
    const capped = options?.maxTokens === undefined ? target : { ...target, maxTokens: Math.min(options.maxTokens, target.maxTokens) };
    let reasoning = options?.reasoning;
    if (reasoning !== undefined) {
      const clamped = clampThinkingLevel(capped, reasoning);
      reasoning = clamped === 'off' ? undefined : clamped;
    } else if (capped.api === 'anthropic-messages' && capped.reasoning && capped.thinkingLevelMap?.off === null) {
      const clamped = clampThinkingLevel(capped, 'off');
      if (clamped !== 'off') reasoning = clamped;
    }
    if (capped.api === 'anthropic-messages' && reasoning && (capped.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking !== true && capped.maxTokens <= 1024) {
      throw new Error('Anthropic budget-based reasoning needs more than 1024 output tokens; increase the output reserve or summary limit, or turn reasoning off.');
    }
    const headers = config.headers || options?.headers ? { ...(config.headers ?? {}), ...(options?.headers ?? {}) } : undefined;
    const samplingParams = config.samplingParams || options?.samplingParams ? { ...(config.samplingParams ?? {}), ...(options?.samplingParams ?? {}) } : undefined;
    const thinkingBudgets = config.thinkingBudgets || options?.thinkingBudgets ? { ...(config.thinkingBudgets ?? {}), ...(options?.thinkingBudgets ?? {}) } : undefined;
    return models.streamSimple(capped, context, {
      ...options,
      apiKey,
      reasoning,
      cacheRetention: options?.cacheRetention ?? defaultCacheRetention,
      maxRetries: options?.maxRetries ?? defaultRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs ?? defaultRetryDelayMs,
      ...(headers ? { headers } : {}),
      ...(samplingParams ? { samplingParams } : {}),
      ...(thinkingBudgets ? { thinkingBudgets } : {}),
    });
  };
  return { model, stream };
}
