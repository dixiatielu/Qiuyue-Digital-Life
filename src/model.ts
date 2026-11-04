import { environmentCredential, type CredentialReader } from './credentials.js';
import { createModels, createProvider, type Api, type Model, type ModelThinkingLevel, type OpenAICompletionsCompat, type OpenAIResponsesCompat, type AnthropicMessagesCompat } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema, AnthropicMessagesCompatSchema } from '@earendil-works/pi-ai/providers/compat-schema';
import { Check } from 'typebox/value';
import type { Config } from './config.js';
import { summaryEnvelope } from './context.js';

const apis = {
  'openai-completions': { create: openAICompletionsApi, compat: OpenAICompletionsCompatSchema },
  'openai-responses': { create: openAIResponsesApi, compat: OpenAIResponsesCompatSchema },
  'anthropic-messages': { create: anthropicMessagesApi, compat: AnthropicMessagesCompatSchema },
};
type CustomApi = keyof typeof apis;
const thinkingLevels: ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export interface ModelConfig {
  provider: string;
  id: string;
  apiKeyEnv: string;
  baseUrl?: string;
  /** An explicit API selects a custom model instead of the built-in catalog. */
  api?: CustomApi;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
  /** How much the model thinks before each turn; off unless set, and only a reasoning model can think. */
  thinkingLevel?: ModelThinkingLevel;
}

export type ModelOwner = 'main' | 'review';
export type ModelPath = 'model' | 'review.model' | 'compaction.model';

/** Whole-model inheritance and context policies, shared by the brains and management interfaces. */
export function modelUse(config: Config, owner: ModelOwner) {
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

export function modelRoute(model: Model<Api>) { return JSON.stringify([model.provider, model.id, model.api, model.baseUrl]); }

/** Preserve field paths when the same model validator serves several independent configurations. */
export function atModelPath<T>(path: ModelPath, work: () => T): T {
  try { return work(); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${message.replace(/\bmodel\./g, `${path}.`)}`);
  }
}

export function independentModelUses(config: Config) {
  return Boolean(config.review?.model || Object.keys(config.review?.limits ?? {}).length || config.compaction.model || config.compaction.contextTokens !== undefined);
}

/** Offline model/capability/budget checks; an optional reader adds credential readiness without disclosing values. */
export function modelReadiness(config: Config, credential?: CredentialReader) {
  const problems: string[] = [];
  const uses: { owner: ModelOwner; purpose: 'thought' | 'review' | 'compaction'; source: ModelPath; provider: string; id: string; api: string; apiKeyEnv: string; contextWindow: number; inputBudget: number; thinkingLevel: string }[] = [];
  for (const owner of ['main', 'review'] as const) {
    const use = modelUse(config, owner);
    let ownerBudget: number | undefined;
    for (const purpose of ['thinking', 'compaction'] as const) {
      const selected = use[purpose];
      const source = purpose === 'thinking' ? use.thinkingSource : use.compactionSource;
      try {
        const model = atModelPath(source, () => resolveModel(selected));
        const contextTokens = purpose === 'thinking' ? use.limits.contextTokens : use.compactionContextTokens;
        const reserve = purpose === 'thinking' ? use.limits.outputReserveTokens : config.compaction.summaryMaxTokens;
        const outputCap = Math.min(model.maxTokens, purpose === 'thinking' ? reserve : reserve - summaryEnvelope(Array(8).fill(`ctx:${'0'.repeat(64)}`)).reserve);
        const thinkingLevel = purpose === 'thinking' ? selected.thinkingLevel ?? 'off' : use.compactionThinkingLevel;
        const { window, budget } = modelBudget(model, contextTokens, reserve, config.limits.contextSafetyTokens);
        if (budget <= 0) throw new Error(`window ${window} is too small for output reserve ${reserve} and safety margin ${config.limits.contextSafetyTokens}.`);
        if (purpose === 'thinking') ownerBudget = budget;
        else if (independentModelUses(config)) {
          if (outputCap < 64) throw new Error('summaryMaxTokens must leave at least 64 tokens of content after framing and source references.');
          if (ownerBudget !== undefined && budget < ownerBudget) throw new Error(`summary input budget ${budget} cannot cover the ${owner} input budget ${ownerBudget}; increase compaction.contextTokens or reduce the owner's context window.`);
        }
        if (model.api === 'anthropic-messages' && thinkingLevel !== 'off' && (model.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking !== true && outputCap <= 1024) throw new Error('Anthropic budget-based reasoning needs more than 1024 output tokens after any summary framing; increase the reserve or turn reasoning off.');
        uses.push({ owner, purpose: purpose === 'compaction' ? 'compaction' : owner === 'main' ? 'thought' : 'review', source, provider: model.provider, id: model.id, api: model.api, apiKeyEnv: selected.apiKeyEnv, contextWindow: window, inputBudget: budget, thinkingLevel });
      } catch (error) { problems.push(`${owner} ${purpose}: ${error instanceof Error ? error.message : String(error)}`); }
      if (credential && !credential(selected.apiKeyEnv)) problems.push(`${owner} ${purpose}: missing credential ${selected.apiKeyEnv}.`);
    }
  }
  return { uses, problems: [...new Set(problems)] };
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
  if (config.thinkingLevel !== undefined && !thinkingLevels.includes(config.thinkingLevel)) throw new Error(`model.thinkingLevel must be one of ${thinkingLevels.join(', ')}.`);
  if (config.api === undefined) {
    if (['input', 'contextWindow', 'maxTokens', 'reasoning', 'compat'].some(key => config[key as keyof ModelConfig] !== undefined)) throw new Error('Custom model capabilities require model.api.');
    return;
  }
  if (typeof config.api !== 'string' || !Object.hasOwn(apis, config.api)) throw new Error('model.api must be openai-completions, openai-responses, or anthropic-messages.');
  if (!config.baseUrl) throw new Error('A custom model requires model.baseUrl.');
  if (!Array.isArray(config.input) || !config.input.includes('text') || config.input.some(value => !['text', 'image'].includes(value))) throw new Error('model.input must be an array of input capabilities containing text and optionally image.');
  for (const key of ['contextWindow', 'maxTokens'] as const) if (!Number.isSafeInteger(config[key]) || config[key]! <= 0) throw new Error(`The custom model field model.${key} must be a positive integer.`);
  if (config.maxTokens! > config.contextWindow!) throw new Error('model.maxTokens cannot exceed model.contextWindow.');
  if (config.reasoning !== undefined && typeof config.reasoning !== 'boolean') throw new Error('model.reasoning must be a boolean.');
  const schema = apis[config.api].compat;
  if (config.compat !== undefined && (!Check(schema, config.compat) || Object.keys(config.compat).some(key => !Object.hasOwn(schema.properties, key)))) throw new Error('model.compat contains options incompatible with the selected model.api.');
}

export function resolveModel(config: ModelConfig): Model<Api> {
  validateModelConfig(config);
  let model: Model<Api> | undefined;
  if (config.api) {
    model = {
      provider: config.provider, id: config.id, name: config.id,
      api: config.api, baseUrl: config.baseUrl!, input: config.input!,
      contextWindow: config.contextWindow!, maxTokens: config.maxTokens!, reasoning: config.reasoning ?? false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.compat === undefined ? {} : { compat: config.compat }),
    };
  } else {
    const builtin = builtinModels().getModel(config.provider, config.id);
    if (builtin) model = config.baseUrl ? { ...builtin, baseUrl: config.baseUrl } : builtin;
  }
  if (!model) throw new Error('The specified model is not in the Pi model catalog; use the models command to check, or configure model.api, baseUrl, input, contextWindow, and maxTokens for a custom model.');
  if (!model.input.includes('image')) throw new Error('Image understanding is required; select a model that supports image input.');
  if ((config.thinkingLevel ?? 'off') !== 'off' && !model.reasoning) throw new Error('model.thinkingLevel requires a reasoning model; for a custom model, set model.reasoning to true.');
  return model;
}

export function createModelBackend(config: ModelConfig, credential: CredentialReader = environmentCredential) {
  const model = resolveModel(config);
  const models = config.api ? createModels() : builtinModels();
  if (config.api) models.setProvider(createProvider({
    id: config.provider, baseUrl: model.baseUrl, models: [model],
    auth: { apiKey: { name: config.apiKeyEnv, async resolve({ credential: supplied }) { const apiKey = supplied?.key ?? credential(config.apiKeyEnv); return apiKey ? { auth: { apiKey } } : undefined; } } },
    api: apis[config.api].create(),
  }));
  const stream: typeof models.streamSimple = (target, context, options) => {
    const apiKey = options?.apiKey ?? credential(config.apiKeyEnv);
    if (!apiKey) throw new Error(`Missing credential ${config.apiKeyEnv}.`);
    // Some adapters add a reasoning budget to maxTokens. Keep reasoning inside the caller's total reserve.
    const capped = options?.maxTokens === undefined ? target : { ...target, maxTokens: Math.min(options.maxTokens, target.maxTokens) };
    if (capped.api === 'anthropic-messages' && options?.reasoning && (capped.compat as AnthropicMessagesCompat | undefined)?.forceAdaptiveThinking !== true && capped.maxTokens <= 1024) throw new Error('Anthropic budget-based reasoning needs more than 1024 output tokens; increase the output reserve or summary limit, or turn reasoning off.');
    return models.streamSimple(capped, context, { ...options, apiKey });
  };
  return { model, stream };
}
