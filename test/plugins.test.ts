import test from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
import { createPlugins, pluginCredentials } from '../src/plugins/index.js';
import { webReaderPlugin } from '../src/plugins/web-reader.js';
import { webSearchPlugin } from '../src/plugins/web-search.js';
import { qzoneSharePlugin } from '../src/plugins/qzone-share.js';
import { ToolRuntime, type ThoughtContext } from '../src/tool-runtime.js';
import { Store } from '../src/store.js';
import { config, event, fixture } from './helpers.js';

test('plugin switches are independent, honor legacy switches, and block an already held tool', async () => {
  const f = fixture(undefined, undefined, undefined, (_store, cfg) => {
    cfg.web.enabled = true;
    return [webReaderPlugin(cfg), webSearchPlugin(cfg), qzoneSharePlugin(cfg)];
  });
  f.brain.thought.lifeOnly = false;
  const names = () => f.tools.current().map(tool => tool.name);
  try {
    const search = f.tools.current().find(tool => tool.name === 'search_web')!;
    assert.ok(names().includes('search_web') && names().includes('read_webpage') && names().includes('share_qzone_feed'));
    f.cfg.plugins['web-search'] = false;
    assert.ok(!names().includes('search_web') && names().includes('read_webpage'));
    await assert.rejects(search.execute('held', { query: 'hello' }), /Plugin web-search is disabled/);
    f.cfg.plugins['qzone-share'] = false;
    assert.ok(!names().includes('share_qzone_feed') && names().includes('send_group_msg'));
    f.cfg.web.enabled = false;
    assert.ok(!names().includes('read_webpage'));
    assert.ok(f.plugins.activities().every(item => !item.tools.some(tool => ['search_web', 'read_webpage', 'share_qzone_feed'].includes(tool))));
    assert.ok(!f.reviewTools.current().some(tool => ['search_web', 'read_webpage', 'share_qzone_feed'].includes(tool.name)));
    f.cfg.drawing.enabled = true; f.cfg.plugins.drawing = false;
    const plugins = createPlugins(f.cfg, f.store, { execute: async () => ({}) });
    const runtime = new ToolRuntime(f.cfg, f.store, { execute: async () => ({}) }, () => f.brain.thought);
    assert.ok(!plugins.bind(runtime)([]).some(tool => tool.name === 'imagen'));
    assert.deepEqual(pluginCredentials(f.cfg), { problems: [], warnings: [] });
  } finally { f.store.close(); }
});

test('new plugin tools bind to their own thought and share pause and generation checks', async () => {
  const f = fixture(undefined, undefined, undefined, () => [{
    id: 'test-notes', tools: runtime => [runtime.jsonTool('make_test_note', 'A test capability', Type.Object({}), () => ({ sources: [...runtime.context().sources], ...runtime.record('test_note', 'noted') }))],
  }]);
  try {
    const source = event(f.store, 'Remember this moment');
    f.faux.setResponses([answer(call('make_test_note', {})), answer('Kept it')]);
    await f.brain.run(f.store.claim(10)!);
    const result = f.brain.agent.state.messages.find(message => message.role === 'toolResult' && message.toolName === 'make_test_note');
    assert.ok(result && result.role === 'toolResult');
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text).sources, [source.id]);
    assert.ok(f.brain.thought.sources.size > f.reviewer.thought.sources.size);
    assert.ok(!f.reviewTools.current().some(tool => tool.name === 'make_test_note'));
    const tool = f.tools.current().find(tool => tool.name === 'make_test_note')!;
    f.store.setSetting('paused', true);
    await assert.rejects(tool.execute('paused', {}), /paused/);
    f.store.setSetting('paused', false); f.store.bumpGeneration();
    await assert.rejects(tool.execute('old-generation', {}), /management state changed/);
  } finally { f.store.close(); }
});

test('plugin action metadata can finish a thought without the brain knowing its tool name', async () => {
  let sent = 0;
  const f = fixture(undefined, undefined, undefined, () => [{
    id: 'test-chat',
    tools: runtime => [runtime.jsonTool('send_test_chat', 'Send in a test setting', Type.Object({}), () => { sent++; return { sent: true }; })],
    chatActions: ['send_test_chat'], staleActions: ['send_test_chat'],
    chatTarget: () => 'test:chat',
    endsThought: tool => tool === 'send_test_chat',
  }]);
  try {
    event(f.store, 'Hello');
    f.faux.setResponses([answer(call('send_test_chat', {})), answer('Must not be called')]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(sent, 1); assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.plugins.chatTarget('send_test_chat', {}), 'test:chat');
    assert.equal(f.plugins.chatTarget('send_test_chat', {}, true), 'test:chat');
  } finally { f.store.close(); }
});

test('plugin images, media references, and life activities work without capability names in the brain', async () => {
  const picture = Buffer.from('test-picture');
  const f = fixture(undefined, undefined, undefined, () => [{
    id: 'test-art',
    tools: runtime => [runtime.jsonTool('make_test_art', 'Make art', Type.Object({}), () => 'art:test')],
    activities: [{ activity: 'Make test art', tools: ['make_test_art'] }],
    experienceKinds: { make_test_art: 'test_art' },
    images: event => event.kind === 'test_art' ? [{ label: 'Your test art', unavailable: 'Test art is missing', deferred: 'Read the test art later', autoView: true, load: () => ({ data: picture, mimeType: 'image/png' }) }] : [],
    resolveMedia: value => value === 'art:test' ? `base64://${picture.toString('base64')}` : undefined,
  }]);
  try {
    const at = Date.now() - 1000;
    const art = f.store.receive({ key: 'test:art', kind: 'test_art', at, text: 'Art finished', payload: { origin: 'self' } })!;
    f.faux.setResponses([context => { assert.ok(JSON.stringify(context).includes(picture.toString('base64'))); return answer('Seen it'); }]);
    await f.brain.run(f.store.claim(10)!);
    const view = f.tools.current().find(tool => tool.name === 'view_event_image')!;
    assert.deepEqual((await view.execute('view', { id: art.id, index: 0 })).content[1], { type: 'image', data: picture.toString('base64'), mimeType: 'image/png' });
    const message = [{ type: 'image', data: { file: 'art:test' } }];
    await f.tools.current().find(tool => tool.name === 'send_group_msg')!.execute('send', { group_id: 100, message });
    assert.deepEqual(f.store.actions()[0]!.args.message, message);
    assert.deepEqual(f.sent[0]!.args.message, [{ type: 'image', data: { file: `base64://${picture.toString('base64')}` } }]);
    f.store.setSetting('lifeEnabled', true); f.store.schedule('Free time', 'life', Date.now()); f.store.enqueueDue();
    f.faux.setResponses([context => {
      const observation = context.messages.findLast(message => JSON.stringify(message).includes('New environment observations'));
      assert.match(JSON.stringify(observation), /Make test art/);
      assert.ok(JSON.stringify(observation).includes(new Date(at).toISOString()));
      return answer('Rest');
    }]);
    await f.brain.run(f.store.claim(10)!);
    assert.throws(() => f.store.writeMemory({ kind: 'habit', title: 'Art proves a habit', content: 'My own art is not external evidence', importance: 5, sources: [art.id] }, false, f.cfg.development), /cannot rest only on your own/);
  } finally { f.store.close(); }
});

test('plugin IDs and tool names cannot shadow other plugins or built-in tools, even while disabled', () => {
  const cfg = config(); const store = new Store(':memory:');
  const thought: ThoughtContext = { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: false };
  const runtime = new ToolRuntime(cfg, store, { execute: async () => ({}) }, () => thought);
  const plugin = (id: string, enabled = true): LifePlugin => ({ id, enabled: () => enabled, tools: runtime => [runtime.jsonTool('read_event', 'shadow', Type.Object({}), () => ({}))] });
  try {
    assert.throws(() => new PluginHost([plugin('a'), plugin('a')]), /Duplicate plugin ID/);
    assert.throws(() => new PluginHost([plugin('a'), plugin('b', false)]).bind(runtime)([]), /Duplicate tool name/);
    assert.throws(() => new PluginHost([plugin('a', false)]).bind(runtime)([runtime.jsonTool('read_event', 'original', Type.Object({}), () => ({}))]), /Duplicate tool name/);
  } finally { store.close(); }
});

test('a broken plugin picture leaves room for another, and excess pictures can be viewed later', async () => {
  const loaded: number[] = [];
  const f = fixture(undefined, undefined, undefined, () => [{
    id: 'test-pictures', tools: () => [], images: event => event.kind === 'pictures' ? [0, 1, 2].map(index => ({
      label: `Picture ${index}`, unavailable: `Picture ${index} is missing`, deferred: `View picture ${index} later`, autoView: true,
      load: () => { loaded.push(index); if (index === 0) throw new Error('file missing'); return { data: Buffer.from(`picture-${index}`), mimeType: 'image/png' }; },
    })) : [],
  }]);
  try {
    f.cfg.limits.maxImages = 1;
    const source = f.store.receive({ key: 'test:pictures', kind: 'pictures', at: Date.now(), text: 'Some pictures', payload: { origin: 'self' } })!;
    f.faux.setResponses([context => {
      const text = JSON.stringify(context);
      assert.ok(text.includes('Picture 0 is missing') && text.includes(Buffer.from('picture-1').toString('base64')) && text.includes('View picture 2 later'));
      return answer('Seen what fits');
    }]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(loaded, [0, 1]);
    const result = await f.tools.current().find(tool => tool.name === 'view_event_image')!.execute('later', { id: source.id, index: 2 });
    assert.deepEqual(result.content[1], { type: 'image', data: Buffer.from('picture-2').toString('base64'), mimeType: 'image/png' });
    assert.deepEqual(loaded, [0, 1, 2]);
  } finally { f.store.close(); }
});

test('plugin lifetimes are shared across both tool sets and shutdown settles every plugin', async () => {
  const calls: string[] = [];
  const f = fixture(undefined, undefined, undefined, () => [
    { id: 'a', tools: () => [], start: () => { calls.push('start-a'); }, stop: () => { calls.push('stop-a'); throw new Error('stop failed'); } },
    { id: 'b', tools: () => [], start: () => { calls.push('start-b'); }, stop: () => { calls.push('stop-b'); } },
  ]);
  try {
    assert.equal(f.tools.plugins, f.reviewTools.plugins);
    await f.plugins.start();
    await assert.rejects(f.plugins.start(), /already started/);
    await assert.rejects(f.plugins.stop(), AggregateError);
    await assert.rejects(f.plugins.stop(), AggregateError);
    assert.deepEqual(calls, ['start-a', 'start-b', 'stop-a', 'stop-b']);
  } finally { f.store.close(); }
});

test('a startup failure still permits shutdown of plugins whose startup was incomplete', async () => {
  const calls: string[] = [];
  const host = new PluginHost([
    { id: 'first', tools: () => [], start: () => { calls.push('start-first'); }, stop: () => { calls.push('stop-first'); } },
    { id: 'broken', tools: () => [], start: () => { throw new Error('startup failed'); }, stop: () => { calls.push('stop-broken'); } },
    { id: 'later', tools: () => [], start: () => { calls.push('start-later'); }, stop: () => { calls.push('stop-later'); } },
  ]);
  await assert.rejects(host.start(), /startup failed/);
  await host.stop();
  assert.deepEqual(calls, ['start-first', 'stop-first', 'stop-broken', 'stop-later']);
});
