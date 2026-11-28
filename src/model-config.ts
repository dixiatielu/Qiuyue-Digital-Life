import {
  clampThinkingLevel,
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
import {
  AnthropicMessagesCompatSchema,
  CompatSchemasByApi,
  OpenAICompletionsCompatSchema,
  OpenAIResponsesCompatSchema,
} from '@earendil-works/pi-ai/providers/compat-schema';
import { Type, type TObject } from 'typebox';
import { Check } from 'typebox/value';
import { GEMINI_INTERACTIONS } from './gemini-interactions.js';
import { INPUT_MODALITIES, MEDIA_MODALITIES, type InputModality, type MediaCarriage, type MediaModality } from './media.js';

export interface ModelSystemConfig {
  model: ModelConfig;
  review?: { model?: ModelConfig; limits?: { contextTokens?: number; outputReserveTokens?: number } };
  limits: { contextTokens: number; outputReserveTokens: number; contextSafetyTokens: number };
  compaction: { model?: ModelConfig; contextTokens?: number; summaryMaxTokens: number };
}

const emptyCompatSchema = Type.Object({});
export const customApiCompatSchemas = {
  'openai-completions': OpenAICompletionsCompatSchema,
  'openai-responses': OpenAIResponsesCompatSchema,
  'anthropic-messages': AnthropicMessagesCompatSchema,
  'google-generative-ai': emptyCompatSchema,
  [GEMINI_INTERACTIONS]: emptyCompatSchema,
} as const;
export type CustomApi = keyof typeof customApiCompatSchemas;
export type DeferredToolsMode = 'auto' | 'always' | 'in-place-only' | 'never';

const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const cacheRetentions: CacheRetention[] = ['none', 'short', 'long'];
const deferredToolsModes: DeferredToolsMode[] = ['auto', 'always', 'in-place-only', 'never'];
const thinkingBudgetKeys = ['minimal', 'low', 'medium', 'high'] as const;

export interface ModelConfig {
  provider: string;
  id: string;
  apiKeyEnv: string;
  baseUrl?: string;
  /** An explicit API selects a custom model instead of the built-in catalog. */
  api?: CustomApi;
  /** Optional built-in catalog model ID (or `provider/id`) whose intrinsic metadata is inherited on a custom endpoint. */
  baseModel?: string;
  /** What the model takes in. Audio, video and PDF are declared for a route where they have been checked (ADR-0029); on a catalog model this replaces the catalog's list. */
  input?: InputModality[];
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

function compatSchemaForApi(api: string): TObject {
  if (Object.hasOwn(customApiCompatSchemas, api)) return customApiCompatSchemas[api as CustomApi] as TObject;
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

export function validateCompat(api: string, compat: unknown) {
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

/** Whether consecutive user turns should be merged on the wire for this model. */
export function shouldMergeConsecutiveUsers(config: ModelConfig, model: Model<Api>): boolean {
  if (config.mergeConsecutiveUsers !== undefined) return config.mergeConsecutiveUsers;
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  return compat.requiresAssistantAfterToolResult === true || model.api === 'mistral-conversations';
}

/**
 * Whether this model strictly requires valid thought signatures on historical function calls
 * (Gemini 3+/4+ and Gemma 4 thinking models on Google's generateContent / Vertex APIs).
 */
export function requiresThoughtSignatures(model: Pick<Model<Api>, 'api' | 'id' | 'reasoning'>): boolean {
  if (!model.reasoning) return false;
  if (model.api !== 'google-generative-ai' && model.api !== 'google-vertex') return false;
  const id = model.id.toLowerCase();
  return /gemini(?:-live)?-(?:[3-9]|[1-9]\d)/.test(id)
    || id === 'gemini-flash-latest'
    || id === 'gemini-flash-lite-latest'
    || /gemma-?4/.test(id);
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

/** How each API's transport is handed audio, video and documents (ADR-0029). An API not listed takes none. */
const mediaCarriages: Partial<Record<string, MediaCarriage>> = {
  // Pi's Google transport sends every block that is not text as inline data under the block's own type.
  'google-generative-ai': 'inline',
  'google-vertex': 'inline',
  [GEMINI_INTERACTIONS]: 'native',
};
/** How this model is handed one kind of media, or undefined when it reads a line of text in its place. */
export function mediaCarriage(model: Pick<Model<Api>, 'api' | 'input'>, modality: MediaModality): MediaCarriage | undefined {
  return (model.input as readonly string[]).includes(modality) ? mediaCarriages[model.api] : undefined;
}
/** A capability declared where no transport can deliver it would leave the model reading placeholders unannounced. */
export function validateMediaInput(model: Pick<Model<Api>, 'api' | 'input'>) {
  const declared = MEDIA_MODALITIES.filter(modality => (model.input as readonly string[]).includes(modality));
  if (declared.length && !mediaCarriages[model.api]) throw new Error(`model.input ${declared.join(', ')} can be sent only through ${Object.keys(mediaCarriages).join(', ')}.`);
}
function validateInput(input: unknown) {
  if (!Array.isArray(input) || !input.includes('text') || input.some(value => !(INPUT_MODALITIES as readonly unknown[]).includes(value))) throw new Error(`model.input must be an array of input capabilities containing text and optionally ${INPUT_MODALITIES.filter(value => value !== 'text').join(', ')}.`);
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
    if (['contextWindow', 'maxTokens', 'reasoning'].some(key => config[key as keyof ModelConfig] !== undefined)) {
      throw new Error('Custom model capabilities require model.api.');
    }
    if (config.input !== undefined) validateInput(config.input);
    if (config.compat !== undefined) {
      const builtin = builtinModels().getModel(config.provider, config.id);
      if (!builtin) throw new Error('Custom model capabilities require model.api.');
      validateCompat(builtin.api, config.compat);
    }
    return;
  }
  if (typeof config.api !== 'string' || !Object.hasOwn(customApiCompatSchemas, config.api)) throw new Error(`model.api must be one of ${Object.keys(customApiCompatSchemas).join(', ')}.`);
  if (!config.baseUrl) throw new Error('A custom model requires model.baseUrl.');
  validateInput(config.input);
  for (const key of ['contextWindow', 'maxTokens'] as const) if (!Number.isSafeInteger(config[key]) || config[key]! <= 0) throw new Error(`The custom model field model.${key} must be a positive integer.`);
  if (config.maxTokens! > config.contextWindow!) throw new Error('model.maxTokens cannot exceed model.contextWindow.');
  if (config.reasoning !== undefined && typeof config.reasoning !== 'boolean') throw new Error('model.reasoning must be a boolean.');
  if (config.compat !== undefined) validateCompat(config.api, config.compat);
}
