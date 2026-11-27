import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';
import {
  createModels,
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall as call,
  type AssistantMessage,
  type Message,
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import {
  addsToolsInPlace,
  createModelBackend,
  effectiveThinkingLevel,
  filterCompatForApi,
  loadsToolsOnDemand,
  modelReadiness,
  resolveModel,
  resolveModelWithInfo,
  supportedThinkingLevels,
  type ModelConfig,
} from '../src/model.js';
import { sanitizeToolSchema } from '../src/schema.js';
import { normalizeImageBlocks, prepareModelImage } from '../src/image.js';
import { mergeConsecutiveUserMessages, toModelMessages } from '../src/context.js';
import { PiBrain, contextIdentity } from '../src/brain.js';
import { Store } from '../src/store.js';
import { nativeAdapterPlugin, compactSchema } from '../src/adapters/native.js';
import { telegramCatalog } from '../src/adapters/telegram/catalog.js';
import { getSnowLumaCatalog } from '../src/adapters/snowluma/catalog.js';
import { ActionNotDispatchedError } from '../src/platform.js';
import { probeModel } from '../src/probe.js';
import { config, createTools, event, fixture } from './helpers.js';

const baseCustom: ModelConfig = {
  provider: 'my-gateway',
  id: 'custom-model',
  apiKeyEnv: 'TEST_KEY',
  api: 'openai-completions',
  baseUrl: 'https://gateway.example/v1',
  input: ['text', 'image'],
  contextWindow: 131072,
  maxTokens: 16384,
  reasoning: true,
};

test('custom gateway models inherit model-intrinsic catalog metadata without leaking gateway-dependent flags', () => {
  const claude = resolveModelWithInfo({
    ...baseCustom,
    id: 'claude-fable-5-2',
    api: 'anthropic-messages',
    thinkingLevel: 'off',
  });
  assert.equal(claude.inheritedFrom, 'anthropic/claude-fable-5');
  assert.equal((claude.model.compat as any)?.forceAdaptiveThinking, true);
  // Gateway-dependent mid-convo and fallback flags must NOT leak onto an unknown custom gateway.
  assert.equal((claude.model.compat as any)?.supportsMidConvoSystemMessages, undefined);
  assert.equal((claude.model.compat as any)?.supportsMidConvoToolChanges, undefined);
  assert.equal((claude.model.compat as any)?.supportsStrictTools, undefined);
  assert.equal((claude.model.compat as any)?.allowedFallbackModels, undefined);
  assert.equal(addsToolsInPlace(claude.model), false);
  assert.equal(claude.model.thinkingLevelMap?.off, null);
  assert.equal(claude.effectiveThinkingLevel, 'minimal');
  assert.ok(!claude.supportedThinkingLevels.includes('off'));

  const deepseek = resolveModelWithInfo({
    ...baseCustom,
    id: 'deepseek-flash',
    api: 'openai-completions',
    thinkingLevel: 'medium',
  });
  assert.equal(deepseek.inheritedFrom, 'deepseek/deepseek-flash');
  assert.equal((deepseek.model.compat as any)?.thinkingFormat, 'deepseek');
  assert.equal((deepseek.model.compat as any)?.requiresReasoningContentOnAssistantMessages, true);
  assert.equal((deepseek.model.compat as any)?.supportsDeveloperRole, false);
  assert.equal((deepseek.model.compat as any)?.maxTokensField, 'max_tokens');
  assert.equal((deepseek.model.compat as any)?.supportsStrictMode, undefined);
  assert.deepEqual(deepseek.supportedThinkingLevels, ['off', 'low', 'high', 'max']);
  assert.equal(deepseek.effectiveThinkingLevel, 'high');

  // Explicit baseModel overrides ID inference, and explicit compat overrides template defaults.
  const aliased = resolveModelWithInfo({
    ...baseCustom,
    id: 'company-internal-alias',
    baseModel: 'deepseek/deepseek-flash',
    compat: { maxTokensField: 'max_completion_tokens' },
  });
  assert.equal(aliased.inheritedFrom, 'deepseek/deepseek-flash');
  assert.equal((aliased.model.compat as any)?.maxTokensField, 'max_completion_tokens');
  assert.equal((aliased.model.compat as any)?.thinkingFormat, 'deepseek');

  assert.throws(() => resolveModel({ ...baseCustom, baseModel: 'nonexistent/model-xyz' }), /baseModel.*not found/);
});

test('built-in catalog models support layered compat/header overrides and readiness warns on clamped thinkingLevel', () => {
  const builtin = builtinModels().getModel('anthropic', 'claude-fable-5')!;
  const overridden = resolveModel({
    provider: 'anthropic',
    id: builtin.id,
    apiKeyEnv: 'ANTHROPIC_KEY',
    baseUrl: 'https://proxy.example',
    compat: { supportsMidConvoToolChanges: false },
    headers: { 'x-tenant': 'qiuyue' },
  });
  assert.equal(overridden.baseUrl, 'https://proxy.example');
  assert.equal((overridden.compat as any)?.supportsMidConvoToolChanges, false);
  assert.equal((overridden.compat as any)?.forceAdaptiveThinking, true);
  assert.equal(overridden.headers?.['x-tenant'], 'qiuyue');
  assert.equal(addsToolsInPlace(overridden), false);
  assert.throws(() => resolveModel({
    provider: 'anthropic',
    id: builtin.id,
    apiKeyEnv: 'ANTHROPIC_KEY',
    compat: { maxTokensField: 'max_tokens' } as never,
  }), /model.compat/);

  const cfg = config();
  cfg.model = { ...baseCustom, id: 'deepseek-flash', thinkingLevel: 'medium' };
  const ready = modelReadiness(cfg, () => 'secret');
  assert.deepEqual(ready.problems, []);
  assert.ok(ready.warnings.some(warning => warning.includes('thinkingLevel "medium"') && warning.includes('"high"')));
  const mainUse = ready.uses.find(item => item.owner === 'main' && item.purpose === 'thought')!;
  assert.equal(mainUse.effectiveThinkingLevel, 'high');
  assert.equal(mainUse.inheritedFrom, 'deepseek/deepseek-flash');

  assert.deepEqual(
    filterCompatForApi('anthropic-messages', { maxTokensField: 'max_tokens', forceAdaptiveThinking: true }),
    { forceAdaptiveThinking: true },
  );
  assert.equal(filterCompatForApi('google-generative-ai', { maxTokensField: 'max_tokens' }), undefined);
});

test('deferredTools applies universally by default and respects in-place-only and never policies', () => {
  const cfg = config();
  cfg.model = { ...baseCustom, id: 'private-vision-model', reasoning: false };
  assert.equal(loadsToolsOnDemand(cfg, 'main'), true);
  cfg.model.deferredTools = 'in-place-only';
  assert.equal(loadsToolsOnDemand(cfg, 'main'), false);
  cfg.model.compat = { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true };
  assert.equal(loadsToolsOnDemand(cfg, 'main'), true);
  cfg.model.deferredTools = 'never';
  assert.equal(loadsToolsOnDemand(cfg, 'main'), false);
});

test('sanitizeToolSchema resolves recursive $ref cycles, strips additionalProperties: true, normalizes array types, and compiles all catalogs', () => {
  const recursive: any = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: true,
    definitions: {
      Node: {
        type: 'object',
        additionalProperties: true,
        properties: {
          label: { type: ['string', 'number'] },
          child: { $ref: '#/definitions/Node' },
          items: { type: 'array' },
          anyField: {},
        },
      },
    },
    properties: {
      root: { $ref: '#/definitions/Node' },
      closed: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    },
  };
  const clean = sanitizeToolSchema(recursive) as any;
  assert.equal(clean.$schema, undefined);
  assert.equal(clean.definitions, undefined);
  assert.equal(clean.additionalProperties, undefined);
  assert.equal(clean.properties.closed.additionalProperties, false);
  assert.deepEqual(clean.properties.root.properties.label.anyOf, [{ type: 'string' }, { type: 'number' }]);
  assert.equal(clean.properties.root.properties.child.type, 'object');
  assert.ok(clean.properties.root.properties.items.items);
  assert.ok(Array.isArray(clean.properties.root.properties.anyField.anyOf));
  Compile(clean);

  // Clean TypeBox schemas pass through untouched.
  const pure = Type.Object({ text: Type.String(), count: Type.Optional(Type.Integer()) });
  assert.equal(sanitizeToolSchema(pure), pure);

  // Every SnowLuma (212) and Telegram (187) schema compiles cleanly with zero $ref / additionalProperties: true / array type / untyped props.
  const audit = (schema: any, name: string) => {
    const text = JSON.stringify(schema);
    assert.doesNotMatch(text, /"\$ref":/, name);
    assert.doesNotMatch(text, /"additionalProperties":true/, name);
    Compile(schema);
  };
  for (const action of getSnowLumaCatalog().actions) audit(sanitizeToolSchema(action.inputSchema), action.name);
  for (const action of telegramCatalog.actions) audit(sanitizeToolSchema(compactSchema(action.inputSchema)), action.name);
});

test('native adapter validates with pi-ai coercion, optional null stripping, and field-level ActionNotDispatchedError', async () => {
  const store = new Store(':memory:');
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const plugin = nativeAdapterPlugin({
    instance: 'demo',
    platform: 'demo',
    accountId: '1',
    version: '1.0',
    actions: [{
      name: 'send',
      summary: 'Send a demo message',
      readOnly: false,
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: ['string', 'number'] },
          count: { type: 'integer' },
          silent: { type: 'boolean' },
          tag: { type: 'string' },
        },
        required: ['chat_id', 'count'],
      },
    }],
    execute: async (op, args) => { calls.push({ op, args }); return { ok: true }; },
  }, store);
  try {
    await plugin.start!();
    // Coerces stringified integer/boolean and strips optional null.
    await plugin.nativeActions!.execute!('demo__send', { chat_id: '42', count: '3' as any, silent: 'true' as any, tag: null as any });
    assert.deepEqual(calls[0], { op: 'send', args: { chat_id: '42', count: 3, silent: true } });

    // Invalid parameters throw ActionNotDispatchedError with field-level details (never unknown outcome).
    await assert.rejects(
      plugin.nativeActions!.execute!('demo__send', { chat_id: '42', count: 'not-a-number' as any }),
      error => error instanceof ActionNotDispatchedError && /count/.test(error.message),
    );
  } finally {
    await plugin.stop!();
    store.close();
  }
});

test('prepareModelImage passes small static images through, resizes oversized images, flattens animated GIFs, and tolerates mock bytes', async () => {
  const smallPng = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
  const kept = await prepareModelImage(smallPng, 'image/png');
  assert.equal(kept.resized, false);
  assert.equal(kept.mimeType, 'image/png');
  assert.deepEqual(kept.data, smallPng);

  // Oversized image respects model.inputLimits.images.resize.
  const largePng = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 80, g: 120, b: 200 } } }).png().toBuffer();
  const resized = await prepareModelImage(largePng, 'image/png', { inputLimits: { images: { resize: { maxWidth: 800, maxHeight: 800, maxBytes: 200_000 } } } });
  assert.equal(resized.resized, true);
  assert.ok(resized.data.byteLength <= 200_000);
  const meta = await sharp(resized.data).metadata();
  assert.ok((meta.width ?? 0) <= 800 && (meta.height ?? 0) <= 800);

  // Animated 2-frame GIF is flattened to a static image.
  const rawFrames = Buffer.alloc(16 * 32 * 4, 255);
  const gif = await sharp(rawFrames, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } })
    .gif()
    .toBuffer();
  const flattened = await prepareModelImage(gif, 'image/gif');
  assert.equal(flattened.resized, true);
  assert.ok(['image/jpeg', 'image/png'].includes(flattened.mimeType));
  const flatMeta = await sharp(flattened.data).metadata();
  assert.equal(flatMeta.pages ?? 1, 1);

  // Undecodable synthetic bytes pass through gracefully without throwing.
  const mock = new Uint8Array([1, 2, 3, 4]);
  const passthrough = await prepareModelImage(mock, 'image/png');
  assert.equal(passthrough.resized, false);
  assert.deepEqual(passthrough.data, Buffer.from(mock));

  // Tool result image block normalization.
  const normalized = await normalizeImageBlocks(
    [{ type: 'text', text: 'img' }, { type: 'image', data: largePng.toString('base64'), mimeType: 'image/png' }],
    { inputLimits: { images: { resize: { maxWidth: 600, maxHeight: 600 } } } },
  );
  assert.equal(normalized.changed, true);
  const outBlock = normalized.content[1]!;
  assert.equal(outBlock.type, 'image');
  if (outBlock.type === 'image') {
    const outMeta = await sharp(Buffer.from(outBlock.data, 'base64')).metadata();
    assert.ok((outMeta.width ?? 0) <= 600);
  }
});

test('createModelBackend retries transient 503 provider errors automatically by default', async () => {
  let attempts = 0;
  const server = createServer(async (_req, res) => {
    attempts++;
    if (attempts === 1) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({ error: { message: 'temporarily overloaded' } }));
      return;
    }
    const chunk = {
      id: 'chat-retry', object: 'chat.completion.chunk', created: 1, model: 'retry-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const { model, stream } = createModelBackend({
      ...baseCustom, id: 'retry-model', reasoning: false, baseUrl: `http://127.0.0.1:${port}/v1`,
    }, () => 'key');
    const reply = await stream(model, { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] }, { maxTokens: 32 }).result();
    assert.equal(attempts, 2);
    assert.equal(reply.stopReason, 'stop');
    assert.match(JSON.stringify(reply.content), /Recovered/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('mergeConsecutiveUserMessages combines adjacent user turns cleanly and PiBrain uses it when mergeConsecutiveUsers is enabled', async () => {
  const merged = mergeConsecutiveUserMessages([
    { role: 'user', content: 'first', timestamp: 1 },
    { role: 'user', content: 'second', timestamp: 2 },
    { role: 'user', content: [{ type: 'text', text: 'third' }, { type: 'image', data: 'abc', mimeType: 'image/png' }], timestamp: 3 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.role, 'user');
  assert.ok(Array.isArray(merged[0]!.content));
  assert.equal((merged[0]!.content as any[]).length, 3);

  const f = fixture();
  f.cfg.model.mergeConsecutiveUsers = true;
  f.restart();
  try {
    event(f.store, 'First silent message');
    f.faux.setResponses([context => {
      // observation + <runtime_data> merged into a single user message on the wire!
      const roles = context.messages.map(m => m.role);
      assert.deepEqual(roles, ['system', 'user']);
      return answer('Stay silent');
    }]);
    await f.brain.run(f.store.claim(10)!);
    event(f.store, 'Second silent message');
    f.faux.setResponses([context => {
      // Previous folded silent turn + new observation + delta merged cleanly with zero consecutive user turns.
      const roles = context.messages.map(m => m.role);
      for (let i = 1; i < roles.length; i++) {
        assert.ok(!(roles[i - 1] === 'user' && roles[i] === 'user'), `Consecutive users found: ${roles.join(',')}`);
      }
      return answer('Still silent');
    }]);
    await f.brain.run(f.store.claim(10)!);
    // Internal state still preserves separate observation messages for restore/compaction.
    assert.equal(f.brain.agent.state.messages.filter(m => m.role === 'observation').length, 2);
    assert.equal(toModelMessages(f.brain.agent.state.messages, { mergeUsers: false }).filter(m => m.role === 'user').length >= 3, true);
  } finally { f.store.close(); }
});

test('PiBrain persists sessionId across restarts on the same route and performs seamless cross-model Working Context handoff', async () => {
  const cfg = config();
  cfg.adapters[0]!.tools = { allow: ['send_group_msg', 'get_msg'], deny: [] };
  cfg.plugins.gallery = false;
  const store = new Store(':memory:');
  const social = { execute: async () => ({ message_id: 7 }) };

  const fauxA = fauxProvider(); const modelsA = createModels(); modelsA.setProvider(fauxA.provider);
  const modelA = { ...fauxA.getModel(), id: 'gemini-a', baseUrl: 'https://a.example' };
  const seenSessionsA: (string | undefined)[] = [];
  const seenRetentionA: (string | undefined)[] = [];
  const backendA = {
    model: modelA,
    stream: (m: any, c: any, o: any) => {
      seenSessionsA.push(o?.sessionId);
      seenRetentionA.push(o?.cacheRetention);
      return modelsA.streamSimple(m, c, { ...o, cacheRetention: 'none' });
    },
  };

  const fauxB = fauxProvider(); const modelsB = createModels(); modelsB.setProvider(fauxB.provider);
  const modelB = { ...fauxB.getModel(), id: 'claude-b', baseUrl: 'https://b.example' };
  const seenSessionsB: (string | undefined)[] = [];
  let seenMessagesB: Message[] = [];
  const backendB = {
    model: modelB,
    stream: (m: any, c: any, o: any) => {
      seenSessionsB.push(o?.sessionId);
      seenMessagesB = structuredClone(c.messages);
      return modelsB.streamSimple(m, c, { ...o, cacheRetention: 'none' });
    },
  };

  try {
    let brainA!: PiBrain;
    const toolsA = createTools(cfg, store, social, () => brainA.thought);
    brainA = new PiBrain(cfg, store, toolsA, backendA);
    event(store, 'Tell me about the Moon');
    fauxA.setResponses([answer([{ ...call('qq_main__send_group_msg', { group_id: 100, message: 'Lunar seas!' }), thoughtSignature: 'GEMINI_SECRET_SIG' }])]);
    await brainA.run(store.claim(10)!);
    assert.ok(seenSessionsA[0]);
    assert.equal(seenRetentionA[0], 'short');

    // Restart with the SAME route: sessionId is restored and thoughtSignature stays intact.
    brainA = new PiBrain(cfg, store, toolsA, backendA);
    event(store, 'Follow-up on same model');
    fauxA.setResponses([context => {
      assert.match(JSON.stringify(context.messages), /GEMINI_SECRET_SIG/);
      return answer('Quiet');
    }]);
    await brainA.run(store.claim(10)!);
    assert.equal(seenSessionsA[1], seenSessionsA[0]);

    // Now switch to Model B (different provider/API/id): identity matches, signatures stripped, sessionId rotated, handoff logged!
    let brainB!: PiBrain;
    const toolsB = createTools(cfg, store, social, () => brainB.thought);
    assert.equal(contextIdentity(cfg, toolsB), contextIdentity(cfg, toolsA));
    brainB = new PiBrain(cfg, store, toolsB, backendB);
    event(store, 'Continue after switching models');
    fauxB.setResponses([answer('Seamless continuation')]);
    await brainB.run(store.claim(10)!);

    assert.ok(seenSessionsB[0] && seenSessionsB[0] !== seenSessionsA[0]);
    const serialized = JSON.stringify(seenMessagesB);
    assert.match(serialized, /Tell me about the Moon/);
    assert.match(serialized, /Lunar seas!/);
    assert.doesNotMatch(serialized, /GEMINI_SECRET_SIG/);
    assert.ok(store.logs(50).some(log => log.kind === 'context_model_handoff'));
  } finally { store.close(); }
});

test('PiBrain recovers once from provider context overflow and recoverable length, while honoring ADR-0008 and silent overflow', async () => {
  const f = fixture();
  f.cfg.compaction.keepRecentTokens = 200;
  f.cfg.compaction.retries = 0;
  try {
    // Seed 2 earlier turns so compaction has older history to condense.
    for (let i = 0; i < 2; i++) {
      event(f.store, `Old topic ${i}: ` + 'detail '.repeat(120));
      f.faux.setResponses([answer(call('qq_main__send_group_msg', { group_id: 100, message: `Reply ${i}: ` + 'history '.repeat(120) }))]);
      await f.brain.run(f.store.claim(10)!);
    }

    // 1. Provider returns explicit overflow error -> auto-compacts and retries once via agent.continue().
    const evt = event(f.store, 'Current question triggering server overflow');
    f.faux.setResponses([
      { ...answer(''), stopReason: 'error', errorMessage: 'prompt is too long: 213462 tokens > 200000 maximum' } as AssistantMessage,
      context => {
        assert.match(String(context.messages.at(-1)?.content), /^Internal working context consolidation:/);
        return answer('Compacted summary of Old topic 0 and 1.');
      },
      context => {
        assert.match(JSON.stringify(context.messages), /Compacted summary of Old topic 0 and 1/);
        return answer('Recovered after overflow');
      },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.store.event(evt.id)?.status, 'processed');
    assert.ok(f.store.logs(50).some(log => log.kind === 'context_overflow_recovered' && (log.data as any).reason === 'overflow'));

    // 2. Recoverable length (stopReason: 'length' with output < desiredMaxOutput and no toolCall) -> compacts and retries once.
    for (let i = 0; i < 2; i++) {
      event(f.store, `More old topic ${i}: ` + 'detail '.repeat(120));
      f.faux.setResponses([answer(call('qq_main__send_group_msg', { group_id: 100, message: `More reply ${i}: ` + 'history '.repeat(120) }))]);
      await f.brain.run(f.store.claim(10)!);
    }
    const evtLen = event(f.store, 'Question hitting recoverable length cutoff');
    f.faux.setResponses([
      { ...answer('Truncated partial'), stopReason: 'length' } as AssistantMessage,
      context => {
        assert.match(String(context.messages.at(-1)?.content), /^Internal working context consolidation:/);
        return answer('Compacted summary after length cutoff.');
      },
      context => {
        assert.match(JSON.stringify(context.messages), /Compacted summary after length cutoff/);
        return answer('Completed after length recovery');
      },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.store.event(evtLen.id)?.status, 'processed');
    assert.ok(f.store.logs(50).some(log => log.kind === 'context_overflow_recovered' && (log.data as any).reason === 'length'));

    // 3. Truncated turn with toolCall: pi-agent-core refuses to execute truncated calls (ADR-0008), returns error toolResult, and next turn finishes cleanly without triggering overflow recovery.
    const sentBefore = f.sent.length;
    const recoveredBefore = f.store.logs(50).filter(log => log.kind === 'context_overflow_recovered').length;
    event(f.store, 'Truncated turn with tool call');
    f.faux.setResponses([
      { ...answer(call('qq_main__send_group_msg', { group_id: 100, message: 'Truncated args' })), stopReason: 'length' } as AssistantMessage,
      context => {
        const lastResult = context.messages.findLast(m => m.role === 'toolResult');
        assert.ok(lastResult?.role === 'toolResult' && lastResult.isError);
        return answer('Recovered cleanly without resending');
      },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.sent.length, sentBefore);
    assert.equal(f.store.logs(50).filter(log => log.kind === 'context_overflow_recovered').length, recoveredBefore);
  } finally { f.store.close(); }
});

test('text-only compaction.model is accepted by readiness and summarizes a context containing images cleanly', async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const chunk = {
      id: 'sum', object: 'chat.completion.chunk', created: 1, model: 'text-summarizer',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Summary keeping essential facts.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const f = fixture();
  try {
    const textSummary: ModelConfig = {
      provider: 'summary-gw', id: 'text-summarizer', apiKeyEnv: 'SUM_KEY', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${port}/v1`, input: ['text'], contextWindow: 131072, maxTokens: 4096, reasoning: false,
    };
    f.cfg.model = { ...baseCustom, id: 'vision-main', reasoning: false };
    f.cfg.compaction.model = textSummary;
    f.cfg.compaction.retries = 0;
    f.cfg.compaction.keepRecentTokens = 200;
    const ready = modelReadiness(f.cfg, () => 'secret');
    assert.deepEqual(ready.problems, []);

    const { model: sumModel, stream: sumStream } = createModelBackend(textSummary, () => 'secret', { requireVision: false });
    assert.deepEqual(sumModel.input, ['text']);
    const result = await sumStream(sumModel, {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look at this photo' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], timestamp: 1 },
      ],
    }, { maxTokens: 256 }).result();
    assert.equal(result.stopReason, 'stop');
    // pi-ai's downgradeUnsupportedImages replaces the image block with a text placeholder for the text-only model!
    assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(requests[0]), /image_url|aGVsbG8=/);
    assert.match(JSON.stringify(requests[0]), /image omitted/);
  } finally {
    f.store.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('probeModel diagnoses OpenAI-completions compat flags, strict schemas, consecutive users, and mid-conversation tool stripping', async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const tools = body.tools ?? [];

    const fail = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    const sse = (delta: Record<string, unknown>, finish = 'stop') => {
      const chunk = {
        id: 'probe', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    };

    // Simulate a picky gateway: rejects developer role, max_completion_tokens, strict tools, consecutive user turns, and mid-convo tools!
    if (messages.some((m: any) => m.role === 'developer')) return fail(400, "Invalid value: 'developer' is not one of ['system', 'user', 'assistant', 'tool']");
    if ('max_completion_tokens' in body) return fail(400, 'Unknown parameter: max_completion_tokens');
    if (tools.some((t: any) => t.function?.strict === true)) return fail(400, 'strict mode is not supported by this gateway');
    for (let i = 1; i < messages.length; i++) {
      if (messages[i - 1].role === 'user' && messages[i].role === 'user') return fail(400, 'Conversation roles must alternate user/assistant');
    }
    if (messages.some((m: any) => m.role === 'tool_addition' || (m.role === 'system' && m !== messages[0]))) {
      return fail(400, 'Mid-conversation system/tool additions are unsupported');
    }

    if (tools.some((t: any) => t.function?.name === 'probe_echo') && !messages.some((m: any) => m.role === 'tool')) {
      return sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_echo_1', type: 'function', function: { name: 'probe_echo', arguments: '{"word":"ok"}' } }] }, 'tool_calls');
    }
    return sse({ role: 'assistant', content: 'OK' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const report = await probeModel({
      ...baseCustom,
      id: 'picky-gateway-model',
      reasoning: true,
      compat: { supportsStrictMode: true },
      baseUrl: `http://127.0.0.1:${port}/v1`,
    }, { credential: () => 'probe-key' });

    assert.equal(report.ok, true);
    assert.equal(report.checks.basic.status, 'pass');
    assert.equal(report.checks.compactionOff.status, 'pass');
    assert.equal(report.checks.vision.status, 'pass');
    assert.equal(report.checks.tools.status, 'pass');
    assert.equal(report.checks.consecutiveUsers.status, 'fail');
    assert.equal(report.checks.strictTools.status, 'fail');
    assert.equal(report.checks.midConvoTools.status, 'fail');
    assert.equal(report.suggestedCompat.supportsDeveloperRole, false);
    assert.equal(report.suggestedCompat.maxTokensField, 'max_tokens');
    assert.equal(report.suggestedCompat.supportsStrictMode, false);
    assert.equal(report.suggestedOptions.mergeConsecutiveUsers, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('probeModel detects when a gateway supports mid-conversation tool additions and suggests enabling in-place flags', async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const tools = body.tools ?? [];

    const sse = (delta: Record<string, unknown>, finish = 'stop') => {
      const chunk = {
        id: 'probe-mid', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    };

    if (tools.some((t: any) => t.function?.name === 'probe_echo') && !messages.some((m: any) => m.role === 'tool')) {
      return sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_echo_1', type: 'function', function: { name: 'probe_echo', arguments: '{"word":"ok"}' } }] }, 'tool_calls');
    }
    const serialized = JSON.stringify(body);
    if (serialized.includes('probe_secret_tool_xyz')) {
      return sse({ role: 'assistant', content: 'probe_secret_tool_xyz' });
    }
    return sse({ role: 'assistant', content: 'OK' });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  try {
    const report = await probeModel({
      ...baseCustom,
      id: 'capable-gateway-model',
      reasoning: false,
      baseUrl: `http://127.0.0.1:${port}/v1`,
    }, { credential: () => 'probe-key' });

    assert.equal(report.ok, true);
    assert.equal(report.checks.midConvoTools.status, 'pass');
    assert.equal(report.suggestedCompat.supportsMidConvoSystemMessages, true);
    assert.equal(report.suggestedCompat.supportsMidConvoToolAdditions, true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
