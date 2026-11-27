import { environmentCredential, type CredentialReader } from './credentials.js';
import {
  clampThinkingLevel,
  createModels,
  createProvider,
  type AnthropicMessagesCompat,
  type Model,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { GEMINI_INTERACTIONS, geminiInteractionsApi } from './gemini-interactions.js';
import type { CustomApi, ModelConfig } from './model-config.js';
import { resolveModel } from './model-catalog.js';

export {
  addsToolsInPlace,
  atModelPath,
  compatKeysForApi,
  effectiveThinkingLevel,
  filterCompatForApi,
  independentModelUses,
  initialThinkingLevel,
  modelBudget,
  modelRoute,
  modelUse,
  shouldMergeConsecutiveUsers,
  supportedThinkingLevels,
  validateModelConfig,
  type CustomApi,
  type DeferredToolsMode,
  type ModelConfig,
  type ModelOwner,
  type ModelPath,
  type ModelSystemConfig,
  type ModelUseSummary,
} from './model-config.js';

export {
  findCatalogTemplate,
  loadsToolsOnDemand,
  modelReadiness,
  resolveModel,
  resolveModelWithInfo,
  type ResolvedModelInfo,
} from './model-catalog.js';

const apiFactories: Record<CustomApi, () => ReturnType<typeof openAICompletionsApi>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
  [GEMINI_INTERACTIONS]: geminiInteractionsApi,
};

/** Attach the tool-loader name for transports that require it (such as Gemini Interactions API, ADR-0023). */
export function withToolLoader<S extends (target: Model<any>, context: any, options?: any) => any>(send: S, toolLoader?: string): S {
  if (!toolLoader) return send;
  return ((target, context, options) => target.api === GEMINI_INTERACTIONS
    ? send(target, context, { ...options, toolLoader })
    : send(target, context, options)) as S;
}

export function createModelBackend(config: ModelConfig, credential: CredentialReader = environmentCredential, resolveOptions?: { requireVision?: boolean }) {
  const model = resolveModel(config, resolveOptions);
  const models = config.api ? createModels() : builtinModels();
  if (config.api) models.setProvider(createProvider({
    id: config.provider, baseUrl: model.baseUrl, models: [model],
    auth: { apiKey: { name: config.apiKeyEnv, async resolve({ credential: supplied }) { const apiKey = supplied?.key ?? credential(config.apiKeyEnv); return apiKey ? { auth: { apiKey } } : undefined; } } },
    api: apiFactories[config.api](),
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
