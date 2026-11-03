import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { config } from './helpers.js';
import { loadConfig, type AdapterConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createPlugins } from '../src/plugins/index.js';
import { PluginHost } from '../src/plugins.js';
import { ToolRuntime, type ThoughtContext } from '../src/tool-runtime.js';
import { nativeAdapterPlugin, compactSchema } from '../src/adapters/native.js';
import { NativeApiError, nativeToolName } from '../src/platform.js';
import { ChatRecord } from '../src/record.js';
import { conversationRef } from '../src/identity.js';
import { getSnowLumaCatalog } from '../src/adapters/snowluma/catalog.js';
import { loadUserPlugin } from '../src/plugin-loader.js';
import { spawnSync } from 'node:child_process';

function bind(store: Store, host: PluginHost) {
  const cfg = config(); cfg.adapters = [];
  const thought: ThoughtContext = { generation: store.settings().generation, sources: new Set(), triggers: new Set(), lifeOnly: false };
  const runtime = new ToolRuntime(cfg, store, { execute: async () => { throw new Error('Wrong legacy dispatch'); } }, () => thought, host);
  const tools = host.bind(runtime)([]);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.name === name); assert.ok(tool, name);
    return JSON.parse((await tool.execute('test', args)).content[0]!.text!);
  };
  return { run, tools, thought, runtime };
}

test('native schema compaction preserves parameter names and literal values', () => {
  const input = Type.Object({ title: Type.String({ description: 'title prose' }), description: Type.String(), choice: { const: { title: 'literal', description: 'data' } } as any });
  const compact = compactSchema(input);
  assert.ok(compact.properties.title); assert.ok(compact.properties.description);
  assert.equal(compact.properties.title.description, undefined);
  assert.deepEqual(compact.properties.choice.const, { title: 'literal', description: 'data' });
});

test('one host exposes every SnowLuma operation and preserves account-scoped native receipts', async () => {
  const server = createServer(); const ws = new WebSocketServer({ server });
  const sent: any[] = [];
  ws.on('connection', socket => socket.on('message', bytes => {
    const request = JSON.parse(bytes.toString()); sent.push(request);
    if (request.action === 'set_diy_online_status') {
      socket.send(JSON.stringify({ status: 'failed', retcode: 100, wording: 'set status fail', data: null, echo: request.echo })); return;
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, echo: request.echo, data: request.action === 'get_login_info' ? { user_id: 900 } : { message_id: -24, extra: { preserved: true } } }));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const cfg = config(); cfg.adapters = [{ id: 'qq_main', driver: 'snowluma', accountId: '900', tokenEnv: 'SNOWLUMA_TOKEN', groups: [], maxStreamBytes: 1_000_000, tools: { allow: '*', deny: [] }, url: `ws://127.0.0.1:${(server.address() as any).port}` }];
  const store = new Store(':memory:'); const host = createPlugins(cfg, store, { execute: async () => { throw new Error('legacy'); } }, undefined, () => '900:dummy_test_token');
  try {
    const h = bind(store, host); await host.start();
    for (const action of getSnowLumaCatalog().actions) assert.ok(h.tools.some(tool => tool.name === `qq_main__${action.name}`), action.name);
    const qqArgs = { group_id: 100, message: [{ type: 'text', data: { text: 'qq' } }], auto_escape: false };
    assert.equal((await h.run('qq_main__send_group_msg', qqArgs)).message_id, -24);
    assert.deepEqual(sent.find(item => item.action === 'send_group_msg').params, qqArgs);
    assert.ok(store.actions().some(action => action.kind === 'qq_main__send_group_msg' && action.conversation === 'qq:900:group:100'));
    await assert.rejects(h.run('qq_main__set_diy_online_status', { face_id: 21, wording: 'Listening to music' }), error => {
      const receipt = JSON.parse((error as Error).message);
      assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.error.retcode, 100); return true;
    });
    assert.equal(store.actions().find(action => action.kind === 'qq_main__set_diy_online_status')?.status, 'failed');
    assert.notEqual(nativeToolName('first', 'deleteMessage'), nativeToolName('second', 'deleteMessage'));
  } finally { await host.stop(); store.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => server.close(() => resolve()))); }
});

test('QQ identity migration preserves event, memory, source and action IDs and separates another account', () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  const event = store.receive({ key: 'old', kind: 'message', at: 123, groupId: 100, actorId: 7, text: 'legacy', payload: { message_id: 1, message: [{ type: 'text', data: { text: 'legacy' } }] } })!;
  const memory = store.writeMemory({ kind: 'impression', scope: 'person:7', title: 'Friend', content: 'Likes music', importance: 5, sources: [event.id] }, false);
  const action = store.beginAction('old-action', 'send_group_msg', { group_id: 100, message: 'hello' }, [event.id], [], null).action;
  store.finishAction(action.id, 'success', { message_id: 2 }); store.setSetting('reviewMarks', { 'group:100': 100 });
  try {
    store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: '900' });
    assert.deepEqual(store.event(event.id)!.payload, event.payload);
    assert.equal(store.event(event.id)!.source!.conversation, 'qq:900:group:100');
    const migrated = store.development(['person:qq:user:7'])[0]!; assert.equal(migrated.id, memory.id); assert.deepEqual(migrated.sources, [event.id]);
    assert.equal(store.actionById(action.id)!.conversation, 'qq:900:group:100');
    assert.equal(store.setting<any>('reviewMarks')['qq:900:group:100'], 100);
    store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: '900' });
    assert.throws(() => store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: '901' }), /another platform account/);
    store.bindPlatformAccount('other', { platform: 'qq', accountId: '901' });
    assert.equal(store.conversationRecord('qq:901:group:100', 0, 10).events.length, 0);
    assert.equal(store.conversationRecord('qq:900:group:100', 0, 10).events[0]!.id, event.id);
  } finally { store.close(); }
});

test('third-party plugins register native catalogs through the public SDK and obey permissions and revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-native-plugin-')); const store = new Store(':memory:'); const cfg = config();
  cfg.extensions.directory = dir; cfg.extensions.dataDirectory = join(dir, 'data');
  const { mkdirSync } = await import('node:fs'); mkdirSync(join(dir, 'example'));
  writeFileSync(join(dir, 'example', 'index.mjs'), `export default { id: 'example', apiVersion: 1, setup(ctx) {
    ctx.adapter({ instance: 'discord_main', platform: 'discord', accountId: '18446744073709551615', version: 'fixture-1',
      actions: [{ name: 'sendMessage', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, readOnly: false }, { name: 'deleteMessage', inputSchema: { type: 'object' }, readOnly: false }], permissions: { allow: '*', deny: ['deleteMessage'] },
      execute: async (operation, args) => ({ operation, args }),
      stop: () => { globalThis.__testAdapterStopped = (globalThis.__testAdapterStopped ?? 0) + 1; },
      start: context => context.publish({ key: 'hello', kind: 'message', text: 'Hello', payload: { original: true }, conversation: { type: 'channel', id: '12345678901234567890' }, actor: '98765432109876543210' })
    });
    ctx.tool({ name: 'cross_platform', parameters: { type: 'object' }, description: 'Send through a registered adapter', execute: (_args, call) => call.adapters.action('discord_main', 'sendMessage', { text: 'hello' }) });
  } };`);
  const loaded = await loadUserPlugin('example', cfg, store, () => undefined, AbortSignal.timeout(5000));
  const host = new PluginHost([loaded.plugin]);
  try {
    const h = bind(store, host); await host.start(); assert.ok(!h.tools.some(tool => tool.name === 'discord_main__deleteMessage'));
    assert.equal((await h.run('cross_platform')).outcome.status, 'success');
    assert.ok(store.claim(10)!.events.some(event => event.source?.actor === 'discord:user:98765432109876543210'));
    await host.stop(); assert.equal((globalThis as any).__testAdapterStopped, 1); delete (globalThis as any).__testAdapterStopped; await assert.rejects(h.run('discord_main__sendMessage', { text: 'late' }), /stopping|stopped|unavailable/);
  } finally { await host.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('messages on another platform recall the same memories and review finds canonical impressions', async () => {
  const { SemanticRecall } = await import('../src/recall.js');
  const store = new Store(':memory:'); const cfg = config(); cfg.adapters = [];
  const original = store.receive({ key: 'original', kind: 'message', at: Date.now(), groupId: 100, actorId: 7, text: 'music', payload: {} })!;
  const memory = store.writeMemory({ kind: 'experience', title: 'Music', content: 'We talked about a song yesterday.', importance: 5, sources: [original.id] }, false);
  const recall = new SemanticRecall(cfg, store, { model: 'fixture', embed: async texts => texts.map(() => new Float32Array([1, 0])) });
  try {
    recall.start(); await recall.idle();
    const message = store.receive({ key: 'telegram', kind: 'message', at: Date.now(), text: 'The same song again', payload: {}, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } })!;
    await recall.idle(); assert.equal(recall.recall([message])[0]!.memory.id, memory.id);
    store.writeMemory({ kind: 'impression', title: 'Friend', content: 'Enjoys the same song', importance: 5, scope: 'person:telegram:user:7', sources: [message.id] }, false);
    assert.deepEqual(store.impressionsIn([{ conversation: message.source!.conversation!, since: 0 }], 0, 10), ['telegram:user:7']);
    const own = store.receive({ ...message, key: 'own', source: { ...message.source!, own: true, actor: 'telegram:user:900' } })!; await recall.idle(); assert.equal(recall.queries([own]).length, 0);
  } finally { await recall.stop(); store.close(); }
});
