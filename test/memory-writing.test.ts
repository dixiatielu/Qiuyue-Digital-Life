import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentTools, type Message } from '@earendil-works/pi-ai';
import { event, fixture } from './helpers.js';
import { pruneToolResults } from '../src/context.js';
import { createModelBackend } from '../src/model.js';
import { handleControl } from '../src/control.js';

const results = (messages: Message[]) => messages.filter(message => message.role === 'toolResult');

test('remember requests strict schemas only on providers that support them, without a network request', async () => {
  const f = fixture();
  try {
    const remember = f.reviewTools.current().find(tool => tool.name === 'remember')!;
    for (const supportsStrictMode of [false, true]) {
      const backend = createModelBackend({ provider: 'test-gateway', id: 'review', apiKeyEnv: 'TEST', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', input: ['text', 'image'], contextWindow: 1048576, maxTokens: 4096, compat: { supportsStrictMode } }, () => 'test');
      let definition: any; let network = false;
      await (await backend.stream(backend.model, { messages: [{ role: 'user', content: 'Synthetic schema check', timestamp: 1 }], tools: [remember] }, {
        onPayload(payload) {
          definition = (payload as any).tools.find((tool: any) => tool.function.name === 'remember').function;
          throw new Error('Checked payload; stop before transport');
        },
        fetch: async () => { network = true; throw new Error('Unexpected network request'); },
      })).result();
      assert.equal(network, false); assert.ok(definition);
      assert.equal(definition.strict, supportsStrictMode ? true : undefined);
      assert.ok(definition.parameters.required.includes('kind'));
      if (supportsStrictMode) {
        assert.equal(definition.parameters.additionalProperties, false);
        assert.ok(definition.parameters.required.includes('supersedes'));
        assert.ok(definition.parameters.properties.supersedes.anyOf.some((schema: any) => schema.type === 'null'));
      }
    }
  } finally { f.store.close(); }
});

test('a review receives the configured memory budgets and can recover a pruned record', async () => {
  const f = fixture();
  try {
    f.cfg.development.personChars = 500; f.cfg.development.scopeChars = 1500; f.restart();
    const source = event(f.store);
    const original: Message = { role: 'toolResult', toolCallId: 'old', toolName: 'read_chat_record', content: [{ type: 'text', text: `Beginning\n${'Evidence\n'.repeat(3000)}The original source is ${source.id}\nEnd` }], isError: false, timestamp: 1 };
    const [id] = f.store.archiveContext([original], [source.id]);
    const pruned = pruneToolResults([original], 0);
    assert.match(JSON.stringify(pruned.messages), new RegExp(`read_context.*${id}`));
    f.reviewFaux.setResponses([
      context => {
        const tools = getCurrentTools(context.messages);
        assert.ok(tools.some(tool => tool.name === 'read_context'));
        const remember = tools.find(tool => tool.name === 'remember')!;
        assert.match(remember.description, /500/); assert.match(remember.description, /1500/);
        assert.match(remember.description, /kind/);
        return answer(call('read_context', { id }));
      },
      context => {
        const result = results(context.messages).at(-1)!;
        assert.equal(result.isError, false);
        assert.match(JSON.stringify(result.content), /Beginning/);
        assert.match(JSON.stringify(result.content), /nextOffset/);
        return answer('Reviewed');
      },
    ]);
    await f.reviewer.review({ batchId: 'review:test', events: [source] });
  } finally { f.store.close(); }
});

test('a review gets concise combined memory errors before retrying a valid write', async () => {
  const f = fixture();
  try {
    const source = event(f.store);
    const invalid = { title: 'Someone', content: 'PRIVATE_BODY_'.repeat(1000), importance: 5, scope: 'person:qq:user:7', sources: ['#00000000', '#ffffffff'] };
    f.reviewFaux.setResponses([
      answer(call('remember', invalid)),
      context => {
        const result = results(context.messages).at(-1)!;
        const text = JSON.stringify(result.content);
        assert.equal(result.isError, true);
        assert.match(text, /kind/); assert.match(text, /#00000000/); assert.match(text, /#ffffffff/);
        assert.doesNotMatch(text, /PRIVATE_BODY_|Received arguments/);
        assert.ok(text.length < 2000, text);
        return answer(call('remember', { ...invalid, kind: 'impression', content: 'x'.repeat(601), sources: [source.id, '#00000000', '#ffffffff'] }));
      },
      context => {
        const result = results(context.messages).at(-1)!;
        const text = JSON.stringify(result.content);
        assert.equal(result.isError, true);
        assert.match(text, /601/); assert.match(text, /600/);
        assert.match(text, /#00000000/); assert.match(text, /#ffffffff/);
        assert.equal(f.store.development(['person:qq:user:7']).length, 0);
        return answer(call('remember', { kind: 'impression', title: 'Someone', content: 'Said hello', importance: 5, scope: 'person:qq:user:7', sources: [source.id], supersedes: null, subjects: null, fictional: null }));
      },
      context => {
        assert.equal(results(context.messages).at(-1)!.isError, false);
        assert.equal(f.store.development(['person:qq:user:7']).length, 1);
        return answer('Reviewed');
      },
    ]);
    await f.reviewer.review({ batchId: 'review:test', events: [source] });
  } finally { f.store.close(); }
});

test('direct memory writes report every invalid source and the available character budget without writing', () => {
  const f = fixture();
  try {
    const source = event(f.store);
    const base = { kind: 'practice' as const, title: 'Style', content: 'x'.repeat(50), importance: 5, sources: [source.id] };
    f.store.writeMemory(base, false, { scopeChars: 60, personChars: 40 });
    assert.throws(() => f.store.writeMemory({ ...base, content: 'y'.repeat(30), sources: [source.id, '#00000000', '#ffffffff'] }, false, { scopeChars: 60, personChars: 40 }), error => {
      const text = String(error);
      assert.match(text, /#00000000/); assert.match(text, /#ffffffff/);
      assert.match(text, /80 characters.*60/); assert.match(text, /10 characters/);
      return true;
    });
    assert.equal(f.store.development(['global']).length, 1);
  } finally { f.store.close(); }
});

test('memory budgets count Unicode code points consistently before and after storage', async () => {
  const f = fixture();
  try {
    f.cfg.development.personChars = 40; f.cfg.development.scopeChars = 40; f.restart();
    const source = event(f.store);
    const remember = f.reviewTools.current().find(tool => tool.name === 'remember')!;
    const args = { kind: 'impression' as const, title: 'P7', content: '🙂'.repeat(40), importance: 5, scope: 'person:qq:user:7', sources: [source.id] };
    await remember.prepareArguments!(args);
    const impression = f.store.writeMemory(args, false, f.cfg.development);
    assert.deepEqual(f.store.inspectMemoryWrite({ ...args, supersedes: impression.id }, f.cfg.development).problems, []);
    assert.match(f.store.inspectMemoryWrite({ ...args, content: args.content + '字', supersedes: impression.id }, f.cfg.development).problems.join('\n'), /41 characters.*limit of 40/);
    const practice = { ...args, kind: 'practice' as const, scope: 'global', content: '🙂'.repeat(30) };
    f.store.writeMemory(practice, false, f.cfg.development);
    f.store.writeMemory({ ...practice, content: '🙂'.repeat(10) }, false, f.cfg.development);
    assert.match(f.store.inspectMemoryWrite({ ...practice, content: '字' }, f.cfg.development).problems.join('\n'), /41 characters.*limit of 40/);
    const note = { ...args, kind: 'note' as const, title: '🙂'.repeat(200), content: '🙂'.repeat(12_000) };
    await remember.prepareArguments!(note);
    const saved = f.store.writeMemory(note, false);
    assert.throws(() => f.store.writeMemory({ ...note, content: note.content + '字' }, false), /too long/);
    assert.throws(() => handleControl(f.store, { args: ['memory', 'correct', saved.id, note.content + '字'] }), /too long/);
    assert.doesNotThrow(() => handleControl(f.store, { args: ['memory', 'correct', saved.id, note.content] }));
  } finally { f.store.close(); }
});
