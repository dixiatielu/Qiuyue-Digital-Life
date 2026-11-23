import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { normalizeContext, Type, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import { createModelBackend, resolveModel, type ModelConfig } from '../src/model.js';
import { interactionRequest, stream } from '../src/gemini-interactions.js';
import { PiBrain } from '../src/brain.js';
import { Store } from '../src/store.js';
import { forReview } from '../src/tools.js';
import { PluginHost } from '../src/plugins.js';
import { config, createTools, event } from './helpers.js';

const hydrogen: ModelConfig = {
  provider: 'gateway', id: 'gemini-4-hydrogen', api: 'google-interactions',
  apiKeyEnv: 'GEMINI_TEST_KEY', baseUrl: 'https://gateway.example/v1beta',
  input: ['text', 'image'], contextWindow: 1048576, maxTokens: 8192, reasoning: true, thinkingLevel: 'medium',
};
type Step = { type: string; [key: string]: any };
/** The events the API sends for these steps, in the shapes recorded from gemini-4-hydrogen on 2026-11-23. */
function serverEvents(steps: Step[], status = 'completed', usage: Record<string, number> = { total_input_tokens: 100, total_output_tokens: 10, total_thought_tokens: 5, total_tokens: 115 }) {
  const events: Record<string, unknown>[] = [{ event_type: 'interaction.created', interaction: { id: '', status: 'in_progress' } }, { event_type: 'interaction.status_update', status: 'in_progress' }];
  steps.forEach((step, index) => {
    if (step.type === 'model_output') {
      const text: string = step.content[0].text; const half = Math.ceil(text.length / 2);
      events.push({ event_type: 'step.start', index, step: { type: 'model_output' } }, { event_type: 'step.delta', index, delta: { type: 'text', text: text.slice(0, half) } }, { event_type: 'step.delta', index, delta: { type: 'text', text: text.slice(half) } });
    } else if (step.type === 'function_call') {
      const { arguments: args, ...start } = step; const text = JSON.stringify(args); const half = Math.ceil(text.length / 2);
      events.push({ event_type: 'step.start', index, step: { ...start, arguments: {} } }, { event_type: 'step.delta', index, delta: { type: 'arguments_delta', arguments: text.slice(0, half) } }, { event_type: 'step.delta', index, delta: { type: 'arguments_delta', arguments: text.slice(half) } });
    } else if (step.type === 'thought') {
      events.push({ event_type: 'step.start', index, step: { type: 'thought' } });
      if (step.signature) events.push({ event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: step.signature } });
    } else {
      const { type, id, call_id, ...rest } = step;
      events.push({ event_type: 'step.start', index, step: { type, signature: '', ...(id ? { id } : {}), ...(call_id ? { call_id } : {}) } }, { event_type: 'step.delta', index, delta: { type, ...rest } });
    }
    events.push({ event_type: 'step.stop', index });
  });
  events.push({ event_type: 'interaction.completed', interaction: { id: '', status, usage } });
  return events.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const signature = (name: string) => Buffer.from(`opaque-${name}`).toString('base64');
const lookup: Step[] = [
  { type: 'thought', signature: signature('one') },
  { type: 'tool_search_call', id: 'call_search', signature: signature('two'), arguments: { function_names: ['qq_main__set_group_sign'] } },
  { type: 'thought', signature: signature('three') },
  { type: 'tool_search_result', call_id: 'call_search', signature: signature('four'), result: [{ type: 'function', name: 'default_api:qq_main__set_group_sign', description: '群签到', parameters: { type: 'object' } }] },
  { type: 'thought', signature: signature('five') },
  { type: 'function_call', id: 'call_sign', name: 'qq_main__set_group_sign', arguments: { group_id: 100 } },
];

test('a tool cycle defers seldom-used tools, replays the steps of the current turn as they came, and survives a restart without them', async () => {
  const requests: { path: string; key?: string; authorization?: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, key: request.headers['x-goog-api-key'] as string, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = requests.length === 1
      ? serverEvents(lookup, 'requires_action', { total_input_tokens: 1000, total_cached_tokens: 1900, total_output_tokens: 20, total_thought_tokens: 30, total_tool_use_tokens: 1010, total_tokens: 2060 })
      : serverEvents([{ type: 'thought', signature: signature('six') }, { type: 'model_output', content: [{ type: 'text', text: 'Signed in' }] }]);
    // Events do not arrive one to a packet.
    response.write(body.slice(0, 137)); response.end(body.slice(137));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const cfg = config();
  cfg.model = { ...hydrogen, baseUrl: `http://127.0.0.1:${address.port}/gateway/v1beta` };
  const store = new Store(':memory:');
  const sent: string[] = [];
  let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async kind => { sent.push(kind); return { signed: true }; } }, () => brain.thought);
  const credential = (name: string) => name === hydrogen.apiKeyEnv ? 'interactions-test-key' : undefined;
  const restart = () => new PiBrain(cfg, store, tools, undefined, undefined, undefined, credential);
  try {
    brain = restart();
    event(store, 'Sign in to the group');
    await brain.run(store.claim(10)!);
    assert.deepEqual(sent, ['set_group_sign']);
    assert.equal(requests.length, 2);
    const declared = (request: typeof requests[number], name: string) => request.body.tools.find((tool: any) => tool.name === name);
    for (const request of requests) {
      assert.equal(request.path, '/gateway/v1beta/interactions');
      assert.equal(request.key, 'interactions-test-key');
      assert.equal(request.authorization, undefined);
      assert.equal(request.body.model, 'gemini-4-hydrogen');
      assert.equal(request.body.store, false);
      assert.equal(request.body.stream, true);
      assert.ok(request.body.system_instruction.length > 100);
      assert.deepEqual(request.body.generation_config, { thinking_level: 'medium', thinking_summaries: 'auto', max_output_tokens: 8192 });
      assert.deepEqual(request.body.tools[0], { type: 'tool_search' });
      assert.equal(declared(request, 'qq_main__set_group_sign').defer_loading, true);
      // A deferred tool is still declared whole, so the model can load and call it by its own name.
      assert.equal(declared(request, 'qq_main__set_group_sign').parameters.properties.group_id.type, 'integer');
      for (const name of ['qq_main__send_group_msg', 'set_activity', 'remember', 'qq_main__search_snowluma_tools']) assert.equal('defer_loading' in declared(request, name), false, name);
      assert.equal(request.body.input[0].type, 'user_input');
    }
    const replayed: Step[] = requests[1]!.body.input;
    const from = replayed.findIndex(step => step.type === 'thought');
    assert.deepEqual(replayed.slice(from, from + lookup.length), lookup);
    assert.deepEqual(replayed[from + lookup.length], { type: 'function_result', name: 'qq_main__set_group_sign', call_id: 'call_sign', result: replayed[from + lookup.length]!.result });
    assert.match(replayed[from + lookup.length]!.result, /signed/);
    const first = brain.agent.state.messages.find((message): message is AssistantMessage => message.role === 'assistant')!;
    assert.equal(first.stopReason, 'toolUse');
    // The context is measured from one reading of the prompt; the further reading that loading a tool costs, and what of it was cached, are kept apart.
    assert.deepEqual({ ...first.usage, cost: undefined }, { input: 0, cacheRead: 1000, cacheWrite: 0, output: 50, reasoning: 30, totalTokens: 2060, toolUse: 1010, toolUseCacheRead: 900, cost: undefined });

    brain = restart();
    event(store, 'Thanks');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 3);
    const restored: Step[] = requests[2]!.body.input;
    // The saved context keeps no thinking, so the earlier turn returns as the call, its result and the reply.
    assert.equal(restored.some(step => ['thought', 'tool_search_call', 'tool_search_result'].includes(step.type)), false);
    assert.deepEqual(restored.find(step => step.type === 'function_call'), { type: 'function_call', id: 'call_sign', name: 'qq_main__set_group_sign', arguments: { group_id: 100 } });
    assert.ok(restored.some(step => step.type === 'function_result' && step.call_id === 'call_sign'));
    assert.ok(restored.some(step => step.type === 'model_output' && step.content[0].text === 'Signed in'));
    assert.equal(restored.at(-1)!.type, 'user_input');
    // The model has seen itself call the tool and will not search again, and the API refuses a deferred call it holds no search for.
    assert.equal('defer_loading' in declared(requests[2]!, 'qq_main__set_group_sign'), false);
    assert.equal(declared(requests[2]!, 'qq_main__get_group_honor_info').defer_loading, true);
  } finally {
    store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const model = resolveModel(hydrogen);
const tool = (name: string, description: string) => ({ name, description, parameters: Type.Object({ id: Type.String() }) });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test('requests carry images, tool errors and histories written by another model in the API\'s own shapes', () => {
  const foreign: AssistantMessage = {
    role: 'assistant', api: 'anthropic-messages', provider: 'other', model: 'other-model', usage, stopReason: 'toolUse', timestamp: 1,
    content: [{ type: 'thinking', thinking: 'private', thinkingSignature: 'sealed' }, { type: 'text', text: 'Looking' }, { type: 'toolCall', id: 'toolu|01/abc', name: 'view', arguments: { id: 'e1' }, thoughtSignature: 'sealed' }],
  };
  const own: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, stopReason: 'toolUse', timestamp: 4, content: [{ type: 'toolCall', id: 'call_2', name: 'view', arguments: { id: 'e2' } }] };
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 0 },
    foreign,
    { role: 'toolResult', toolCallId: 'toolu|01/abc', toolName: 'view', content: [{ type: 'text', text: 'Image 0' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }], isError: false, timestamp: 2 },
    { role: 'user', content: 'And the next one?', timestamp: 3 },
    own,
    { role: 'toolResult', toolCallId: 'call_2', toolName: 'view', content: [{ type: 'text', text: 'The image does not exist.' }], isError: true, timestamp: 5 },
    // A call the thought never answered is closed before the next turn.
    { ...own, content: [{ type: 'toolCall', id: 'call_3', name: 'view', arguments: { id: 'e3' } }], timestamp: 6 },
    { role: 'user', content: 'Never mind', timestamp: 7 },
  ];
  const context = normalizeContext({ systemPrompt: 'Persona', tools: [tool('view', 'View an image.'), tool('rare', '[qq account 1] 群签到\nNative operation: set_group_sign. Parameters follow the native API.')], messages });
  const request = interactionRequest(model, context, { thinkingLevel: 'low', maxTokens: 500, deferredTools: ['rare', 'not-declared'] });
  assert.equal(request.system_instruction, 'Persona');
  assert.deepEqual(request.generation_config, { thinking_level: 'low', thinking_summaries: 'auto', max_output_tokens: 500 });
  assert.deepEqual(request.tools!.map((item: any) => [item.type, item.name, item.defer_loading, item.short_description]), [['tool_search', undefined, undefined, undefined], ['function', 'view', undefined, undefined], ['function', 'rare', true, '[qq account 1] 群签到']]);
  assert.deepEqual(request.input, [
    { type: 'user_input', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', data: 'AAAA', mime_type: 'image/png' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'Looking' }] },
    { type: 'function_call', id: 'toolu_01_abc', name: 'view', arguments: { id: 'e1' } },
    { type: 'function_result', name: 'view', call_id: 'toolu_01_abc', result: [{ type: 'text', text: 'Image 0' }, { type: 'image', data: 'BBBB', mime_type: 'image/jpeg' }] },
    { type: 'user_input', content: [{ type: 'text', text: 'And the next one?' }] },
    { type: 'function_call', id: 'call_2', name: 'view', arguments: { id: 'e2' } },
    { type: 'function_result', name: 'view', call_id: 'call_2', result: 'The image does not exist.', is_error: true },
    { type: 'function_call', id: 'call_3', name: 'view', arguments: { id: 'e3' } },
    { type: 'function_result', name: 'view', call_id: 'call_3', result: 'No result provided', is_error: true },
    { type: 'user_input', content: [{ type: 'text', text: 'Never mind' }] },
  ]);
  // A deferred tool the history calls stays deferred only while the search that loaded it comes before the call.
  const rareCall: AssistantMessage = { ...own, content: [{ type: 'toolCall', id: 'call_4', name: 'rare', arguments: { id: 'e4' } }], timestamp: 8 };
  const loaded: AssistantMessage = { ...own, stopReason: 'stop', content: [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify({ type: 'tool_search_result', call_id: 's1', signature: 'c2ln', result: [{ type: 'function', name: 'default_api:rare' }] }) }], timestamp: 8 };
  const deferral = (history: Message[]) => (interactionRequest(model, normalizeContext({ tools: [tool('rare', 'Rare')], messages: [...history, { role: 'user', content: 'Next', timestamp: 9 }] }), { deferredTools: ['rare'] }).tools!.at(-1) as any).defer_loading ?? false;
  assert.equal(deferral([]), true);
  assert.equal(deferral([rareCall]), false);
  assert.equal(deferral([loaded, rareCall]), true);
  assert.equal(deferral([rareCall, loaded]), false);
  // Nothing is deferred unless the caller names it, and then there is no search tool to pay for.
  assert.deepEqual(interactionRequest(model, context).tools!.map((item: any) => item.type), ['function', 'function']);
  assert.equal('thinking_level' in interactionRequest({ ...model, reasoning: false }, context).generation_config, false);
});

test('an output cut off, an error in the stream, a refusal and an answer that was not streamed each end the request as they should', async () => {
  const context = normalizeContext({ systemPrompt: 'Persona', messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] });
  const answer = (respond: () => Response) => stream(model, context, { apiKey: 'key', fetch: async () => respond() }).result();
  const events = (body: string) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

  const cut = await answer(() => events(serverEvents([{ type: 'thought' }], 'incomplete')));
  assert.equal(cut.stopReason, 'length');
  // A thought without a signature cannot be sent back.
  assert.deepEqual(cut.content, [{ type: 'thinking', thinking: '' }]);
  assert.deepEqual(interactionRequest(model, normalizeContext({ messages: [{ role: 'user', content: 'Hello', timestamp: 0 }, cut, { role: 'user', content: 'Again', timestamp: 1 }] })).input.map((step: Step) => step.type), ['user_input', 'user_input']);

  const failed = await answer(() => events(`data: ${JSON.stringify({ event_type: 'interaction.created' })}\n\ndata: ${JSON.stringify({ event_type: 'error', error: { message: 'Request contains an invalid argument.', code: 'invalid_request' } })}\n\ndata: [DONE]\n\n`));
  assert.equal(failed.stopReason, 'error');
  assert.match(failed.errorMessage!, /invalid argument.*invalid_request/);

  const refused = await answer(() => Response.json({ error: { message: 'budget exceeded' } }, { status: 429 }));
  assert.equal(refused.stopReason, 'error');
  assert.match(refused.errorMessage!, /HTTP 429.*budget exceeded/);

  const ended = await answer(() => events(`data: ${JSON.stringify({ event_type: 'step.start', index: 0, step: { type: 'model_output' } })}\n\n`));
  assert.equal(ended.stopReason, 'error');
  assert.match(ended.errorMessage!, /ended before it completed/);

  const whole = await answer(() => Response.json({ status: 'requires_action', steps: [...lookup.slice(0, 2), { type: 'model_output', content: [{ type: 'text', text: 'One moment' }] }, lookup[5]], usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 } }));
  assert.equal(whole.stopReason, 'toolUse');
  assert.deepEqual(whole.content.map(block => block.type), ['thinking', 'thinking', 'text', 'toolCall']);
  const search = whole.content[1]!;
  assert.equal(search.type === 'thinking' && search.thinking, 'Looked up tools: qq_main__set_group_sign');
  assert.deepEqual(whole.content[3], { type: 'toolCall', id: 'call_sign', name: 'qq_main__set_group_sign', arguments: { group_id: 100 } });
  assert.deepEqual(interactionRequest(model, normalizeContext({ messages: [whole] })).input.slice(0, 4), [...lookup.slice(0, 2), { type: 'model_output', content: [{ type: 'text', text: 'One moment' }] }, lookup[5]]);
});

test('the review set defers only tools it holds, and the backend passes the names through to the transport', async () => {
  const cfg = config(); const store = new Store(':memory:');
  try {
    const tools = createTools(cfg, store, { execute: async () => ({}) }, () => ({ generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: false }));
    const names = new Set(tools.current().map(item => item.name));
    assert.ok(tools.deferred().length > 150);
    assert.ok(tools.deferred().every(name => names.has(name) && name.startsWith('qq_main__')));
    // Deferral belongs to the plugin offering the tool: a decorator's rebuilt tool keeps it, and a review defers only what it holds.
    const host = new PluginHost([{
      id: 'catalog', reviewTools: ['catalog_read'],
      tools: runtime => [{ ...runtime.jsonTool('catalog_read', 'Read', Type.Object({}), () => ({})), defer: true }, { ...runtime.jsonTool('catalog_write', 'Write', Type.Object({}), () => ({})), defer: true }, runtime.jsonTool('catalog_send', 'Send', Type.Object({}), () => ({}))],
      decorateTool: item => item.name === 'catalog_write' ? { name: item.name, label: item.label, description: 'Write, with a note', parameters: item.parameters, execute: item.execute } : item,
    }]);
    const own = createTools(cfg, store, { execute: async () => ({}) }, () => ({ generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: false }), undefined, host);
    assert.deepEqual(own.deferred(), ['catalog_read', 'catalog_write']);
    assert.equal(own.current().find(item => item.name === 'catalog_write')!.description, 'Write, with a note');
    assert.deepEqual(forReview(own).deferred(), ['catalog_read']);

    let body: any;
    const { model: resolved, stream: send } = createModelBackend(hydrogen, () => 'key');
    const context = normalizeContext({ systemPrompt: 'Persona', tools: [tool('rare', 'Rare')], messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] });
    const options = { deferredTools: ['rare'], fetch: async (_url: unknown, init?: RequestInit) => { body = JSON.parse(String(init!.body)); return new Response(serverEvents([{ type: 'model_output', content: [{ type: 'text', text: 'Hi' }] }]), { headers: { 'content-type': 'text/event-stream' } }); } };
    const reply = await send(resolved, context, options as Parameters<typeof send>[2]).result();
    assert.equal(reply.stopReason, 'stop');
    assert.deepEqual(reply.content, [{ type: 'text', text: 'Hi' }]);
    assert.equal(body.tools[1].defer_loading, true);
    // Thinking cannot be turned off, so a request that asks for none, as a summary does, asks for the least.
    assert.equal(body.generation_config.thinking_level, 'low');
    await send(resolved, context, { ...options, reasoning: 'medium' } as Parameters<typeof send>[2]).result();
    assert.equal(body.generation_config.thinking_level, 'medium');
  } finally { store.close(); }
});
