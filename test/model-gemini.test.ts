import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { createModelBackend, resolveModel, type ModelConfig } from '../src/model.js';
import { PiBrain } from '../src/brain.js';
import { Store } from '../src/store.js';
import { remoteModels, type ProviderProfile } from '../src/webui/providers.js';
import { config, createTools, event } from './helpers.js';

const gemini: ModelConfig = {
  provider: 'openai', id: 'gemini-3-flash-preview', api: 'google-generative-ai',
  apiKeyEnv: 'GEMINI_TEST_KEY', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192, reasoning: true, thinkingLevel: 'medium',
};

test('Gemini native models accept custom endpoints and reject compatibility options from other APIs', () => {
  assert.equal(resolveModel(gemini).api, 'google-generative-ai');
  assert.doesNotThrow(() => resolveModel({ ...gemini, compat: {} }));
  for (const compat of [{ supportsStore: false }, { thinkingFormat: 'google' }, null, []]) {
    assert.throws(() => resolveModel({ ...gemini, compat: compat as never }), /model.compat/);
  }
  const builtin = builtinModels().getModels('google').find(model => model.input.includes('image'))!;
  assert.equal(resolveModel({ provider: 'google', id: builtin.id, apiKeyEnv: gemini.apiKeyEnv }).api, 'google-generative-ai');
});

test('Gemini native runs a Pi tool cycle and replays thought signatures after a brain restart', async () => {
  const requests: { path: string; key?: string; authorization?: string; body: any }[] = [];
  const signature = Buffer.from('opaque-tool-signature').toString('base64');
  const textSignature = Buffer.from('opaque-text-signature').toString('base64');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, key: request.headers['x-goog-api-key'] as string, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    const parts = requests.length === 1
      ? [{ functionCall: { name: 'set_activity', args: { activity: 'Gemini native integration' } }, thoughtSignature: signature }]
      : [{ text: 'Received', thoughtSignature: textSignature }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const cfg = config();
  cfg.model = { ...gemini, baseUrl: `http://127.0.0.1:${address.port}/gateway/v1beta` };
  const store = new Store(':memory:');
  let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => { throw new Error('No external action expected'); } }, () => brain.thought);
  const credential = (name: string) => name === gemini.apiKeyEnv ? 'native-test-key' : undefined;
  const restart = () => new PiBrain(cfg, store, tools, undefined, undefined, undefined, credential);
  try {
    brain = restart();
    event(store, 'Record the current activity');
    await brain.run(store.claim(10)!);
    assert.equal(store.settings().activity, 'Gemini native integration');
    assert.equal(requests.length, 2);
    assert.equal(store.pending(), 0);
    brain = restart();
    event(store, 'Keep the same activity');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 3);
    for (const sent of requests) {
      assert.equal(sent.path, '/gateway/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse');
      assert.equal(sent.key, 'native-test-key');
      assert.equal(sent.authorization, undefined);
      assert.ok(sent.body.systemInstruction.parts.some((part: any) => part.text));
      assert.equal(sent.body.generationConfig.maxOutputTokens, 8192);
      assert.deepEqual(sent.body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'MEDIUM' });
      assert.ok(sent.body.tools[0].functionDeclarations.some((tool: any) => tool.name === 'set_activity'));
    }
    for (const sent of requests.slice(1)) {
      const parts = sent.body.contents.flatMap((content: any) => content.parts);
      const call = parts.find((part: any) => part.functionCall);
      assert.equal(call.thoughtSignature, signature);
      assert.equal(call.functionCall.name, 'set_activity');
      assert.ok(parts.some((part: any) => part.functionResponse?.name === 'set_activity'));
    }
    // The reply that called no tool stays as her note (ADR-0024) and replays with its own signature, as the call does with its.
    assert.ok(requests[2]!.body.contents.some((content: any) => content.role === 'model' && content.parts.some((part: any) => part.text === 'Received' && part.thoughtSignature === textSignature)));
  } finally {
    store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Gemini fresh context after a prompt change seeds recent chat actions with their genuine thought signatures', async () => {
  const requests: { body: any }[] = [];
  const sendSignature = Buffer.from('real-send-thought-signature').toString('base64');
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()) });
    const parts = requests.length === 1
      ? [{ functionCall: { name: 'qq_main__send_group_msg', args: { group_id: 100, message: 'Akizuki' } }, thoughtSignature: sendSignature }]
      : [{ text: 'Quiet' }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const cfg = config();
  cfg.model = { ...gemini, baseUrl: `http://127.0.0.1:${address.port}/gateway/v1beta` };
  const store = new Store(':memory:');
  let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => ({ message_id: 99 }) }, () => brain.thought);
  const credential = (name: string) => name === gemini.apiKeyEnv ? 'native-test-key' : undefined;
  try {
    brain = new PiBrain(cfg, store, tools, undefined, undefined, undefined, credential);
    event(store, 'How do you pronounce your name?');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 1);

    // Change persona to force a fresh working context identity on the same model.
    cfg.persona = 'Qiuyue, refreshed persona.';
    brain = new PiBrain(cfg, store, tools, undefined, undefined, undefined, credential);
    event(store, 'Just chatting about compilers');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 2);

    const contents = requests[1]!.body.contents;
    assert.equal(contents[0].role, 'user');
    assert.match(JSON.stringify(contents[0]), /How do you pronounce your name/);
    assert.equal(contents[1].role, 'model');
    const seededCall = contents[1].parts.find((part: any) => part.functionCall);
    assert.equal(seededCall.functionCall.name, 'qq_main__send_group_msg');
    assert.equal(seededCall.thoughtSignature, sendSignature);
    assert.equal(contents[2].role, 'user');
    assert.ok(contents[2].parts.some((part: any) => part.functionResponse?.name === 'qq_main__send_group_msg'));
  } finally {
    store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const profile: ProviderProfile = { id: 'native', name: 'Gemini', api: 'google-generative-ai', baseUrl: 'https://gateway.example/google/v1beta/', apiKeyEnv: 'GEMINI_KEY' };

test('Gemini model listings use native authentication, pagination and generation model names', async () => {
  const urls: string[] = [];
  const models = await remoteModels(profile, async (input, init) => {
    const url = new URL(String(input)); urls.push(url.href);
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'file-native-key');
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    assert.equal(url.searchParams.get('key'), null);
    if (urls.length === 1) return Response.json({ models: [
      { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent', 'countTokens'] },
      { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/count-only', supportedGenerationMethods: ['countTokens'] },
      {},
    ], nextPageToken: 'next/+=' });
    assert.equal(url.searchParams.get('pageToken'), 'next/+=');
    return Response.json({ models: [{ name: 'models/gemini-flash', supportedGenerationMethods: ['streamGenerateContent'] }, { name: 'models/gemini-pro' }, { name: 'gateway-alias' }] });
  }, name => name === profile.apiKeyEnv ? 'file-native-key' : undefined);
  assert.deepEqual(models, ['gateway-alias', 'gemini-flash', 'gemini-pro']);
  assert.equal(urls.length, 2);
  assert.equal(urls[0], 'https://gateway.example/google/v1beta/models');
});

test('Gemini listing reports native errors and stops when pagination repeats', async () => {
  await assert.rejects(remoteModels(profile, async () => new Response('', { status: 401 }), () => undefined), /HTTP 401/);
  await assert.rejects(remoteModels(profile, async () => Response.json({ data: [{ id: 'wrong-api' }] }), () => undefined), /did not return a model list/);
  let requests = 0;
  await assert.rejects(remoteModels(profile, async () => {
    requests++;
    return Response.json({ models: [], nextPageToken: 'repeated' });
  }, () => undefined), /repeated a page token/);
  assert.equal(requests, 2);
});

test('custom Gemini thinking-level models fall back to a supported thinkingLevel instead of thinkingBudget 0 when thinking is off', async () => {
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Summary.' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}/gateway/v1beta`;
  const credential = (name: string) => name === gemini.apiKeyEnv ? 'native-test-key' : undefined;
  try {
    const cases = [
      { id: 'gemini-4-hydrogen', expected: { thinkingLevel: 'LOW' } },
      { id: 'gemini-3-flash-preview', expected: { thinkingLevel: 'MINIMAL' } },
      { id: 'gemini-2.5-flash', expected: { thinkingBudget: 0 } },
    ];
    for (const item of cases) {
      const { model, stream } = createModelBackend({ ...gemini, id: item.id, baseUrl, thinkingLevel: 'off' }, credential);
      const result = await stream(model, { messages: [{ role: 'user', content: 'Summarize', timestamp: 1 }] }, { reasoning: undefined, maxTokens: 1024 }).result();
      assert.equal(result.stopReason, 'stop');
      assert.deepEqual(requests.at(-1)!.body.generationConfig.thinkingConfig, item.expected);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
