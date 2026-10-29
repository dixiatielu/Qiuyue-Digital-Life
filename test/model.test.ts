import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createModelBackend, resolveModel, type ModelConfig } from '../src/model.js';
import { PiBrain } from '../src/brain.js';
import { Store } from '../src/store.js';
import { createTools } from '../src/tools.js';
import { config, event } from './helpers.js';

const custom: ModelConfig = {
  provider: 'test-gateway', id: 'private-vision-model', apiKeyEnv: 'QIUYUE_TEST_MODEL_KEY',
  api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', input: ['text', 'image'],
  contextWindow: 131072, maxTokens: 8192,
  compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false },
};

test('built-in models retain catalog metadata and support endpoint overrides', () => {
  const builtin = builtinModels().getModels('openai').find(model => model.input.includes('image'))!;
  const cfg = { provider: builtin.provider, id: builtin.id, apiKeyEnv: 'MODEL_API_KEY' };
  assert.deepEqual(resolveModel(cfg), builtin);
  assert.deepEqual(resolveModel({ ...cfg, baseUrl: 'https://gateway.example/v1' }), { ...builtin, baseUrl: 'https://gateway.example/v1' });
  assert.throws(() => resolveModel({ ...cfg, id: 'missing-model' }), /not in the Pi model catalog/);
  assert.throws(() => resolveModel({ ...custom, input: ['text'] }), /Image understanding/);
});

test('custom model uses the declared capabilities without a catalog entry', () => {
  const model = resolveModel(custom);
  assert.equal(model.id, custom.id);
  assert.equal(model.provider, custom.provider);
  assert.equal(model.api, custom.api);
  assert.deepEqual(model.input, ['text', 'image']);
  assert.equal(model.contextWindow, 131072);
  assert.equal(model.maxTokens, 8192);
  assert.deepEqual(model.compat, custom.compat);
});

test('custom gateway handles real Pi tool cycles and preserves the remote model name and credentials', async () => {
  const requests: { path?: string; authorization?: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    const calls = [
      { name: 'load_snowluma_tools', arguments: '{"names":["send_custom_face"]}' },
      { name: 'set_activity', arguments: '{"activity":"Gateway integration"}' },
    ];
    const next = calls[requests.length - 1];
    const chunk = {
      id: 'chat-test', object: 'chat.completion.chunk', created: 1, model: custom.id,
      choices: [{ index: 0, delta: next
        ? { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: next }] }
        : { role: 'assistant', content: 'Received' }, finish_reason: next ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const cfg = config();
  cfg.model = { ...custom, baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const oldKey = process.env[custom.apiKeyEnv]; process.env[custom.apiKeyEnv] = 'gateway-test-key';
  const store = new Store(':memory:');
  let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => { throw new Error('No external action expected'); } }, () => brain.thought);
  try {
    brain = new PiBrain(cfg, store, tools);
    event(store, 'Record the current activity');
    await brain.run(store.claim(10)!);
    assert.equal(store.settings().activity, 'Gateway integration');
    assert.equal(store.pending(), 0);
    assert.equal(store.dailyCalls(), 3);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.path, '/v1/chat/completions');
      assert.equal(request.authorization, 'Bearer gateway-test-key');
      assert.equal(request.body.model, custom.id);
      assert.equal(request.body.max_tokens, 8192);
      assert.ok(request.body.tools.some((tool: any) => tool.function.name === 'set_activity'));
      assert.ok(request.body.tools.some((tool: any) => tool.function.name === 'send_custom_face'));
      assert.equal(request.body.tools.length, 223);
      assert.deepEqual(request.body.tools, requests[0]!.body.tools);
    }
    assert.ok(requests[1]!.body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'call-1'));
  } finally {
    if (oldKey === undefined) delete process.env[custom.apiKeyEnv]; else process.env[custom.apiKeyEnv] = oldKey;
    store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('explicit API selects the transport even when the provider name is arbitrary or matches a built-in', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    const { model, stream } = createModelBackend({ ...custom, provider: 'openai', api, compat: undefined, baseUrl: api === 'anthropic-messages' ? 'http://127.0.0.1:1' : custom.baseUrl });
    let target: URL | undefined;
    const result = await stream(model, { messages: [{ role: 'user', content: 'Connection test', timestamp: 1 }] }, {
      apiKey: 'explicit-test-key', maxTokens: 16,
      fetch: async (input, init) => {
        target = new URL(input instanceof Request ? input.url : String(input));
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        assert.equal(api === 'anthropic-messages' ? headers.get('x-api-key') : headers.get('authorization'), api === 'anthropic-messages' ? 'explicit-test-key' : 'Bearer explicit-test-key');
        return new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'expected test rejection' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      },
    }).result();
    assert.equal(target?.pathname, api === 'openai-completions' ? '/v1/chat/completions' : api === 'openai-responses' ? '/v1/responses' : '/v1/messages');
    assert.equal(result.stopReason, 'error');
    assert.match(result.errorMessage!, /expected test rejection/);
  }
});
