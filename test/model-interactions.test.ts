import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInitialSystemMessage, normalizeContext, Type, type AssistantMessage, type Message, type Tool } from '@earendil-works/pi-ai';
import { addsToolsInPlace, createModelBackend, resolveModel, type ModelConfig } from '../src/model.js';
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
    } else {
      events.push({ event_type: 'step.start', index, step: { type: 'thought' } });
      if (step.signature) events.push({ event_type: 'step.delta', index, delta: { type: 'thought_signature', signature: step.signature } });
    }
    events.push({ event_type: 'step.stop', index });
  });
  events.push({ event_type: 'interaction.completed', interaction: { id: '', status, usage } });
  return events.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const thought = (name: string): Step => ({ type: 'thought', signature: Buffer.from(`opaque-${name}`).toString('base64') });
const call = (id: string, name: string, args: Record<string, unknown>): Step => ({ type: 'function_call', id, name, arguments: args });
const says = (text: string): Step => ({ type: 'model_output', content: [{ type: 'text', text }] });

test('a deferred tool is asked for, declared in place without changing the request\'s tool list, and still loaded after a restart', async () => {
  const requests: { path: string; key?: string; authorization?: string; body: any }[] = [];
  const answers: Step[][] = [
    [thought('one'), call('call_find', 'find_tools', { names: ['qq_main__get_group_honor_info'] })],
    [thought('two'), call('call_honor', 'qq_main__get_group_honor_info', { group_id: 100 })],
    [thought('three'), says('User 7 does')],
    // After a restart: the loaded tool is called at once.
    [thought('four'), call('call_again', 'qq_main__get_group_honor_info', { group_id: 200 })],
    [says('Nobody yet')],
    // A tool called before it is loaded is not found, and is there for the next step.
    [thought('five'), call('call_early', 'qq_main__get_group_info', { group_id: 100 })],
    [thought('six'), call('call_late', 'qq_main__get_group_info', { group_id: 100 })],
    [says('Done')],
  ];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, key: request.headers['x-goog-api-key'] as string, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const body = serverEvents(answers[requests.length - 1]!, 'requires_action', { total_input_tokens: 1000, total_cached_tokens: 900, total_output_tokens: 20, total_thought_tokens: 30, total_tokens: 1050 });
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
  const tools = createTools(cfg, store, { execute: async (kind, args) => { sent.push(`${kind}:${args.group_id}`); return { talkative: 7 }; } }, () => brain.thought);
  const credential = (name: string) => name === hydrogen.apiKeyEnv ? 'interactions-test-key' : undefined;
  const restart = () => new PiBrain(cfg, store, tools, undefined, undefined, undefined, credential);
  const declared = (request: typeof requests[number], name: string) => request.body.tools.find((tool: any) => tool.name === name);
  try {
    brain = restart();
    event(store, 'Who holds the group honors?');
    await brain.run(store.claim(10)!);
    assert.deepEqual(sent, ['get_group_honor_info:100']);
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.path, '/gateway/v1beta/interactions');
      assert.equal(request.key, 'interactions-test-key');
      assert.equal(request.authorization, undefined);
      assert.deepEqual([request.body.model, request.body.store, request.body.stream], ['gemini-4-hydrogen', false, true]);
      assert.deepEqual(request.body.generation_config, { thinking_level: 'medium', thinking_summaries: 'auto', max_output_tokens: 8192 });
      // The tool that loads the others is the API's client-side tool search; the deferred ones are listed in the instructions and not declared.
      assert.deepEqual([declared(request, 'find_tools').type, declared(request, 'find_tools').execution], ['tool_search', 'client']);
      assert.match(request.body.system_instruction, /Tools loaded on demand\.[^\n]*\n(- [^\n]+\n)*- qq_main__get_group_honor_info: 获取群荣誉信息/);
      assert.equal(declared(request, 'qq_main__get_group_honor_info'), undefined);
      for (const name of ['qq_main__send_group_msg', 'set_activity', 'remember']) assert.equal(declared(request, name).type, 'function', name);
      // The instructions name an activity's tools, and a model calls what it is told of by name, so those are declared from the start.
      assert.match(request.body.system_instruction, /Available tools: qq_main__set_group_sign/);
      assert.equal(declared(request, 'qq_main__set_group_sign').type, 'function');
      assert.doesNotMatch(request.body.system_instruction, /- qq_main__set_group_sign:/);
      // Loading leaves the request's tool list, and so the cached prefix, as it was.
      assert.deepEqual(request.body.tools, requests[0]!.body.tools);
      assert.equal(request.body.input[0].type, 'user_input');
    }
    const found: Step = requests[1]!.body.input.at(-1);
    assert.deepEqual([found.type, found.name, found.call_id], ['function_result', 'find_tools', 'call_find']);
    assert.match(found.result[0].text, /"status":"loaded".*"returnsSchema"/);
    assert.deepEqual(found.result.slice(1).map((item: any) => [item.type, item.name, item.parameters.properties.group_id.type]), [['function', 'qq_main__get_group_honor_info', 'integer']]);
    // Within the turn the API's steps return as they came.
    assert.deepEqual(requests[1]!.body.input.slice(-3, -1), answers[0]);
    assert.deepEqual(requests[2]!.body.input.slice(-6, -4), answers[0]);
    assert.deepEqual(requests[2]!.body.input.slice(-3, -1), answers[1]);
    assert.match(requests[2]!.body.input.at(-1).result, /talkative/);
    const first = brain.agent.state.messages.find((message): message is AssistantMessage => message.role === 'assistant')!;
    assert.deepEqual({ ...first.usage, cost: undefined }, { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, reasoning: 30, totalTokens: 1050, cost: undefined });
    assert.equal(first.stopReason, 'toolUse');

    brain = restart();
    event(store, 'And in the other group?');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 5);
    assert.deepEqual(sent, ['get_group_honor_info:100', 'get_group_honor_info:200']);
    const restored: Step[] = requests[3]!.body.input;
    // The saved context keeps no thinking, and the loaded tool is still declared where it was loaded.
    assert.equal(restored.some(step => step.type === 'thought'), false);
    assert.deepEqual(restored.find(step => step.type === 'function_result' && step.name === 'find_tools')!.result.at(-1).name, 'qq_main__get_group_honor_info');
    assert.deepEqual(requests[3]!.body.tools, requests[0]!.body.tools);

    event(store, 'What is this group called?');
    await brain.run(store.claim(10)!);
    assert.equal(requests.length, 8);
    assert.deepEqual(sent.at(-1), 'get_group_info:100');
    const early: Step = requests[6]!.body.input.at(-1);
    assert.deepEqual([early.call_id, early.is_error, early.result], ['call_early', true, 'Tool qq_main__get_group_info not found']);
    // With no result of find_tools to carry it, the tool joins the request's list.
    assert.equal(declared(requests[5]!, 'qq_main__get_group_info'), undefined);
    assert.equal(declared(requests[6]!, 'qq_main__get_group_info').type, 'function');
    assert.equal(requests[6]!.body.tools.length, requests[0]!.body.tools.length + 1);
  } finally {
    store.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const model = resolveModel(hydrogen);
const tool = (name: string, description: string): Tool => ({ name, description, parameters: Type.Object({ id: Type.String() }) });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const own = (content: AssistantMessage['content'], timestamp: number, stopReason: AssistantMessage['stopReason'] = 'toolUse'): AssistantMessage => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp, content });

test('requests carry images, tool errors and histories written by another model in the API\'s own shapes', () => {
  const foreign: AssistantMessage = {
    role: 'assistant', api: 'anthropic-messages', provider: 'other', model: 'other-model', usage, stopReason: 'toolUse', timestamp: 1,
    content: [{ type: 'thinking', thinking: 'private', thinkingSignature: 'sealed' }, { type: 'text', text: 'Looking' }, { type: 'toolCall', id: 'toolu|01/abc', name: 'view', arguments: { id: 'e1' }, thoughtSignature: 'sealed' }],
  };
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 0 },
    foreign,
    { role: 'toolResult', toolCallId: 'toolu|01/abc', toolName: 'view', content: [{ type: 'text', text: 'Image 0' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }], isError: false, timestamp: 2 },
    { role: 'user', content: 'And the next one?', timestamp: 3 },
    own([{ type: 'toolCall', id: 'call_2', name: 'view', arguments: { id: 'e2' } }], 4),
    { role: 'toolResult', toolCallId: 'call_2', toolName: 'view', content: [{ type: 'text', text: 'The image does not exist.' }], isError: true, timestamp: 5 },
    // A call the thought never answered is closed before the next turn.
    own([{ type: 'toolCall', id: 'call_3', name: 'view', arguments: { id: 'e3' } }], 6),
    { role: 'user', content: 'Never mind', timestamp: 7 },
  ];
  const context = normalizeContext({ systemPrompt: 'Persona', tools: [tool('view', 'View an image.')], messages });
  const request = interactionRequest(model, context, { thinkingLevel: 'low', maxTokens: 500 });
  assert.equal(request.system_instruction, 'Persona');
  assert.deepEqual(request.generation_config, { thinking_level: 'low', thinking_summaries: 'auto', max_output_tokens: 500 });
  assert.deepEqual(request.tools!.map((item: any) => [item.type, item.name]), [['function', 'view']]);
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
  assert.equal('thinking_level' in interactionRequest({ ...model, reasoning: false }, context).generation_config, false);
});

test('a tool added to the transcript is declared in the loader\'s result, or in the request\'s list when there is none or one was removed', () => {
  const finder = tool('find_tools', 'Find tools.'); const view = tool('view', 'View.'); const rare = tool('rare', 'Rare.'); const other = tool('other', 'Other.');
  const asked: Message[] = [
    { role: 'user', content: 'Use the rare one', timestamp: 1 },
    own([{ type: 'toolCall', id: 'call_f', name: 'find_tools', arguments: { names: ['rare'] } }, { type: 'toolCall', id: 'call_v', name: 'view', arguments: { id: 'e1' } }], 2),
    { role: 'toolResult', toolCallId: 'call_f', toolName: 'find_tools', content: [{ type: 'text', text: 'rare: loaded' }], isError: false, timestamp: 3 },
    { role: 'toolResult', toolCallId: 'call_v', toolName: 'view', content: [{ type: 'text', text: 'seen' }], isError: false, timestamp: 4 },
  ];
  const transcript = (...later: Message[]) => normalizeContext({ messages: [createInitialSystemMessage('Persona', [finder, view])!, ...asked, ...later] });
  const added = (tools: Tool[], content = ''): Message => ({ role: 'system', content, toolsAdded: tools, timestamp: 5 });
  const declaration = (item: Tool) => ({ type: 'function', name: item.name, description: item.description, parameters: item.parameters });
  const shape = (request: ReturnType<typeof interactionRequest>) => request.tools!.map((item: any) => `${item.name}:${item.type}${item.execution ? `/${item.execution}` : ''}`);

  const inPlace = interactionRequest(model, transcript(added([rare]), own([{ type: 'text', text: 'Loaded' }], 6, 'stop'), added([other])), { toolLoader: 'find_tools' });
  assert.deepEqual(shape(inPlace), ['find_tools:tool_search/client', 'view:function', 'other:function']);
  // The first addition joins the loader's result, past the other result of the same turn; the second has no result to join.
  assert.deepEqual(inPlace.input.slice(2, 4), [
    { type: 'function_call', id: 'call_v', name: 'view', arguments: { id: 'e1' } },
    { type: 'function_result', name: 'find_tools', call_id: 'call_f', result: [{ type: 'text', text: 'rare: loaded' }, declaration(rare)] },
  ]);

  // Without a loader every tool is in the request's list, as for an API that cannot do otherwise.
  assert.deepEqual(shape(interactionRequest(model, transcript(added([rare])))), ['find_tools:function', 'view:function', 'rare:function']);
  // A removal cannot be made in place, so the list is rebuilt as of the removal.
  const removed: Message = { role: 'system', content: '', toolsRemoved: [{ name: 'view' }], timestamp: 6 };
  const rebuilt = interactionRequest(model, transcript(added([rare]), removed), { toolLoader: 'find_tools' });
  assert.deepEqual(shape(rebuilt), ['find_tools:tool_search/client', 'rare:function']);
  assert.equal(rebuilt.input.find((step: Step) => step.name === 'find_tools' && step.type === 'function_result')!.result, 'rare: loaded');
  // A later instruction is folded into the one the request carries.
  assert.equal(interactionRequest(model, transcript(added([rare], 'Speak plainly.')), { toolLoader: 'find_tools' }).system_instruction, 'Persona\n\nSpeak plainly.');
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

  const steps = [thought('one'), says('One moment'), call('call_sign', 'qq_main__set_group_sign', { group_id: 100 })];
  const whole = await answer(() => Response.json({ status: 'requires_action', steps, usage: { total_input_tokens: 10, total_output_tokens: 2, total_tokens: 12 } }));
  assert.equal(whole.stopReason, 'toolUse');
  assert.deepEqual(whole.content.map(block => block.type), ['thinking', 'text', 'toolCall']);
  assert.deepEqual(whole.content[2], { type: 'toolCall', id: 'call_sign', name: 'qq_main__set_group_sign', arguments: { group_id: 100 } });
  assert.deepEqual(interactionRequest(model, normalizeContext({ messages: [whole] })).input.slice(0, 3), steps);
});

test('tools wait to be asked for only under a model that can take them mid-conversation, and each thinking process loads its own', async () => {
  const cfg = config(); const store = new Store(':memory:');
  const thoughtContext = () => ({ generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false });
  const names = (items: { name: string }[]) => items.map(item => item.name);
  try {
    // The example configuration's model takes a new tool only by replacing its tool list, so nothing is held back.
    const plain = createTools(cfg, store, { execute: async () => ({}) }, thoughtContext);
    assert.equal(plain.loading.enabled, false);
    assert.deepEqual(plain.deferred(), []);
    assert.deepEqual(names(plain.declared()), names(plain.current()));
    assert.match(plain.current().find(item => item.name === 'find_tools')!.description, /Every tool is already callable/);

    cfg.model = hydrogen;
    const tools = createTools(cfg, store, { execute: async () => ({}) }, thoughtContext);
    const waiting = names(tools.deferred());
    assert.ok(tools.loading.enabled && waiting.length > 150 && waiting.every(name => name.startsWith('qq_main__')));
    assert.deepEqual(names(tools.declared()), names(tools.current()).filter(name => !waiting.includes(name)));
    assert.equal(tools.deferred().find(item => item.name === 'qq_main__get_group_honor_info')!.summary, '获取群荣誉信息');
    const find = async (set: typeof tools, asked: string[]) => JSON.parse(((await set.current().find(item => item.name === 'find_tools')!.execute('find', { names: asked })).content[0] as { text: string }).text);
    const answer = await find(tools, ['get_group_honor_info', 'qq_main__send_group_msg']);
    assert.deepEqual(answer.tools.map((item: any) => [item.name, item.status]), [['qq_main__get_group_honor_info', 'loaded'], ['qq_main__send_group_msg', 'available']]);
    assert.match(answer.note, /callable from your next step/);
    assert.equal((await find(tools, ['qq_main__get_group_honor_info'])).tools[0].status, 'available');
    assert.ok(names(tools.declared()).includes('qq_main__get_group_honor_info'));
    // The list in the instructions does not change as tools are loaded, or the prompt would.
    assert.deepEqual(names(tools.deferred()), waiting);
    assert.deepEqual([tools.loading.add('qq_main__get_group_info'), tools.loading.add('qq_main__get_group_info'), tools.loading.add('remember'), tools.loading.add('nothing')], [true, false, false, false]);
    // A restored context has loaded what it declares; a new one, nothing.
    tools.loading.restore(['remember', 'qq_main__get_group_member_list', 'gone']);
    assert.deepEqual(names(tools.declared()).filter(name => waiting.includes(name)), ['qq_main__get_group_member_list']);
    tools.loading.restore([]);
    assert.equal(names(tools.declared()).some(name => waiting.includes(name)), false);

    // Deferral belongs to the plugin offering the tool: a decorator's rebuilt tool keeps it, and a review holds and loads only its own.
    const host = new PluginHost([{
      id: 'catalog', reviewTools: ['catalog_read'],
      tools: runtime => [{ ...runtime.jsonTool('catalog_read', 'Read', Type.Object({}), () => ({})), defer: true, documentation: () => ({ returns: 'pages' }) }, { ...runtime.jsonTool('catalog_write', 'Write', Type.Object({}), () => ({})), defer: true }, runtime.jsonTool('catalog_send', 'Send', Type.Object({}), () => ({}))],
      decorateTool: item => item.name === 'catalog_write' ? { name: item.name, label: item.label, description: 'Write, with a note', parameters: item.parameters, execute: item.execute } : item,
    }]);
    const main = createTools(cfg, store, { execute: async () => ({}) }, thoughtContext, undefined, host);
    assert.deepEqual(main.deferred(), [{ name: 'catalog_read', summary: 'Read' }, { name: 'catalog_write', summary: 'Write, with a note' }]);
    const review = forReview(main);
    assert.deepEqual(review.deferred(), [{ name: 'catalog_read', summary: 'Read' }]);
    assert.ok(names(review.current()).includes('find_tools') && !names(review.current()).includes('catalog_send'));
    assert.deepEqual((await find(review, ['catalog_read', 'catalog_write'])).tools, [{ name: 'catalog_read', status: 'loaded', description: 'Read', documentation: { returns: 'pages' } }]);
    assert.ok(names(review.declared()).includes('catalog_read') && !names(main.declared()).includes('catalog_read'));
    // The review's own model decides whether its tools wait.
    cfg.review = { model: { provider: 'openai', id: 'not-a-model', apiKeyEnv: 'KEY' } };
    assert.equal(forReview(main).loading.enabled, false);
  } finally { store.close(); }
});

test('Pi\'s transports declare a loaded tool in place for Anthropic and OpenAI Responses models that accept it', async () => {
  const base = { provider: 'gateway', apiKeyEnv: 'KEY', baseUrl: 'https://gateway.example/v1', input: ['text', 'image'] as ('text' | 'image')[], contextWindow: 200000, maxTokens: 8192 };
  const finder = tool('find_tools', 'Find tools.'); const rare = tool('rare', 'Rare.');
  const context = normalizeContext({ messages: [
    createInitialSystemMessage('Persona', [finder])!, { role: 'user', content: 'Use the rare one', timestamp: 1 },
    { role: 'system', content: '', toolsAdded: [rare], timestamp: 2 }, { role: 'user', content: 'Go on', timestamp: 3 },
  ] });
  const payload = async (cfg: ModelConfig) => {
    const { model: resolved, stream: send } = createModelBackend(cfg, () => 'key'); let body: any;
    await send(resolved, context, { onPayload: (sent: unknown) => { body = sent; throw new Error('captured'); } }).result();
    return { resolved, body };
  };
  const claude = await payload({ ...base, id: 'claude', api: 'anthropic-messages', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } });
  assert.equal(addsToolsInPlace(claude.resolved), true);
  assert.match(JSON.stringify(claude.body.messages), /"type":"tool_addition".*"name":"rare"/);
  const gpt = await payload({ ...base, id: 'gpt', api: 'openai-responses', compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true } });
  assert.equal(addsToolsInPlace(gpt.resolved), true);
  assert.deepEqual(gpt.body.input.filter((item: any) => item.type === 'additional_tools').map((item: any) => item.tools.map((added: any) => added.name)), [['find_tools'], ['rare']]);
  // Without the flags a new tool replaces the request's list, so addsToolsInPlace stays false; google-generative-ai still loads seldom-used tools on demand to stay within Gemini's tool cap (ADR-0023).
  for (const cfg of [{ ...base, id: 'claude', api: 'anthropic-messages' as const }, { ...base, id: 'gpt', api: 'openai-responses' as const }, { ...base, id: 'gemini', api: 'google-generative-ai' as const }]) assert.equal(addsToolsInPlace(resolveModel(cfg)), false, cfg.api);
  assert.equal(addsToolsInPlace(model), true);

  const geminiCfg = config();
  geminiCfg.model = { ...base, id: 'gemini-4-hydrogen', api: 'google-generative-ai' };
  const store = new Store(':memory:');
  try {
    const tools = createTools(geminiCfg, store, { execute: async () => ({}) }, () => ({ generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false }));
    assert.equal(tools.loading.enabled, true);
    assert.ok(tools.declared().length < 128 && tools.deferred().length > 150);
    assert.equal(tools.loading.add('qq_main__get_group_info'), true);
    assert.ok(tools.declared().some(item => item.name === 'qq_main__get_group_info'));
  } finally { store.close(); }
});
