import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findSnowLumaAction, type SnowLumaPermissions } from './snowluma-catalog.js';
import { validateModelConfig, type ModelConfig } from './model.js';

export interface Config {
  database: string;
  socket: string;
  persona: string;
  model: ModelConfig;
  snowluma: { url: string; tokenEnv: string; selfId: number; groups: number[]; tools: SnowLumaPermissions; maxStreamBytes: number };
  /** freeTime: a quiet stretch, drawn between quietMinMs and quietMaxMs each time, offers a life wake at least gapMs from any other, at most perDay a day (ADR-0015). */
  life: { enabled: boolean; allowFiction: boolean; minWakeMs: number; freeTime: { enabled: boolean; quietMinMs: number; quietMaxMs: number; gapMs: number; perDay: number } };
  limits: { batchSize: number; debounceMs: number; maxDelayMs: number; ambientDelayMs: number; maxPreemptions: number; tickMs: number; modelCallsPerDay: number | null; actionsPerHour: number | null; runTimeoutMs: number | null; maxTurnsPerRun: number | null; maxImages: number; contextTokens: number; outputReserveTokens: number; contextSafetyTokens: number };
  compaction: { keepRecentTokens: number; summaryMaxTokens: number; retries: number; idleRatio: number; idleAfterMs: number };
  memory: { retentionDays: number; recallLimit: number; recentEvents: number; reflectionEveryEvents: number };
  development: { scopeChars: number; personChars: number; people: number; recordLines: number };
  web: { enabled: boolean; searchUrl: string; searchKeyEnv: string; timeoutMs: number; maxBytes: number };
  /** Recall by meaning, through an OpenAI-compatible /embeddings endpoint. Both thresholds depend on the model: threshold for what messages call to mind, searchThreshold for the few words of a deliberate search, which score lower. */
  embedding: { enabled: boolean; baseUrl: string; model: string; apiKeyEnv: string; threshold: number; searchThreshold: number; limit: number; timeoutMs: number; selfNames: string[] };
}

export function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
  const base = dirname(resolve(path));
  if (typeof raw.personaFile !== 'string' || !raw.personaFile.trim()) throw new Error('The personaFile configuration must be a non-empty file path.');
  const persona = readFileSync(resolve(base, raw.personaFile), 'utf8');
  const config: Config = {
    database: resolve(base, raw.database ?? 'data/life.sqlite'),
    socket: resolve(base, raw.socket ?? 'data/control.sock'),
    persona,
    model: { provider: 'openai', id: '', apiKeyEnv: 'MODEL_API_KEY', ...raw.model },
    snowluma: { url: 'ws://127.0.0.1:3001', tokenEnv: 'SNOWLUMA_TOKEN', selfId: 0, groups: [], maxStreamBytes: 32_000_000, ...raw.snowluma, tools: { allow: '*', deny: [], ...raw.snowluma?.tools } },
    life: { enabled: false, allowFiction: false, minWakeMs: 60_000, ...raw.life, freeTime: { enabled: true, quietMinMs: 600_000, quietMaxMs: 1_200_000, gapMs: 3_600_000, perDay: 8, ...raw.life?.freeTime } },
    limits: { batchSize: 20, debounceMs: 1200, maxDelayMs: 4000, ambientDelayMs: 120_000, maxPreemptions: 2, tickMs: 500, modelCallsPerDay: null, actionsPerHour: null, runTimeoutMs: null, maxTurnsPerRun: null, maxImages: 4, contextTokens: 262144, outputReserveTokens: 32768, contextSafetyTokens: 2048, ...raw.limits },
    compaction: { keepRecentTokens: 12000, summaryMaxTokens: 2048, retries: 1, idleRatio: 0.85, idleAfterMs: 30_000, ...raw.compaction },
    memory: { retentionDays: 90, recallLimit: 8, recentEvents: 30, reflectionEveryEvents: 100, ...raw.memory },
    development: { scopeChars: 2000, personChars: 600, people: 8, recordLines: 200, ...raw.development },
    web: { enabled: true, searchUrl: 'https://api.deepseek.com/v1/tools/search', searchKeyEnv: 'DEEPSEEK_API_KEY', timeoutMs: 15_000, maxBytes: 2_000_000, ...raw.web },
    embedding: { enabled: false, baseUrl: '', model: '', apiKeyEnv: 'MODEL_API_KEY', threshold: 0.65, searchThreshold: 0.55, limit: 3, timeoutMs: 15_000, selfNames: [], ...raw.embedding },
  };
  if (!config.persona.trim()) throw new Error('The persona content in personaFile must not be empty.');
  for (const field of ['id', 'provider', 'apiKeyEnv'] as const) if (typeof config.model[field] !== 'string' || !config.model[field]) throw new Error(`model.${field} must not be empty.`);
  validateModelConfig(config.model);
  for (const name of [config.model.apiKeyEnv, config.snowluma.tokenEnv, config.web.searchKeyEnv, config.embedding.apiKeyEnv]) if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Credential settings must be environment variable names.');
  if (!Number.isSafeInteger(config.snowluma.selfId) || config.snowluma.selfId <= 0) throw new Error('snowluma.selfId must be an actual QQ account ID.');
  if (!Array.isArray(config.snowluma.groups) || config.snowluma.groups.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('snowluma.groups must be an array of group IDs for history recovery; it may be empty.');
  const url = new URL(config.snowluma.url);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('SnowLuma must use a ws/wss URL without credentials.');
  const { modelCallsPerDay, actionsPerHour, runTimeoutMs, maxTurnsPerRun, debounceMs, maxPreemptions, ...runLimits } = config.limits;
  for (const [key, value] of Object.entries({ modelCallsPerDay, actionsPerHour, runTimeoutMs, maxTurnsPerRun })) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${key} must be a positive integer or null (unlimited).`);
  }
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) throw new Error('debounceMs must be a non-negative integer; 0 starts thinking without waiting for quiet.');
  if (!Number.isSafeInteger(maxPreemptions) || maxPreemptions < 0) throw new Error('maxPreemptions must be a non-negative integer; 0 turns preemption off.');
  const { enabled: _freeTime, ...freeTime } = config.life.freeTime;
  for (const values of [runLimits, config.memory, config.development, { minWakeMs: config.life.minWakeMs }, freeTime, { timeoutMs: config.web.timeoutMs, maxBytes: config.web.maxBytes, maxStreamBytes: config.snowluma.maxStreamBytes }]) {
    for (const [key, value] of Object.entries(values)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  }
  if (config.limits.outputReserveTokens + config.limits.contextSafetyTokens >= config.limits.contextTokens) throw new Error('The output reserve and safety margin must sum to less than contextTokens.');
  for (const key of ['keepRecentTokens', 'summaryMaxTokens', 'idleAfterMs'] as const) if (!Number.isSafeInteger(config.compaction[key]) || config.compaction[key] <= 0) throw new Error(`compaction.${key} must be a positive integer.`);
  if (!Number.isSafeInteger(config.compaction.retries) || config.compaction.retries < 0 || config.compaction.retries > 3) throw new Error('compaction.retries must be between 0 and 3.');
  if (typeof config.compaction.idleRatio !== 'number' || !(config.compaction.idleRatio > 0 && config.compaction.idleRatio <= 1)) throw new Error('compaction.idleRatio must be greater than 0 and at most 1.');
  if (config.compaction.summaryMaxTokens > config.limits.outputReserveTokens) throw new Error('summaryMaxTokens cannot exceed outputReserveTokens.');
  for (const value of [config.life.enabled, config.life.allowFiction, config.life.freeTime.enabled, config.web.enabled, config.embedding.enabled]) if (typeof value !== 'boolean') throw new Error('Switches must be boolean values.');
  if (freeTime.quietMinMs > freeTime.quietMaxMs) throw new Error('life.freeTime.quietMinMs cannot exceed quietMaxMs.');
  const embedding = config.embedding;
  if (embedding.enabled) {
    let url: URL | undefined;
    try { url = new URL(embedding.baseUrl); } catch { /* reported below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('embedding.baseUrl must be an HTTP/HTTPS URL without credentials, query parameters, or a fragment, such as https://api.openai.com/v1.');
    if (typeof embedding.model !== 'string' || !embedding.model.trim()) throw new Error('embedding.model must not be empty.');
  }
  for (const key of ['threshold', 'searchThreshold'] as const) if (typeof embedding[key] !== 'number' || !(embedding[key] > 0 && embedding[key] < 1)) throw new Error(`embedding.${key} must be between 0 and 1; calibrate it for the embedding model.`);
  if (!Number.isSafeInteger(embedding.limit) || embedding.limit <= 0 || embedding.limit > 20) throw new Error('embedding.limit must be an integer from 1 to 20.');
  if (!Number.isSafeInteger(embedding.timeoutMs) || embedding.timeoutMs <= 0) throw new Error('embedding.timeoutMs must be a positive integer.');
  if (!Array.isArray(embedding.selfNames) || embedding.selfNames.some(name => typeof name !== 'string' || !name.trim())) throw new Error('embedding.selfNames must be an array of the names people call the digital life.');
  const permissions = config.snowluma.tools;
  if ((permissions.allow !== '*' && !Array.isArray(permissions.allow)) || !Array.isArray(permissions.deny)) throw new Error('snowluma.tools.allow must be "*" or an array of interface names; deny must be an array of interface names.');
  for (const name of [...(permissions.allow === '*' ? [] : permissions.allow), ...permissions.deny]) {
    if (typeof name !== 'string') throw new Error('SnowLuma interface permissions accept only interface names.');
    findSnowLumaAction(name);
  }
  return config;
}
