import { checkCredentialName, environmentCredential, type CredentialReader } from '../credentials.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { Config } from '../config.js';
import { createModelBackend, validateModelConfig, type ModelConfig } from '../model.js';
import { EmbeddingClient } from '../embedding.js';
import { hash } from './files.js';

export const providerApis = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
/**
 * A model provider the operator keeps for the page: an endpoint, its API, and where its key lives.
 * The daemon never reads these; choosing one for the model, embedding, or drawing copies its fields into the configuration.
 */
export interface ProviderProfile { id: string; name: string; api: typeof providerApis[number]; baseUrl: string; apiKeyEnv: string; compat?: Record<string, unknown> }

function checkProfile(profile: ProviderProfile) {
  if (typeof profile.id !== 'string' || !profile.id) throw new Error('A provider needs an ID.');
  if (typeof profile.name !== 'string' || !profile.name.trim()) throw new Error('A provider needs a name.');
  if (!providerApis.includes(profile.api)) throw new Error(`A provider's API must be one of ${providerApis.join(', ')}.`);
  let url: URL | undefined;
  try { url = new URL(profile.baseUrl); } catch { /* reported below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${profile.name}: the base URL must be HTTP/HTTPS without credentials, query parameters, or a fragment.`);
  checkCredentialName(profile.apiKeyEnv);
  if (profile.compat !== undefined && (!profile.compat || typeof profile.compat !== 'object' || Array.isArray(profile.compat))) throw new Error(`${profile.name}: compat must be an object.`);
}

export class ProviderProfiles {
  constructor(private path: string) {}
  /** The saved list; before the first save, one drawn from the endpoints the configuration already uses. */
  list(raw: Record<string, any>): ProviderProfile[] {
    if (existsSync(this.path)) return JSON.parse(readFileSync(this.path, 'utf8')).providers;
    const seen = new Map<string, ProviderProfile>();
    const add = (name: string, api: ProviderProfile['api'], baseUrl: unknown, apiKeyEnv: unknown, compat?: Record<string, unknown>) => {
      if (typeof baseUrl !== 'string' || !baseUrl || typeof apiKeyEnv !== 'string') return;
      const key = `${new URL(baseUrl).href.replace(/\/+$/, '')}|${api}|${apiKeyEnv}`;
      // Stable until saved, so an edit made from one listing still finds its entry.
      if (!seen.has(key)) seen.set(key, { id: `seed-${hash(key).slice(0, 12)}`, name, api, baseUrl, apiKeyEnv, ...(compat ? { compat } : {}) });
    };
    for (const [name, model] of [['model', raw.model], ['review.model', raw.review?.model], ['compaction.model', raw.compaction?.model]] as const) {
      try { if (model?.api) add(model.provider ?? name, model.api, model.baseUrl, model.apiKeyEnv ?? 'MODEL_API_KEY', model.compat); }
      catch { /* an invalid endpoint does not hide the others */ }
    }
    try { add(`${new URL(raw.embedding?.baseUrl).host}`, 'openai-completions', raw.embedding?.baseUrl, raw.embedding?.apiKeyEnv); } catch { /* likewise */ }
    try { add(`${new URL(raw.drawing?.baseUrl).host}`, 'openai-completions', raw.drawing?.baseUrl, raw.drawing?.apiKeyEnv); } catch { /* likewise */ }
    return [...seen.values()];
  }
  save(providers: ProviderProfile[]) {
    if (!Array.isArray(providers)) throw new Error('Providers must be a list.');
    for (const profile of providers) checkProfile(profile);
    if (new Set(providers.map(profile => profile.id)).size !== providers.length) throw new Error('Provider IDs must be unique.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ providers }, null, 2) + '\n', { mode: 0o600 });
    return providers;
  }
}

const trimmed = (url: string) => url.replace(/\/+$/, '');
/** The model IDs an endpoint offers, from its /models listing. */
export async function remoteModels(profile: ProviderProfile, request: typeof fetch = fetch, credential: CredentialReader = environmentCredential): Promise<string[]> {
  checkProfile(profile);
  const key = credential(profile.apiKeyEnv);
  const anthropic = profile.api === 'anthropic-messages';
  const headers: Record<string, string> = anthropic ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : (key ? { Authorization: `Bearer ${key}` } : {});
  const base = trimmed(profile.baseUrl);
  // A base URL may stop before /v1, as the main model's often does.
  const urls = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  let failure = '';
  for (const url of urls) {
    const response = await request(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { failure = `HTTP ${response.status} from ${url}`; continue; }
    const body = await response.json() as { data?: { id?: unknown }[] };
    if (!Array.isArray(body?.data)) { failure = `${url} did not return a model list.`; continue; }
    return body.data.map(item => String(item.id)).filter(Boolean).sort();
  }
  throw new Error(`The model list could not be read: ${failure}.`);
}

/** Send one short request to a model configuration and report what came back. */
export async function testModel(config: ModelConfig, timeoutMs = 60_000, credential: CredentialReader = environmentCredential) {
  validateModelConfig(config);
  const { model, stream } = createModelBackend(config, credential);
  const started = Date.now();
  const context = normalizeContext({ systemPrompt: 'This is a connection test. Reply with OK.', messages: [{ role: 'user', content: 'ping', timestamp: started }] });
  const reasoning = config.thinkingLevel === 'off' ? undefined : config.thinkingLevel;
  const reply = await stream(model, context, { maxTokens: Math.min(reasoning ? 4096 : 1024, model.maxTokens), reasoning, signal: AbortSignal.timeout(timeoutMs) }).result();
  if (reply.stopReason === 'error' || reply.stopReason === 'aborted') throw new Error(reply.errorMessage ?? `The model stopped: ${reply.stopReason}.`);
  const text = reply.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
  return { ms: Date.now() - started, text: text.slice(0, 500), stopReason: reply.stopReason, usage: reply.usage };
}

export async function testEmbedding(config: Config['embedding'], credential: CredentialReader = environmentCredential) {
  const started = Date.now();
  const [vector] = await new EmbeddingClient(config, fetch, credential).embed(['连接测试']);
  return { ms: Date.now() - started, dimensions: vector!.length };
}

/** The models Pi already knows, for choosing one without a custom endpoint. */
export function catalog(provider?: string) {
  const models = builtinModels();
  if (!provider) return { providers: models.getProviders().map(item => item.id).sort() };
  return { models: models.getModels(provider).map(model => ({ id: model.id, name: model.name, input: model.input, reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens })) };
}
