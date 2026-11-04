import { credentialPaths } from './credentials.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ToolPermissions } from './platform.js';
import { atModelPath, independentModelUses, modelReadiness, validateModelConfig, type ModelConfig, type ModelPath } from './model.js';
import { checkSystemPrompt } from './prompts.js';

export interface AdapterConfig {
  id: string; driver: 'snowluma' | 'telegram'; accountId: string; url?: string; tokenEnv: string;
  tools: ToolPermissions; groups: number[]; maxStreamBytes: number; maxFileBytes: number; receive: 'polling' | 'manual';
}
export interface Config {
  /** All platform connections are named; an empty list runs without built-in connections. */
  adapters: AdapterConfig[];
  credentialsFile: string;
  uiLanguage: 'en' | 'zh';
  database: string;
  socket: string;
  persona: string;
  /** The operator's own system prompt template from systemPromptFile, in place of the built-in one. */
  systemPrompt?: string;
  /** The management web page, a process apart from the daemon (ADR-0020); service is the systemd user unit it may restart, or null. */
  webui: { host: string; port: number; tokenEnv: string; service: string | null };
  /** Optional per-plugin switches; drawing.enabled and web.enabled still govern their capabilities. */
  plugins: Record<string, boolean>;
  extensions: { directory: string; dataDirectory: string; settings: Record<string, Record<string, unknown>>; reloadTimeoutMs: number };
  model: ModelConfig;
  /** Omitted fields follow the main model and its context policy; model overrides are complete configurations. */
  review?: { model?: ModelConfig; limits?: { contextTokens?: number; outputReserveTokens?: number } };
  /** freeTime: a quiet stretch, drawn between quietMinMs and quietMaxMs each time, offers a life wake at least gapMs from any other, at most perDay a day (ADR-0015). */
  life: { enabled: boolean; allowFiction: boolean; minWakeMs: number; freeTime: { enabled: boolean; quietMinMs: number; quietMaxMs: number; gapMs: number; perDay: number } };
  limits: { batchSize: number; debounceMs: number; maxDelayMs: number; ambientDelayMs: number; maxPreemptions: number; tickMs: number; modelCallsPerDay: number | null; actionsPerHour: number | null; runTimeoutMs: number | null; maxTurnsPerRun: number | null; maxImages: number; contextTokens: number; outputReserveTokens: number; contextSafetyTokens: number };
  compaction: { model?: ModelConfig; contextTokens?: number; keepRecentTokens: number; summaryMaxTokens: number; retries: number; idleRatio: number; idleAfterMs: number };
  memory: { retentionDays: number; recallLimit: number; recentEvents: number; reflectionEveryEvents: number };
  development: { scopeChars: number; personChars: number; people: number; recordLines: number };
  web: { enabled: boolean; searchUrl: string; searchKeyEnv: string; timeoutMs: number; maxBytes: number };
  /** Recall by meaning, through an OpenAI-compatible /embeddings endpoint. Every threshold depends on the model: threshold for what messages call to mind, searchThreshold for the few words of a deliberate search, which score lower, and stickerThreshold for saved stickers whose descriptions fit what was said. */
  embedding: { enabled: boolean; baseUrl: string; model: string; apiKeyEnv: string; threshold: number; searchThreshold: number; limit: number; stickerThreshold: number; stickerLimit: number; timeoutMs: number; selfNames: string[] };
  /** Image generation through an OpenAI-compatible /images/generations endpoint (ADR-0018); generated images are kept in dir. */
  drawing: { enabled: boolean; baseUrl: string; model: string; apiKeyEnv: string; timeoutMs: number; dir: string };
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  if ('snowluma' in raw || raw.adapters === undefined || ['snowluma-tools', 'qzone-share', 'qq-stickers', 'qq-faces'].some(id => Object.hasOwn(raw.plugins ?? {}, id))) throw new Error('Platform configuration needs migration: run identities migrate --config <path> while the daemon is stopped.');
  const base = dirname(resolve(path));
  if (typeof raw.personaFile !== 'string' || !raw.personaFile.trim()) throw new Error('The personaFile configuration must be a non-empty file path.');
  const persona = readFileSync(resolve(base, raw.personaFile), 'utf8');
  for (const field of ['review', 'compaction'] as const) if (raw[field] !== undefined && (!raw[field] || typeof raw[field] !== 'object' || Array.isArray(raw[field]))) throw new Error(`${field} must be an object.`);
  const readModel = (value: any, path: ModelPath) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be a model configuration object.`);
    const model = { provider: 'openai', id: '', apiKeyEnv: 'MODEL_API_KEY', ...value } as ModelConfig;
    atModelPath(path, () => validateModelConfig(model));
    return model;
  };
  const review = raw.review;
  if (review?.limits !== undefined) {
    if (!review.limits || typeof review.limits !== 'object' || Array.isArray(review.limits)) throw new Error('review.limits must be an object.');
    for (const [key, value] of Object.entries(review.limits)) {
      if (!['contextTokens', 'outputReserveTokens'].includes(key)) throw new Error(`Unknown review.limits.${key}.`);
      if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`review.limits.${key} must be a positive integer.`);
    }
  }
  if (raw.systemPromptFile !== undefined && (typeof raw.systemPromptFile !== 'string' || !raw.systemPromptFile.trim())) throw new Error('systemPromptFile must be a non-empty file path when set.');
  const config: Config = {
    adapters: readAdapters(raw.adapters),
    credentialsFile: credentialPaths(path, raw.credentialsFile).file,
    uiLanguage: raw.uiLanguage ?? 'en',
    database: resolve(base, raw.database ?? 'data/life.sqlite'),
    socket: resolve(base, raw.socket ?? 'data/control.sock'),
    persona,
    ...(raw.systemPromptFile === undefined ? {} : { systemPrompt: readFileSync(resolve(base, raw.systemPromptFile), 'utf8') }),
    webui: webuiSettings(raw),
    plugins: raw.plugins ?? {},
    extensions: {
      directory: resolve(base, raw.extensions?.directory ?? 'plugins'),
      dataDirectory: resolve(base, raw.extensions?.dataDirectory ?? 'data/plugins'),
      settings: raw.extensions?.settings ?? {}, reloadTimeoutMs: raw.extensions?.reloadTimeoutMs ?? 120_000,
    },
    model: { provider: 'openai', id: '', apiKeyEnv: 'MODEL_API_KEY', ...raw.model },
    ...(review === undefined ? {} : { review: { ...(review.model === undefined ? {} : { model: readModel(review.model, 'review.model') }), ...(review.limits === undefined ? {} : { limits: review.limits }) } }),
    life: { enabled: false, allowFiction: false, minWakeMs: 60_000, ...raw.life, freeTime: { enabled: true, quietMinMs: 600_000, quietMaxMs: 1_200_000, gapMs: 3_600_000, perDay: 8, ...raw.life?.freeTime } },
    limits: { batchSize: 20, debounceMs: 1200, maxDelayMs: 4000, ambientDelayMs: 120_000, maxPreemptions: 2, tickMs: 500, modelCallsPerDay: null, actionsPerHour: null, runTimeoutMs: null, maxTurnsPerRun: null, maxImages: 4, contextTokens: 262144, outputReserveTokens: 32768, contextSafetyTokens: 2048, ...raw.limits },
    compaction: { keepRecentTokens: 12000, summaryMaxTokens: 2048, retries: 1, idleRatio: 0.85, idleAfterMs: 30_000, ...raw.compaction, ...(raw.compaction?.model === undefined ? {} : { model: readModel(raw.compaction.model, 'compaction.model') }) },
    memory: { retentionDays: 90, recallLimit: 8, recentEvents: 30, reflectionEveryEvents: 100, ...raw.memory },
    development: { scopeChars: 2000, personChars: 600, people: 8, recordLines: 200, ...raw.development },
    web: { enabled: true, searchUrl: 'https://api.deepseek.com/v1/tools/search', searchKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 15_000, maxBytes: 2_000_000, ...raw.web },
    embedding: { enabled: false, baseUrl: '', model: '', apiKeyEnv: 'MODEL_API_KEY', threshold: 0.65, searchThreshold: 0.55, limit: 3, stickerThreshold: 0.65, stickerLimit: 3, timeoutMs: 15_000, selfNames: [], ...raw.embedding },
    drawing: { enabled: false, baseUrl: '', model: '', apiKeyEnv: 'MODEL_API_KEY', timeoutMs: 300_000, ...raw.drawing, dir: resolve(base, raw.drawing?.dir ?? 'data/drawings') },
  };
  if (!['en', 'zh'].includes(config.uiLanguage)) throw new Error('uiLanguage must be en or zh.');
  if (!config.persona.trim()) throw new Error('The persona content in personaFile must not be empty.');
  if (config.systemPrompt !== undefined) checkSystemPrompt(config.systemPrompt);
  if (raw.plugins !== undefined && (!raw.plugins || typeof raw.plugins !== 'object' || Array.isArray(raw.plugins))) throw new Error('plugins must be an object of plugin IDs and boolean switches.');
  for (const [id, enabled] of Object.entries(config.plugins)) {
    if (id === 'all' || !/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new Error(`Invalid plugin ID: ${id}`);
    if (typeof enabled !== 'boolean') throw new Error(`plugins.${id} must be boolean.`);
  }
  if (raw.extensions !== undefined && (!raw.extensions || typeof raw.extensions !== 'object' || Array.isArray(raw.extensions))) throw new Error('extensions must be an object.');
  if (!config.extensions.settings || typeof config.extensions.settings !== 'object' || Array.isArray(config.extensions.settings)) throw new Error('extensions.settings must be an object.');
  for (const [id, value] of Object.entries(config.extensions.settings)) {
    if (id === 'all' || !/^[a-z][a-z0-9-]{0,63}$/.test(id) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('extensions.settings must map plugin IDs to setting objects.');
  }
  if (!Number.isSafeInteger(config.extensions.reloadTimeoutMs) || config.extensions.reloadTimeoutMs < 100 || config.extensions.reloadTimeoutMs > 900_000) throw new Error('extensions.reloadTimeoutMs must be between 100 and 900000.');
  for (const field of ['id', 'provider', 'apiKeyEnv'] as const) if (typeof config.model[field] !== 'string' || !config.model[field]) throw new Error(`model.${field} must not be empty.`);
  validateModelConfig(config.model);
  for (const name of [config.model.apiKeyEnv, ...config.adapters.map(account => account.tokenEnv), config.web.searchKeyEnv, config.embedding.apiKeyEnv, config.drawing.apiKeyEnv]) if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Credential settings must be environment variable names.');
  const { modelCallsPerDay, actionsPerHour, runTimeoutMs, maxTurnsPerRun, debounceMs, maxPreemptions, ...runLimits } = config.limits;
  for (const [key, value] of Object.entries({ modelCallsPerDay, actionsPerHour, runTimeoutMs, maxTurnsPerRun })) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${key} must be a positive integer or null (unlimited).`);
  }
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) throw new Error('debounceMs must be a non-negative integer; 0 starts thinking without waiting for quiet.');
  if (!Number.isSafeInteger(maxPreemptions) || maxPreemptions < 0) throw new Error('maxPreemptions must be a non-negative integer; 0 turns preemption off.');
  const { enabled: _freeTime, ...freeTime } = config.life.freeTime;
  for (const values of [runLimits, config.memory, config.development, { minWakeMs: config.life.minWakeMs }, freeTime, { timeoutMs: config.web.timeoutMs, maxBytes: config.web.maxBytes }]) {
    for (const [key, value] of Object.entries(values)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.limits.outputReserveTokens + config.limits.contextSafetyTokens >= config.limits.contextTokens) throw new Error('The output reserve and safety margin must sum to less than contextTokens.');
  for (const key of ['keepRecentTokens', 'summaryMaxTokens', 'idleAfterMs'] as const) if (!Number.isSafeInteger(config.compaction[key]) || config.compaction[key] <= 0) throw new Error(`compaction.${key} must be a positive integer.`);
  if (!Number.isSafeInteger(config.compaction.retries) || config.compaction.retries < 0 || config.compaction.retries > 3) throw new Error('compaction.retries must be between 0 and 3.');
  if (typeof config.compaction.idleRatio !== 'number' || !(config.compaction.idleRatio > 0 && config.compaction.idleRatio <= 1)) throw new Error('compaction.idleRatio must be greater than 0 and at most 1.');
  if (config.compaction.contextTokens !== undefined && (!Number.isSafeInteger(config.compaction.contextTokens) || config.compaction.contextTokens <= 0)) throw new Error('compaction.contextTokens must be a positive integer.');
  if (!independentModelUses(config) && config.compaction.summaryMaxTokens > config.limits.outputReserveTokens) throw new Error('summaryMaxTokens cannot exceed outputReserveTokens without an independent compaction budget.');
  if (independentModelUses(config)) {
    const { problems } = modelReadiness(config);
    if (problems.length) throw new Error(problems.join('\n'));
  }
  for (const value of [config.life.enabled, config.life.allowFiction, config.life.freeTime.enabled, config.web.enabled, config.embedding.enabled, config.drawing.enabled]) if (typeof value !== 'boolean') throw new Error('Switches must be boolean values.');
  if (freeTime.quietMinMs > freeTime.quietMaxMs) throw new Error('life.freeTime.quietMinMs cannot exceed quietMaxMs.');
  const embedding = config.embedding;
  for (const [name, endpoint] of [['embedding', embedding], ['drawing', config.drawing]] as const) {
    if (!endpoint.enabled || (name === 'drawing' && config.plugins.drawing === false)) continue;
    let url: URL | undefined;
    try { url = new URL(endpoint.baseUrl); } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name}.baseUrl must be an HTTP/HTTPS URL without credentials, query parameters, or a fragment, such as https://api.openai.com/v1.`);
    if (typeof endpoint.model !== 'string' || !endpoint.model.trim()) throw new Error(`${name}.model must not be empty.`);
  }
  if (!Number.isSafeInteger(config.drawing.timeoutMs) || config.drawing.timeoutMs <= 0) throw new Error('drawing.timeoutMs must be a positive integer.');
  for (const key of ['threshold', 'searchThreshold', 'stickerThreshold'] as const) if (typeof embedding[key] !== 'number' || !(embedding[key] > 0 && embedding[key] < 1)) throw new Error(`embedding.${key} must be between 0 and 1; calibrate it for the embedding model.`);
  for (const key of ['limit', 'stickerLimit'] as const) if (!Number.isSafeInteger(embedding[key]) || embedding[key] <= 0 || embedding[key] > 20) throw new Error(`embedding.${key} must be an integer from 1 to 20.`);
  if (!Number.isSafeInteger(embedding.timeoutMs) || embedding.timeoutMs <= 0) throw new Error('embedding.timeoutMs must be a positive integer.');
  if (!Array.isArray(embedding.selfNames) || embedding.selfNames.some(name => typeof name !== 'string' || !name.trim())) throw new Error('embedding.selfNames must be an array of the names people call the digital life.');
  return config;
}

/** The web page's own settings, readable even when the rest of the configuration is not, so the page can still open to repair it. */
export function webuiSettings(raw: Record<string, any>): Config['webui'] {
  const webui = { host: '127.0.0.1', port: 8848, tokenEnv: 'WEBUI_TOKEN', service: null, ...raw.webui };
  if (typeof webui.host !== 'string' || !webui.host.trim()) throw new Error('webui.host must be a listening address such as 127.0.0.1.');
  if (!Number.isSafeInteger(webui.port) || webui.port <= 0 || webui.port > 65535) throw new Error('webui.port must be a port number.');
  if (typeof webui.tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(webui.tokenEnv)) throw new Error('Credential settings must be environment variable names.');
  if (webui.service !== null && (typeof webui.service !== 'string' || !/^[\w@.:-]+$/.test(webui.service))) throw new Error('webui.service must be a systemd user unit name or null.');
  return webui;
}

function readAdapters(value: unknown): AdapterConfig[] {
  if (!Array.isArray(value)) throw new Error('adapters must be an array.');
  const ids = new Set<string>(), accounts = new Set<string>();
  return value.map(raw => {
    if (!raw || !/^[a-z][a-z0-9_]{0,23}$/.test(raw.id) || ids.has(raw.id)) throw new Error('Each adapter needs a unique id of 1–24 lowercase letters, digits or underscores.');
    ids.add(raw.id);
    if (!['snowluma', 'telegram'].includes(raw.driver)) throw new Error('Built-in adapter driver must be snowluma or telegram. Other adapters register through plugins.');
    if (typeof raw.accountId !== 'string' || !/^[1-9][0-9]*$/.test(raw.accountId) || !Number.isSafeInteger(Number(raw.accountId))) throw new Error('These adapters require accountId as a positive decimal string within the platform ID range.');
    const key = `${raw.driver === 'snowluma' ? 'qq' : 'telegram'}:${raw.accountId}`;
    if (accounts.has(key)) throw new Error('Configure each platform account once to avoid competing event consumers.'); accounts.add(key);
    const config: AdapterConfig = { groups: [], maxStreamBytes: 32_000_000, maxFileBytes: 50_000_000, receive: 'polling', ...raw, tokenEnv: raw.tokenEnv ?? (raw.driver === 'telegram' ? 'TELEGRAM_BOT_TOKEN' : 'SNOWLUMA_TOKEN'), tools: { allow: '*', deny: [], ...raw.tools } };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.tokenEnv)) throw new Error('Adapter tokenEnv must be an environment variable name.');
    const url = new URL(config.url ?? (config.driver === 'snowluma' ? 'ws://127.0.0.1:3001' : 'https://api.telegram.org'));
    if (!(config.driver === 'snowluma' ? ['ws:', 'wss:'] : ['https:', 'http:']).includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Adapter URL has an invalid protocol or embedded credentials.');
    if (!Array.isArray(config.groups) || config.groups.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Adapter groups must contain positive QQ group IDs.');
    for (const limit of [config.maxStreamBytes, config.maxFileBytes]) if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Adapter size limits must be positive integers.');
    if (!['manual', 'polling'].includes(config.receive)) throw new Error('Telegram receive must be polling or manual.');
    const permissions = config.tools;
    if (permissions.allow !== '*' && !Array.isArray(permissions.allow) || !Array.isArray(permissions.deny)) throw new Error('Adapter tools.allow must be "*" or an array; deny must be an array.');
    if ([...(permissions.allow === '*' ? [] : permissions.allow), ...permissions.deny].some(name => typeof name !== 'string' || !name)) throw new Error('Adapter permission names must be non-empty strings.');
    return config;
  });
}
