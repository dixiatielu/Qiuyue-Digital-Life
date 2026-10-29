import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('context budgets use tokens with validated reserves and bounded compaction settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-context-config-'));
  try {
    const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const path = join(dir, 'config.json');
    const load = (raw: typeof base) => { writeFileSync(path, JSON.stringify(raw)); return loadConfig(path); };
    const defaults = load(base);
    assert.equal(defaults.limits.contextTokens, 262144);
    assert.equal(defaults.limits.outputReserveTokens, 32768);
    delete base.limits.outputReserveTokens;
    assert.equal(load(base).limits.outputReserveTokens, 32768);
    assert.equal(defaults.compaction.keepRecentTokens, 12000);
    assert.equal(defaults.compaction.summaryMaxTokens, 2048);
    assert.throws(() => load({ ...base, limits: { ...base.limits, contextTokens: 5000 } }), /output reserve and safety margin/);
    for (const value of [0, -1, 1.5]) {
      assert.throws(() => load({ ...base, compaction: { ...base.compaction, keepRecentTokens: value } }), /keepRecentTokens/);
    }
    assert.throws(() => load({ ...base, compaction: { ...base.compaction, summaryMaxTokens: 40000 } }), /summaryMaxTokens/);
    assert.throws(() => load({ ...base, compaction: { ...base.compaction, retries: 4 } }), /retries/);
    assert.equal(load({ ...base, compaction: { ...base.compaction, retries: 0 } }).compaction.retries, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persona files resolve relative to the configuration and preserve multiline UTF-8 content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-persona-'));
  try {
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    const path = join(dir, 'config.json');
    mkdirSync(join(dir, 'prompts'));
    const personaPath = join(dir, 'prompts', 'persona.md');
    const persona = '# Identity\n\n秋月\n\n## Style\nNatural and concise.\n';
    writeFileSync(personaPath, persona);
    for (const file of ['prompts/persona.md', personaPath]) {
      raw.personaFile = file;
      writeFileSync(path, JSON.stringify(raw));
      assert.equal(loadConfig(path).persona, persona);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('persona configuration rejects invalid paths and missing or blank content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-persona-invalid-'));
  try {
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    const path = join(dir, 'config.json');
    const load = () => { writeFileSync(path, JSON.stringify(raw)); return loadConfig(path); };
    for (const value of ['', '  ', null, false, 42]) {
      raw.personaFile = value;
      assert.throws(load, /personaFile.*non-empty file path/);
    }
    raw.personaFile = 'missing.md';
    assert.throws(load, /ENOENT/);
    raw.personaFile = 'persona.md';
    writeFileSync(join(dir, raw.personaFile), ' \n\t');
    assert.throws(load, /persona content.*must not be empty/);
    writeFileSync(join(dir, raw.personaFile), 'Qiuyue');
    delete raw.personaFile;
    assert.throws(load, /personaFile.*non-empty file path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('custom model configuration requires explicit protocol, endpoint and capability metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-model-config-'));
  try {
    const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, raw.personaFile), 'Qiuyue');
    const path = join(dir, 'config.json');
    const model = {
      provider: 'my-gateway', id: 'private-model', api: 'openai-completions', apiKeyEnv: 'MODEL_API_KEY',
      baseUrl: 'https://gateway.example/v1', input: ['text', 'image'], contextWindow: 131072, maxTokens: 32768,
    };
    const load = (override: Record<string, unknown>) => {
      writeFileSync(path, JSON.stringify({ ...raw, model: { ...model, ...override } }));
      return loadConfig(path);
    };
    assert.equal(load({}).model.provider, 'my-gateway');
    for (const baseUrl of [undefined, null, '', ['https://gateway.example'], 'ftp://gateway.example', 'https://user:secret@gateway.example', 'https://gateway.example?key=secret']) assert.throws(() => load({ baseUrl }), /baseUrl/);
    for (const api of ['unknown', 'toString', {}, null]) assert.throws(() => load({ api }), /model.api/);
    assert.throws(() => load({ api: undefined }), /model.api/);
    for (const input of [undefined, [], ['audio'], ['image'], 'text']) assert.throws(() => load({ input }), /model.input/);
    for (const field of ['contextWindow', 'maxTokens']) for (const value of [undefined, 0, -1, 1.5, '1000']) assert.throws(() => load({ [field]: value }), new RegExp(`model.${field}`));
    assert.throws(() => load({ maxTokens: 200000 }), /maxTokens.*contextWindow/);
    assert.throws(() => load({ reasoning: 'true' }), /reasoning/);
    for (const compat of [null, [], { maxTokensField: 'tokens' }, { supportsStore: 'false' }, { typo: true }]) assert.throws(() => load({ compat }), /compat/);
    assert.deepEqual(load({ compat: { maxTokensField: 'max_tokens' } }).model.compat, { maxTokensField: 'max_tokens' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('embedding is off by default and, when on, needs an endpoint, a model, and a threshold for that model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-embedding-config-'));
  try {
    const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const path = join(dir, 'config.json');
    const load = (embedding: Record<string, unknown>) => { writeFileSync(path, JSON.stringify({ ...base, embedding })); return loadConfig(path); };
    const on = { enabled: true, baseUrl: 'https://llm.example/v1', model: 'embedder' };
    delete base.embedding;
    assert.deepEqual(load({}).embedding, { enabled: false, baseUrl: '', model: '', apiKeyEnv: 'MODEL_API_KEY', threshold: 0.65, searchThreshold: 0.55, limit: 3, timeoutMs: 15_000, selfNames: [] });
    assert.equal(load({ ...on, selfNames: ['秋月'] }).embedding.selfNames[0], '秋月');
    for (const baseUrl of ['', 'ftp://llm.example', 'https://user:pass@llm.example/v1', 'https://llm.example/v1?key=1']) assert.throws(() => load({ ...on, baseUrl }), /embedding.baseUrl/);
    assert.throws(() => load({ ...on, model: ' ' }), /embedding.model/);
    for (const threshold of [0, 1, '0.6']) assert.throws(() => load({ ...on, threshold }), /embedding.threshold/);
    for (const searchThreshold of [0, 1.2, null]) assert.throws(() => load({ ...on, searchThreshold }), /embedding.searchThreshold/);
    for (const limit of [0, 21, 1.5]) assert.throws(() => load({ ...on, limit }), /embedding.limit/);
    assert.throws(() => load({ ...on, selfNames: [''] }), /selfNames/);
    assert.throws(() => load({ ...on, apiKeyEnv: 'not-a-name' }), /environment variable/);
    assert.throws(() => load({ ...on, enabled: 'yes' }), /boolean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
