import { createModels, createProvider, envApiKeyAuth, type Api, type Model, type OpenAICompletionsCompat, type OpenAIResponsesCompat, type AnthropicMessagesCompat } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { OpenAICompletionsCompatSchema, OpenAIResponsesCompatSchema, AnthropicMessagesCompatSchema } from '@earendil-works/pi-ai/providers/compat-schema';
import { Check } from 'typebox/value';

const apis = {
  'openai-completions': { create: openAICompletionsApi, compat: OpenAICompletionsCompatSchema },
  'openai-responses': { create: openAIResponsesApi, compat: OpenAIResponsesCompatSchema },
  'anthropic-messages': { create: anthropicMessagesApi, compat: AnthropicMessagesCompatSchema },
};
type CustomApi = keyof typeof apis;
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
}

export function validateModelConfig(config: ModelConfig) {
  if (config.baseUrl !== undefined) {
    if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) throw new Error('model.baseUrl must be a valid HTTP/HTTPS URL.');
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { throw new Error('model.baseUrl must be a valid HTTP/HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('model.baseUrl must be an HTTP/HTTPS URL without credentials, query parameters, or a fragment.');
  }
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
  return model;
}

export function createModelBackend(config: ModelConfig) {
  const model = resolveModel(config);
  const models = config.api ? createModels() : builtinModels();
  if (config.api) models.setProvider(createProvider({
    id: config.provider, baseUrl: model.baseUrl, models: [model],
    auth: { apiKey: envApiKeyAuth(config.provider, [config.apiKeyEnv]) },
    api: apis[config.api].create(),
  }));
  return { model, stream: models.streamSimple.bind(models) };
}
