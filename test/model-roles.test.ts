import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModels, fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call, getCurrentTools, toToolDeclaration, type Message } from '@earendil-works/pi-ai';
import { loadConfig } from '../src/config.js';
import { modelReadiness, modelUse, type ModelConfig } from '../src/model.js';
import { PiBrain, contextIdentity } from '../src/brain.js';
import { estimateTokens, estimatedContextTokens, textTokens } from '../src/context.js';
import { systemInstructions } from '../src/prompts.js';
import { Store } from '../src/store.js';
import { forReview } from '../src/tools.js';
import { LifeReader } from '../src/webui/reader.js';
import { config, createTools, deferred, event } from './helpers.js';

const model: ModelConfig = {
  provider: 'shared-gateway', id: 'daily', apiKeyEnv: 'DAILY_KEY', api: 'openai-completions',
  baseUrl: 'https://daily.example/v1', input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192,
  reasoning: true, thinkingLevel: 'low',
};
const reviewModel: ModelConfig = { ...model, id: 'review', apiKeyEnv: 'REVIEW_KEY', baseUrl: 'https://review.example/v1', thinkingLevel: 'high' };
const summaryModel: ModelConfig = { ...model, id: 'summary', apiKeyEnv: 'SUMMARY_KEY', baseUrl: 'https://summary.example/v1', thinkingLevel: 'medium' };
const summaryRequest = (messages: Message[]) => String(messages.at(-1)?.content).startsWith('Internal working context consolidation:');

test('whole-model inheritance, independent budgets, and readiness use the same assignments', () => {
  const cfg = config(); cfg.model = model;
  cfg.limits.contextTokens = 64000;
  assert.equal(modelUse(cfg, 'review').thinking, model);
  assert.equal(modelUse(cfg, 'review').compaction, model);
  assert.equal(modelUse(cfg, 'main').compactionThinkingLevel, 'off');
  cfg.review = { model: reviewModel, limits: { contextTokens: 100000, outputReserveTokens: 4096 } };
  assert.equal(modelUse(cfg, 'review').compaction, reviewModel);
  assert.equal(modelUse(cfg, 'main').thinking, model);
  cfg.compaction.model = summaryModel; cfg.compaction.contextTokens = 131072;
  for (const owner of ['main', 'review'] as const) assert.equal(modelUse(cfg, owner).compaction, summaryModel);
  assert.equal(modelUse(cfg, 'review').limits.contextTokens, 100000);
  assert.equal(modelUse(cfg, 'main').limits.contextTokens, 64000);
  const ready = modelReadiness(cfg, name => name === 'REVIEW_KEY' ? undefined : 'test');
  assert.equal(ready.uses.length, 4);
  assert.deepEqual(ready.problems, ['review thinking: missing credential REVIEW_KEY.']);
  cfg.compaction.contextTokens = 50000;
  assert.match(modelReadiness(cfg).problems.join('\n'), /summary input budget.*review input budget/);
});

test('config rejects partial overrides and invalid role settings while allowing separate summary reserves', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-role-config-'));
  try {
    const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const load = (patch: any) => { const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify({ ...base, model, ...patch })); return loadConfig(path); };
    for (const bad of [null, {}, { id: '' }, { id: 'summary', api: 'openai-completions' }, { ...summaryModel, apiKeyEnv: 'bad-key' }, { ...summaryModel, input: ['text'] }]) {
      assert.throws(() => load({ compaction: { ...base.compaction, model: bad } }), /compaction.model/);
      assert.throws(() => load({ review: { model: bad } }), /review.model/);
    }
    for (const bad of [null, [], 'review', 1]) assert.throws(() => load({ review: bad }), /review must be an object/);
    assert.throws(() => load({ review: { limits: { modelCallsPerDay: 10 } } }), /Unknown review.limits/);
    assert.throws(() => load({ review: { limits: { contextTokens: 0 } } }), /review.limits.contextTokens/);
    assert.throws(() => load({ compaction: { contextTokens: -1 } }), /compaction.contextTokens/);
    assert.throws(() => load({ compaction: { model: summaryModel, summaryMaxTokens: 128 } }), /summaryMaxTokens.*source references/);
    assert.throws(() => load({ compaction: { model: { ...summaryModel, api: 'anthropic-messages' }, summaryMaxTokens: 1024 } }), /Anthropic.*1024/);
    assert.throws(() => load({ review: { model: { ...reviewModel, reasoning: false } } }), /review.model.*reasoning model/);
    const cfg = load({ limits: { ...base.limits, contextTokens: 64000, outputReserveTokens: 1024 }, compaction: { ...base.compaction, model: summaryModel, contextTokens: 131072, summaryMaxTokens: 4096 } });
    assert.equal(cfg.compaction.summaryMaxTokens, 4096);
    assert.equal(cfg.limits.outputReserveTokens, 1024);
    assert.equal(cfg.compaction.model?.apiKeyEnv, 'SUMMARY_KEY');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function brains(independentSummary = true, sameSummaryId = false) {
  const selectedSummary = sameSummaryId ? { ...summaryModel, id: model.id } : summaryModel;
  const cfg = config(); const store = new Store(':memory:');
  cfg.model = model; cfg.review = { model: reviewModel, limits: { contextTokens: 64000, outputReserveTokens: 2048 } };
  if (independentSummary) cfg.compaction.model = selectedSummary;
  cfg.compaction.contextTokens = 131072;
  cfg.compaction.summaryMaxTokens = 512; cfg.compaction.retries = 0; cfg.compaction.keepRecentTokens = 1500;
  cfg.adapters[0]!.tools = { allow: ['send_group_msg', 'send_private_msg', 'get_msg'], deny: [] };
  cfg.plugins.gallery = false;
  const scripts = { main: fauxProvider(), review: fauxProvider(), summary: fauxProvider() };
  const requests: { target: string; messages: Message[]; options: any }[] = [];
  const backend = (name: keyof typeof scripts, selected: ModelConfig) => {
    const provider = scripts[name]; const models = createModels(); models.setProvider(provider.provider);
    const target = { ...provider.getModel(), id: selected.id, baseUrl: selected.baseUrl!, contextWindow: 131072, maxTokens: 8192, reasoning: true };
    return { model: target, stream: (m: any, c: any, o: any) => {
      requests.push({ target: name, messages: structuredClone(c.messages), options: o });
      return models.streamSimple(m, c, o);
    } };
  };
  const summaries = independentSummary ? backend('summary', selectedSummary) : undefined;
  const keys = (name: string) => ({ DAILY_KEY: 'daily-secret', REVIEW_KEY: 'review-secret', SUMMARY_KEY: 'summary-secret' })[name];
  let main!: PiBrain; let review!: PiBrain;
  const social = { execute: async () => { throw new Error('Unexpected social action'); } };
  const tools = createTools(cfg, store, social, () => main.thought);
  const reviewTools = forReview(createTools(cfg, store, social, () => review.thought));
  main = new PiBrain(cfg, store, tools, backend('main', model), undefined, undefined, keys, 'main', summaries);
  review = new PiBrain(cfg, store, reviewTools, backend('review', reviewModel), undefined, undefined, keys, 'review', summaries);
  cfg.limits.outputReserveTokens = 4096;
  const fixed = textTokens(systemInstructions(cfg)) + estimateTokens(tools.current().map(toToolDeclaration));
  cfg.limits.contextTokens = cfg.limits.outputReserveTokens + cfg.limits.contextSafetyTokens + Math.ceil((fixed + 700) / 0.7);
  const observation = () => ({ batchId: 'review-test', events: [store.receive({ key: crypto.randomUUID(), kind: 'memory_maintenance', at: Date.now(), text: 'Review what happened.', payload: {} }, true)!] });
  return { cfg, store, scripts, requests, main, review, tools, reviewTools, observation };
}

test('primary, concurrent review, and compaction use independent keys, reasoning and budgets', async () => {
  const f = brains(); const entered = deferred(); const release = deferred();
  try {
    f.scripts.review.setResponses([async context => {
      entered.resolve(); await release.promise;
      assert.ok(getCurrentTools(context.messages).some(tool => tool.name === 'remember'));
      assert.ok(!getCurrentTools(context.messages).some(tool => tool.name === 'set_activity'));
      return answer('Review finished');
    }]);
    const reviewing = f.review.review(f.observation()); await entered.promise;
    f.scripts.main.setResponses(Array.from({ length: 8 }, () => answer('Earlier fact. ' + 'old working fact '.repeat(1000))));
    f.scripts.summary.setResponses(Array.from({ length: 8 }, () => answer('Keep the lunar topic, its original sources, and the unfinished commitment.')));
    for (let i = 0; i < 8; i++) { event(f.store, `Latest ${i}`); await f.main.run(f.store.claim(20)!); }
    release.resolve(); await reviewing;
    const grouped = (target: string) => f.requests.filter(request => request.target === target);
    assert.ok(grouped('summary').length > 0);
    for (const request of grouped('main')) {
      assert.equal(request.options.apiKey, 'daily-secret'); assert.equal(request.options.reasoning, 'low'); assert.equal(request.options.maxTokens, 4096);
      assert.ok(!summaryRequest(request.messages));
    }
    for (const request of grouped('summary')) {
      assert.equal(request.options.apiKey, 'summary-secret'); assert.equal(request.options.reasoning, 'medium'); assert.ok(request.options.maxTokens < 512);
      assert.ok(summaryRequest(request.messages));
    }
    assert.equal(grouped('review')[0]!.options.apiKey, 'review-secret');
    assert.equal(grouped('review')[0]!.options.reasoning, 'high');
    assert.equal(grouped('review')[0]!.options.maxTokens, 2048);
    const budget = Math.min(f.cfg.limits.contextTokens, f.main.agent.state.model.contextWindow) - f.cfg.limits.outputReserveTokens - f.cfg.limits.contextSafetyTokens;
    // A completed reply adds output after the prepared input; each prepared request still fits its owner.
    assert.ok(grouped('main').every(request => estimatedContextTokens(request.messages) <= budget));
    assert.equal(f.review.agent.state.messages.length, 1);
    assert.equal(f.store.dailyCalls(), f.requests.length);
    const finished = f.store.logs(500).filter(log => log.kind === 'model_request_finished');
    assert.equal(finished.length, f.requests.length);
    assert.equal(new Set(finished.map(log => (log.data as any).callId)).size, f.requests.length);
    assert.ok(finished.some(log => (log.data as any).owner === 'review' && (log.data as any).purpose === 'review'));
  } finally { release.resolve(); f.store.close(); }
});

test('review compaction inherits the review backend with no explicit reasoning, or uses the explicit summary backend', async () => {
  for (const independent of [false, true]) {
    const f = brains(independent);
    try {
      const fixed = textTokens(systemInstructions(f.cfg)) + estimateTokens(f.reviewTools.current().map(toToolDeclaration));
      f.cfg.review!.limits!.contextTokens = 2048 + f.cfg.limits.contextSafetyTokens + Math.ceil((fixed + 700) / 0.7);
      let turns = 0;
      const respond = (context: any) => summaryRequest(context.messages) ? answer('Review summary with sources and unsettled matters.') : ++turns < 6 ? answer([{ type: 'text', text: 'review evidence '.repeat(250) }, call('inspect_actions', {})]) : answer('Done');
      f.scripts.review.setResponses(Array.from({ length: 15 }, () => respond));
      f.scripts.summary.setResponses(Array.from({ length: 10 }, () => answer('Review summary with sources and unsettled matters.')));
      await f.review.review(f.observation());
      const summaries = f.requests.filter(request => summaryRequest(request.messages));
      assert.ok(summaries.length > 0);
      for (const request of f.requests) assert.match(JSON.stringify(request.messages), /Review what happened/);
      for (const request of summaries) {
        assert.equal(request.target, independent ? 'summary' : 'review');
        assert.equal(request.options.apiKey, independent ? 'summary-secret' : 'review-secret');
        assert.equal(request.options.reasoning, independent ? 'medium' : undefined);
      }
      assert.equal(f.store.dailyCalls(), f.requests.length);
    } finally { f.store.close(); }
  }
});

test('helper-model and budget edits preserve the primary context identity', () => {
  const f = brains();
  try {
    const before = contextIdentity(f.cfg, f.tools);
    f.cfg.review!.model = { ...reviewModel, id: 'another-review' };
    f.cfg.compaction.model = { ...summaryModel, id: 'another-summary' };
    f.cfg.review!.limits = { contextTokens: 110000, outputReserveTokens: 8192 };
    f.cfg.compaction.contextTokens = 120000;
    assert.equal(contextIdentity(f.cfg, f.tools), before);
    f.cfg.model = { ...model, id: 'another-daily' };
    assert.notEqual(contextIdentity(f.cfg, f.tools), before);
  } finally { f.store.close(); }
});

test('usage aggregates charged attempts once and leaves missing historical or failed usage unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-usage-'));
  const path = join(dir, 'life.sqlite'); const store = new Store(path);
  try {
    store.chargeCall('legacy', null);
    const common = { runId: 'r', owner: 'review', purpose: 'compaction', provider: 'same', model: 'summary', api: 'openai-completions' };
    const success = store.chargeCall('r', null);
    store.log('model_request_started', { ...common, callId: success });
    store.log('model_request_finished', { ...common, callId: success, status: 'success', usage: { input: 10, output: 20, cacheRead: 90, cacheWrite: 0, reasoning: 15, cost: { total: 0 } } });
    store.log('context_summary_completed', { callId: success, usage: { input: 10, output: 20 } });
    const error = store.chargeCall('r', null);
    store.log('model_request_finished', { ...common, callId: error, status: 'error', usage: null });
    const pending = store.chargeCall('r', null);
    store.log('model_request_started', { ...common, callId: pending });
    const usage = new LifeReader(path).modelUsage();
    assert.equal(usage.total, 4); assert.equal(usage.unclassified, 1); assert.equal(usage.cost, null);
    assert.equal(usage.groups.length, 1);
    assert.deepEqual(usage.groups[0], { owner: 'review', purpose: 'compaction', provider: 'same', model: 'summary', api: 'openai-completions', calls: 3, success: 1, errors: 1, aborted: 0, unfinished: 1, unknownUsage: 2, measuredCalls: 1, input: 10, output: 20, cacheRead: 90, cacheWrite: 0, reasoning: 15 });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a summary sent to another endpoint strips signatures even for the same provider, API and model ID', async () => {
  const f = brains(true, true);
  try {
    f.scripts.main.setResponses(Array.from({ length: 8 }, () => answer([
      { type: 'thinking', thinking: 'PRIVATE_REASONING', thinkingSignature: 'PRIVATE_SIGNATURE' },
      { type: 'text', text: 'Keep source event-1. ' + 'old working fact '.repeat(1000), textSignature: 'PRIVATE_TEXT_SIGNATURE' },
    ])));
    f.scripts.summary.setResponses(Array.from({ length: 8 }, () => context => {
      assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE_/);
      assert.match(JSON.stringify(context.messages), /Keep source event-1/);
      return answer('Keep source event-1 and its unknown outcome.');
    }));
    for (let i = 0; i < 8; i++) { event(f.store, `Observation ${i}`); await f.main.run(f.store.claim(20)!); }
    assert.ok(f.requests.some(request => request.target === 'summary'));
  } finally { f.store.close(); }
});

test('failed calls keep unknown usage and cancelled calls retain any reported usage, each recorded once', async () => {
  for (const abort of [false, true]) {
    const f = brains(); const entered = deferred(); const release = deferred();
    try {
      f.scripts.main.setResponses([async () => {
        entered.resolve(); await release.promise;
        if (!abort) throw new Error('Local endpoint unavailable');
        return answer('Stopped');
      }]);
      event(f.store, 'Hello');
      const run = f.main.run(f.store.claim(20)!);
      const rejected = assert.rejects(run);
      await entered.promise;
      if (abort) f.main.abort();
      release.resolve(); await rejected;
      const records = f.store.logs(100).filter(log => log.kind === 'model_request_finished');
      assert.equal(records.length, 1);
      const record = records[0]!.data as any;
      assert.equal(record.status, abort ? 'aborted' : 'error');
      if (abort) assert.ok(record.usage.input > 0, 'the provider reported usage before cancellation');
      else assert.equal(record.usage, null);
      assert.equal(f.store.dailyCalls(), 1);
    } finally { release.resolve(); f.store.close(); }
  }
});

test('an explicit summarizer transport failure rolls back the hard-budget run without model fallback', async () => {
  const f = brains(); let failed = false;
  try {
    f.cfg.compaction.idleRatio = 1;
    f.scripts.main.setResponses(Array.from({ length: 10 }, () => answer('Keep the original. ' + 'old working fact '.repeat(1000))));
    f.scripts.summary.setResponses([() => { throw new Error('Summary endpoint unavailable'); }]);
    for (let i = 0; i < 10 && !failed; i++) {
      const before = JSON.stringify(f.main.agent.state.messages);
      const latest = event(f.store, `Observation ${i}`);
      try { await f.main.run(f.store.claim(20)!); }
      catch {
        failed = true;
        assert.equal(JSON.stringify(f.main.agent.state.messages), before);
        assert.notEqual(f.store.event(latest.id)?.status, 'processed');
      }
    }
    assert.ok(failed);
    assert.equal(f.requests.at(-1)!.target, 'summary');
    assert.ok(!f.requests.some(request => request.target === 'review'));
    assert.equal(f.store.dailyCalls(), f.requests.length);
    const terminal = f.store.logs(100).filter(log => log.kind === 'model_request_finished');
    assert.equal(terminal.length, f.requests.length);
    assert.equal((terminal[0]!.data as any).purpose, 'compaction');
    assert.equal((terminal[0]!.data as any).status, 'error');
  } finally { f.store.close(); }
});
