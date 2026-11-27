import { qqEvent } from './helpers.js';
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
import { telegramAdapter, telegramCatalog, TelegramClient } from '../src/adapters/telegram/index.js';
import { NativeApiError, nativeToolName } from '../src/platform.js';
import { ChatRecord } from '../src/record.js';
import { conversationRef } from '../src/identity.js';
import { getSnowLumaCatalog } from '../src/adapters/snowluma/catalog.js';
import { loadUserPlugin } from '../src/plugin-loader.js';
import { spawnSync } from 'node:child_process';

const tg = (overrides: Partial<AdapterConfig> = {}): AdapterConfig => ({ id: 'tg_main', driver: 'telegram', accountId: '900', tokenEnv: 'TG_TOKEN', receive: 'manual', tools: { allow: '*', deny: [] }, groups: [], maxStreamBytes: 1_000_000, maxFileBytes: 1_000_000, ...overrides });
const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
function bind(store: Store, host: PluginHost) {
  const cfg = config(); cfg.adapters = [];
  const thought: ThoughtContext = { generation: store.settings().generation, sources: new Set(), triggers: new Set(), lifeOnly: false };
  const runtime = new ToolRuntime(cfg, store, () => thought, host);
  const tools = host.bind(runtime)([]);
  const run = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find(tool => tool.name === name); assert.ok(tool, name);
    return JSON.parse(((await tool.execute('test', args)).content[0] as { text: string }).text);
  };
  return { run, tools, thought, runtime };
}

test('Telegram catalog covers every declared API member, with native nested parameters', () => {
  const declarations = readFileSync(new URL('../node_modules/@grammyjs/types/methods.d.ts', import.meta.url), 'utf8');
  const names = [...declarations.matchAll(/^    ([a-zA-Z0-9_]+)(?:\(|: ApiMethods<F>)/gm)].map(match => match[1]);
  assert.equal(names.length, 187);
  assert.deepEqual(telegramCatalog.actions.map(action => action.name).sort(), names.sort());
  const schema = telegramCatalog.actions.find(action => action.name === 'sendMediaGroup')!.inputSchema;
  assert.equal(Check(schema as any, { chat_id: '-100123', media: [{ type: 'photo', media: { file: '/tmp/photo.png' }, caption: 'nested' }] }), true);
  assert.equal(Check(schema as any, { chat_id: '-100123', media: [{ type: 'made_up_type', media: 'id' }] }), false);
  const input = Type.Object({ title: Type.String({ description: 'title prose' }), description: Type.String(), choice: { const: { title: 'literal', description: 'data' } } as any });
  const compact = compactSchema(input);
  assert.ok(compact.properties.title); assert.ok(compact.properties.description);
  assert.equal(compact.properties.title.description, undefined);
  assert.deepEqual(compact.properties.choice.const, { title: 'literal', description: 'data' });
});

test('one host exposes every SnowLuma and Telegram operation and routes each account without parameter loss', async t => {
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
  const calls: { operation: string; args: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const operation = url.split('/').at(-1)!; const args = JSON.parse(String(init.body)); calls.push({ operation, args });
    return response(operation === 'getMe' ? { id: 900, username: 'example_bot' } : operation === 'getWebhookInfo' ? { url: '' } : { message_id: 56, chat: { id: -100123, type: 'channel' }, extra: { preserved: true } });
  });
  const cfg = config(); cfg.adapters = [tg({ id: 'qq_main', driver: 'snowluma', url: `ws://127.0.0.1:${(server.address() as any).port}` }), tg()];
  const store = new Store(':memory:'); const host = createPlugins(cfg, store, undefined, () => '900:dummy_test_token');
  try {
    const h = bind(store, host); await host.start();
    for (const action of getSnowLumaCatalog().actions) assert.ok(h.tools.some(tool => tool.name === `qq_main__${action.name}`), action.name);
    for (const action of telegramCatalog.actions) assert.ok(h.tools.some(tool => tool.name === `tg_main__${action.name}`), action.name);
    const qqArgs = { group_id: 100, message: [{ type: 'text', data: { text: 'qq' } }], auto_escape: false };
    assert.equal((await h.run('qq_main__send_group_msg', qqArgs)).message_id, -24);
    assert.deepEqual(sent.find(item => item.action === 'send_group_msg').params, qqArgs);
    const args = { chat_id: '@example_channel', text: 'telegram', reply_parameters: { message_id: 12, quote: 'nested' }, disable_notification: true };
    const result = await h.run('tg_main__sendMessage', args);
    assert.equal(result.outcome.status, 'success'); assert.deepEqual(result.outcome.result.extra, { preserved: true });
    assert.deepEqual(calls.find(call => call.operation === 'sendMessage')!.args, args);
    assert.equal(store.actionById(result.outcome.id)!.conversation, 'telegram:900:channel:-100123');
    assert.ok(store.actions().some(action => action.kind === 'qq_main__send_group_msg' && action.conversation === 'qq:900:group:100'));
    await assert.rejects(h.run('qq_main__set_diy_online_status', { face_id: 21, wording: 'Listening to music' }), error => {
      const receipt = JSON.parse((error as Error).message);
      assert.equal(receipt.outcome, 'failed'); assert.equal(receipt.error.retcode, 100); return true;
    });
    assert.equal(store.actions().find(action => action.kind === 'qq_main__set_diy_online_status')?.status, 'failed');
    assert.notEqual(nativeToolName('first', 'deleteMessage'), nativeToolName('second', 'deleteMessage'));
  } finally { await host.stop(); store.close(); for (const socket of ws.clients) socket.terminate(); await new Promise<void>(resolve => ws.close(() => server.close(() => resolve()))); }
});

test('Telegram multipart preserves nested media and file IDs; transport errors redact credentials and remain unknown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-telegram-upload-')); const path = join(dir, 'photo.png'); writeFileSync(path, 'image bytes');
  let request: RequestInit | undefined;
  const client = new TelegramClient('https://api.telegram.org', '900:secret', (async (_url, init) => { request = init; return response({ message_id: 1 }); }) as typeof fetch);
  try {
    await client.call('sendMediaGroup', { chat_id: '-100123', media: [{ type: 'photo', media: { file: path, filename: 'photo.png' }, caption: 'caption' }, { type: 'photo', media: 'existing_file_id' }], disable_notification: true });
    assert.ok(request!.body instanceof FormData);
    const form = request!.body as FormData;
    assert.deepEqual(JSON.parse(String(form.get('media'))), [{ type: 'photo', media: 'attach://upload_0', caption: 'caption' }, { type: 'photo', media: 'existing_file_id' }]);
    assert.equal(await (form.get('upload_0') as File).text(), 'image bytes');
    assert.equal(form.get('disable_notification'), 'true');
    const broken = new TelegramClient('https://api.telegram.org', '900:secret', (async () => { throw new Error('http://secret/900:secret'); }) as typeof fetch);
    await assert.rejects(broken.call('sendMessage', { text: 'x' }), error => error instanceof NativeApiError && !error.definitelyFailed() && !JSON.stringify(error.response).includes('secret') && !error.message.includes('secret'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram updates preserve raw payloads and string identities, persist offsets, and feed conversation review', async () => {
  const store = new Store(':memory:');
  const update = { update_id: 44, message: { date: Math.floor(Date.now() / 1000), message_id: 9, chat: { id: -100123, type: 'supergroup' }, message_thread_id: 17, from: { id: 4_503_599_627_370_111, first_name: 'Friend' }, text: '@example_bot hello', entities: [{ type: 'mention', offset: 0, length: 12 }] }, future_field: { untouched: true } };
  const requests: any[] = [];
  const adapter = telegramAdapter(tg(), () => '900:test', (async (url, init) => {
    const operation = String(url).split('/').at(-1); requests.push({ operation, args: JSON.parse(String(init?.body)) });
    return response(operation === 'getMe' ? { id: 900, username: 'example_bot' } : operation === 'getWebhookInfo' ? { url: '' } : [update]);
  }) as typeof fetch);
  const host = new PluginHost([nativeAdapterPlugin(adapter, store)]);
  try {
    const h = bind(store, host); await host.start();
    const result = await h.run('tg_main__getUpdates', { timeout: 0, offset: 44 }); assert.equal(result.outcome.status, 'success');
    const event = store.claim(20)!.events.find(event => event.kind === 'message')!;
    assert.deepEqual(event.payload, update); assert.equal(event.source!.actor, 'telegram:user:4503599627370111'); assert.equal(event.source!.addressed, true);
    assert.equal(event.source!.conversation, 'telegram:900:thread:-100123%2F17');
    assert.equal(store.setting('adapter:telegram:900:offset'), 45);
    assert.equal(store.reviewBacklog().find(chat => chat.conversation === event.source!.conversation)?.messages, 1);
    assert.match(new ChatRecord(store, event.source!.conversation!).page(0, 20).text, /Friend.*hello/);
    await h.run('tg_main__getUpdates', { timeout: 0, offset: 44 });
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='message'").get()!.n, 1, 'update replay deduplicates');
  } finally { await host.stop(); store.close(); }
});

test('binding a canonical QQ account preserves records and separates another account', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  const event = store.receive(qqEvent({ key: 'old', kind: 'message', at: 123, groupId: 100, actorId: 7, text: 'legacy', payload: { message_id: 1, message: [{ type: 'text', data: { text: 'legacy' } }] } }, store))!;
  const memory = store.writeMemory({ kind: 'impression', scope: "person:qq:user:7", title: 'Friend', content: 'Likes music', importance: 5, sources: [event.id] }, false);
  const action = store.beginAction('old-action', "qq_main__send_group_msg", { group_id: 100, message: 'hello' }, [event.id], [], null, "qq:900:group:100").action;
  store.finishAction(action.id, 'success', { message_id: 2 }); store.setSetting('reviewMarks', { "qq:900:group:100": 100 });
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
  writeFileSync(join(dir, 'example', 'index.mjs'), `export default { id: 'example', apiVersion: 2, setup(ctx) {
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

test('an adapter that names its frequent operations has the others loaded on demand; one that names none defers nothing', () => {
  const store = new Store(':memory:');
  const adapter = (frequent?: string[]) => new PluginHost([nativeAdapterPlugin({
    instance: 'discord_main', platform: 'discord', accountId: '1', version: 'fixture-1', ...(frequent ? { frequent } : {}),
    actions: [{ name: 'sendMessage', inputSchema: { type: 'object' }, readOnly: false }, { name: 'getGuild', inputSchema: { type: 'object' }, readOnly: true }],
    execute: async () => ({}),
  }, store)]);
  const deferred = (host: PluginHost) => bind(store, host).tools.filter(tool => (tool as { defer?: boolean }).defer).map(tool => tool.name);
  try {
    assert.deepEqual(deferred(adapter()), []);
    assert.deepEqual(deferred(adapter(['sendMessage'])), ['discord_main__getGuild']);
    assert.throws(() => adapter(['sendMesage']), /frequent must list operations/);
  } finally { store.close(); }
});

test('Telegram-only config and core inspection do not require SnowLuma credentials or a catalog', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-telegram-config-'));
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  raw.personaFile = 'persona.md'; raw.adapters = [tg()];
  writeFileSync(join(dir, 'persona.md'), 'A continuing identity.'); writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
  try {
    const cfg = loadConfig(join(dir, 'config.json')); assert.ok(!('snowluma' in cfg)); assert.equal(cfg.adapters![0]!.accountId, '900');
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { loadConfig } from './src/config.ts'; import { inspectConfig } from './src/webui/inspect.ts'; console.log(inspectConfig(loadConfig(${JSON.stringify(join(dir, 'config.json'))}), () => undefined).tools.includes('tg_main__sendMessage'));`], { cwd: new URL('..', import.meta.url), env: { ...process.env, QIUYUE_SNOWLUMA_CATALOG: '/does-not-exist/catalog.json' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout.trim(), 'true');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('polling yields to native update and webhook calls and shutdown drains the consumer', async () => {
  const store = new Store(':memory:'); let inFlight = 0, maxInFlight = 0, pollCount = 0;
  let started!: () => void; const firstPoll = new Promise<void>(resolve => { started = resolve; });
  const fetcher = (async (url, init) => {
    const operation = String(url).split('/').at(-1)!; const args = JSON.parse(String(init?.body));
    if (operation === 'getMe') return response({ id: 900, username: 'example_bot' });
    if (operation === 'getWebhookInfo') return response({ url: '' });
    if (operation === 'getUpdates') {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      if (args.timeout === 30) {
        pollCount++; assert.ok(args.allowed_updates.includes('message_reaction')); started();
        try { return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('poll cancelled')), { once: true })); }
        finally { inFlight--; }
      }
      inFlight--; return response([]);
    }
    return response(true);
  }) as typeof fetch;
  const host = new PluginHost([nativeAdapterPlugin(telegramAdapter(tg({ receive: 'polling' }), () => '900:test', fetcher), store)]);
  try {
    const h = bind(store, host); await host.start(); await firstPoll;
    assert.equal((await h.run('tg_main__getUpdates', { timeout: 0 })).outcome.status, 'success');
    assert.equal(maxInFlight, 1, 'no two update consumers overlap');
    assert.equal((await h.run('tg_main__setWebhook', { url: 'https://example.com/hook' })).outcome.status, 'success');
    await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(pollCount, 1, 'a webhook suspends polling');
    const restarted = new Promise<void>(resolve => { started = resolve; });
    assert.equal((await h.run('tg_main__deleteWebhook')).outcome.status, 'success');
    await Promise.race([restarted, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('poll did not resume')), 2500).unref())]);
    assert.equal(pollCount, 2);
  } finally { await host.stop(); assert.equal(inFlight, 0); store.close(); }
});

test('native failures retain explicit rejection versus unknown outcomes and permissions remain enforced', async () => {
  const store = new Store(':memory:'); let requests = 0; let mode = 'rejected';
  const settings = tg({ tools: { allow: ['sendMessage'], deny: [] } });
  const host = new PluginHost([nativeAdapterPlugin(telegramAdapter(settings, () => '900:test', (async url => {
    const operation = String(url).split('/').at(-1)!;
    if (operation === 'getMe') return response({ id: 900 }); if (operation === 'getWebhookInfo') return response({ url: '' });
    requests++; if (mode === 'rejected') return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad request' }), { status: 400 });
    throw new Error('Transport disappeared');
  }) as typeof fetch), store)]);
  try {
    const h = bind(store, host); await host.start();
    assert.equal((await h.run('tg_main__sendMessage', { chat_id: 7, text: 'one' })).outcome.status, 'failed');
    mode = 'unknown'; const lost = await h.run('tg_main__sendMessage', { chat_id: 7, text: 'two' }); assert.equal(lost.outcome.status, 'unknown');
    const again = await h.run('tg_main__sendMessage', { chat_id: 7, text: 'two' }); assert.equal(again.reused, true); assert.equal(requests, 2);
    settings.tools.deny.push('sendMessage'); await assert.rejects(h.run('tg_main__sendMessage', { chat_id: 7, text: 'three' }), /not enabled/); assert.equal(requests, 2);
  } finally { await host.stop(); store.close(); }
});

test('native media reaches image perception without exposing token URLs', async () => {
  const store = new Store(':memory:'); const payload = { update_id: 51, message: { message_id: 4, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: Math.floor(Date.now() / 1000), photo: [{ file_id: 'photo_file', width: 40, height: 40 }] } };
  const host = new PluginHost([nativeAdapterPlugin(telegramAdapter(tg(), () => '900:test', (async url => {
    const value = String(url); if (value.includes('/file/bot')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    const method = value.split('/').at(-1);
    return response(method === 'getMe' ? { id: 900 } : method === 'getWebhookInfo' ? { url: '' } : method === 'getFile' ? { file_id: 'photo_file', file_path: 'photos/file_1.png' } : [payload]);
  }) as typeof fetch), store)]);
  try {
    const h = bind(store, host); await host.start(); await h.run('tg_main__getUpdates');
    const event = store.claim(10)!.events.find(event => event.kind === 'message')!; const image = host.images(event)[0]!;
    assert.ok(!image.label.includes('900:test')); assert.equal((await image.load())!.mimeType, 'image/png');
  } finally { await host.stop(); store.close(); }
});

test('messages on another platform recall the same memories and review finds canonical impressions', async () => {
  const { SemanticRecall } = await import('../src/recall.js');
  const store = new Store(':memory:'); const cfg = config(); cfg.adapters = [];
  const original = store.receive(qqEvent({ key: 'original', kind: 'message', at: Date.now(), groupId: 100, actorId: 7, text: 'music', payload: {} }, store))!;
  const memory = store.writeMemory({ kind: 'experience', title: 'Music', content: 'We talked about a song yesterday.', importance: 5, sources: [original.id] }, false);
  const recall = new SemanticRecall(cfg, store, { model: 'fixture', embed: async texts => texts.map(() => new Float32Array([1, 0])) });
  try {
    recall.start(); await recall.idle();
    const message = store.receive(qqEvent({ key: 'telegram', kind: 'message', at: Date.now(), text: 'The same song again', payload: {}, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } }, store))!;
    await recall.idle(); assert.equal(recall.recall([message])[0]!.memory.id, memory.id);
    store.writeMemory({ kind: 'impression', title: 'Friend', content: 'Enjoys the same song', importance: 5, scope: 'person:telegram:user:7', sources: [message.id] }, false);
    assert.deepEqual(store.impressionsIn([{ conversation: message.source!.conversation!, since: 0 }], 10), ['telegram:user:7']);
    const own = store.receive(qqEvent({ ...message, key: 'own', source: { ...message.source!, own: true, actor: 'telegram:user:900' } }, store))!; await recall.idle(); assert.equal(recall.queries([own]).length, 0);
  } finally { await recall.stop(); store.close(); }
});

test('a configured account that cannot connect stops startup, while an optional plugin that fails is only left out', async () => {
  const store = new Store(':memory:');
  try {
    const cfg = config();
    const unreachable = { execute: async () => ({}), connect: async () => { throw new Error('SnowLuma WebSocket closed'); }, close: async () => {} };
    const left: string[] = [];
    await assert.rejects(createPlugins(cfg, store, undefined, undefined, () => unreachable).start(plugin => { left.push(plugin.id); }), /SnowLuma WebSocket closed/);
    assert.equal(left.length, 0);
    const optional = new PluginHost([{ id: 'optional', tools: () => [], start: async () => { throw new Error('broken startup'); } }]);
    await optional.start(plugin => { left.push(plugin.id); });
    assert.deepEqual(left, ['optional']); assert.deepEqual(optional.installed().map(plugin => plugin.id), []);
  } finally { store.close(); }
});

test('Telegram social actions end a thought only on success, skip stale sends, and validate operation lists', async () => {
  const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai');
  const { PiBrain } = await import('../src/brain.js');
  const { createTools: createAllTools } = await import('../src/tools.js');
  const store = new Store(':memory:');
  try {
    assert.throws(() => nativeAdapterPlugin({
      instance: 'bad_adapter', platform: 'example', accountId: '1', version: 'v1',
      actions: [{ name: 'sendMessage', inputSchema: { type: 'object' }, readOnly: false }],
      staleActions: ['unknownOp'],
      execute: async () => ({}),
    }, store), /staleActions must list operations/);
    assert.throws(() => nativeAdapterPlugin({
      instance: 'bad_adapter', platform: 'example', accountId: '1', version: 'v1',
      actions: [{ name: 'sendMessage', inputSchema: { type: 'object' }, readOnly: false }],
      endsThoughtActions: ['unknownOp'],
      execute: async () => ({}),
    }, store), /endsThoughtActions must list operations/);

    let failNext: 'failed' | 'unknown' | false = false;
    let firstSendStarted!: () => void;
    const started = new Promise<void>(resolve => { firstSendStarted = resolve; });
    let releaseFirstSend!: () => void;
    const hold = new Promise<void>(resolve => { releaseFirstSend = resolve; });
    let sendCalls = 0;

    const tgScoped = tg({ tools: { allow: ['sendMessage', 'setMessageReaction'], deny: [] } });
    const adapter = telegramAdapter(tgScoped, () => '900:test', (async (url, init) => {
      const op = String(url).split('/').at(-1);
      if (op === 'getMe') return response({ id: 900, username: 'qiuyue_bot' });
      if (op === 'getWebhookInfo') return response({ url: '' });
      if (op === 'sendMessage') {
        sendCalls++;
        const body = JSON.parse(String(init?.body));
        if (body.text === 'hold') { firstSendStarted(); await hold; }
        if (failNext === 'failed') {
          failNext = false;
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        if (failNext === 'unknown') {
          failNext = false;
          throw new Error('socket hang up');
        }
        return response({ message_id: 100 + sendCalls, chat: { id: 7, type: 'private' } });
      }
      return response({});
    }) as typeof fetch);

    const cfg = config(); cfg.adapters = [tgScoped];
    const host = new PluginHost([nativeAdapterPlugin(adapter, store)]);
    await host.start();
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    let brain!: InstanceType<typeof PiBrain>;
    const tools = createAllTools(cfg, store, () => brain.thought, undefined, host);
    brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: (m, c, o) => models.streamSimple(m, c, { ...o, cacheRetention: 'none' }) });

    // 1. A successful Telegram sendMessage ends the thought in one model call (no extra follow-up turn).
    store.receive({ key: 'tg:1', kind: 'message', at: Date.now(), text: 'Hi', payload: { update_id: 1 }, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('tg_main__sendMessage', { chat_id: 7, text: 'Hello!' })]),
      fauxAssistantMessage('Should not be called'),
    ]);
    await brain.run(store.claim(10)!);
    assert.equal(faux.state.callCount, 1);

    // 2. A failed or unknown Telegram sendMessage does NOT end the thought, so the model sees the outcome and decides again (ADR-0008).
    for (const mode of ['failed', 'unknown'] as const) {
      const beforeCalls: number = faux.state.callCount;
      failNext = mode;
      store.receive({ key: `tg:${mode}`, kind: 'message', at: Date.now() + 1, text: `Try ${mode}`, payload: { update_id: mode === 'failed' ? 2 : 3 }, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('tg_main__sendMessage', { chat_id: 7, text: `Will ${mode}` })]),
        fauxAssistantMessage(`Observed ${mode} outcome`),
      ]);
      await brain.run(store.claim(10)!);
      assert.equal(faux.state.callCount, beforeCalls + 2);
    }

    // 3. While the first send runs, a newer addressed Telegram message marks the second send stale and skips it.
    store.receive({ key: 'tg:4', kind: 'message', at: Date.now() + 2, text: 'Wait', payload: { update_id: 4 }, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('tg_main__sendMessage', { chat_id: 7, text: 'hold' }),
        fauxToolCall('tg_main__sendMessage', { chat_id: 7, text: 'stale-second' }),
      ]),
      fauxAssistantMessage('Decided again after newer message'),
    ]);
    const running = brain.run(store.claim(10)!);
    await started;
    const newer = store.receive({ key: 'tg:5', kind: 'message', at: Date.now() + 3, text: 'Actually never mind', payload: { update_id: 5 }, source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: 'telegram:900:private:7', conversationType: 'private', actor: 'telegram:user:7', own: false, addressed: true, attention: 'normal' } })!;
    assert.equal(await brain.steer({ batchId: 'b:steer', events: [newer] }), true);
    releaseFirstSend();
    await running;
    assert.equal(store.actions().some(action => action.args.text === 'stale-second'), false);
    await host.stop();
  } finally { store.close(); }
});

test('drawing:<uuid> resolves to a Telegram multipart upload and records gallery usage without counting text mentions', async () => {
  const { DrawingLibrary } = await import('../src/plugins/gallery-store.js');
  const { galleryPlugin } = await import('../src/plugins/gallery.js');
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-tg-drawing-'));
  const store = new Store(':memory:');
  const cfg = config(); cfg.adapters = [tg()]; cfg.drawing.dir = dir;
  const library = new DrawingLibrary(store.db, dir);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const drawingId = `drawing:${crypto.randomUUID()}`;
  let uploadForm: FormData | undefined;
  let textBody: Record<string, unknown> | undefined;
  const adapter = telegramAdapter(tg(), () => '900:test', (async (url, init) => {
    const op = String(url).split('/').at(-1);
    if (op === 'getMe') return response({ id: 900, username: 'qiuyue_bot' });
    if (op === 'getWebhookInfo') return response({ url: '' });
    if (op === 'sendPhoto') {
      uploadForm = init?.body as FormData;
      return response({ message_id: 77, chat: { id: -100123, type: 'supergroup' } });
    }
    if (op === 'sendMessage') {
      textBody = JSON.parse(String(init?.body));
      return response({ message_id: 78, chat: { id: -100123, type: 'supergroup' } });
    }
    return response({});
  }) as typeof fetch);
  const host = new PluginHost([galleryPlugin(cfg, store), nativeAdapterPlugin(adapter, store)]);
  try {
    await library.save(drawingId, png, 'png', { prompt: 'starry sky', model: 'test', createdAt: Date.now(), sources: [] });
    const h = bind(store, host);
    await host.start();
    const sent = await h.run('tg_main__sendPhoto', { chat_id: -100123, photo: drawingId, caption: 'Look!' });
    assert.equal(sent.outcome.status, 'success');
    // Persisted action keeps the compact permanent ID; outbound request carries multipart upload bytes.
    assert.equal(store.actionById(sent.outcome.id)!.args.photo, drawingId);
    assert.ok(uploadForm instanceof FormData);
    assert.equal(uploadForm.get('photo'), 'attach://upload_0');
    const uploaded = uploadForm.get('upload_0') as File;
    assert.equal(uploaded.name, `${drawingId.slice('drawing:'.length)}.png`);
    assert.deepEqual(Buffer.from(await uploaded.arrayBuffer()), png);
    // Mentioning the ID inside text leaves the text intact and does not count as sharing the picture.
    await h.run('tg_main__sendMessage', { chat_id: -100123, text: `I drew ${drawingId}` });
    assert.equal(textBody?.text, `I drew ${drawingId}`);
    const uses = library.detail(drawingId)!.uses;
    assert.equal(uses.length, 1);
    assert.equal(uses[0]!.kind, 'tg_main__sendPhoto');
  } finally { await host.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram chat records format replies, media, reactions, echo dedup, and conversation names cleanly', async () => {
  const { observationText } = await import('../src/record.js');
  const store = new Store(':memory:');
  const conv = 'telegram:900:group:-100555';
  const t = Date.parse('2026-10-28T13:00:00Z');
  try {
    const first = store.receive({
      key: 'tg:rec:1', kind: 'message', at: t, text: 'Look at the sky',
      source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: conv, conversationType: 'group', conversationName: 'Stargazers', actor: 'telegram:user:7', actorName: 'Lin', messageId: '101', own: false, addressed: true, attention: 'normal' },
      payload: { update_id: 1, message: { message_id: 101, chat: { id: -100555, type: 'supergroup', title: 'Stargazers' }, from: { id: 7, first_name: 'Lin' }, photo: [{ file_id: 'f1' }], caption: 'Look at the sky' } },
    })!;
    const reply = store.beginAction('tg:reply', 'tg_main__sendMessage', { chat_id: -100555, text: 'So clear tonight!', reply_parameters: { message_id: 101 } }, [first.id], [], null, conv).action;
    store.finishAction(reply.id, 'success', { message_id: 102, chat: { id: -100555, type: 'supergroup' } });
    store.db.prepare('UPDATE actions SET created_at=? WHERE id=?').run(t + 1000, reply.id);
    // Echo of own send with same message_id must be deduplicated in the record.
    store.receive({
      key: 'tg:rec:2', kind: 'message', at: t + 1000, text: 'So clear tonight!',
      source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: conv, conversationType: 'group', conversationName: 'Stargazers', actor: 'telegram:user:900', actorName: 'Qiuyue', messageId: '102', own: true, addressed: false, attention: 'ambient' },
      payload: { update_id: 2, message: { message_id: 102, chat: { id: -100555, type: 'supergroup', title: 'Stargazers' }, from: { id: 900, first_name: 'Qiuyue' }, text: 'So clear tonight!' } },
    });
    // Reaction from another user folds onto message 102.
    store.receive({
      key: 'tg:rec:3', kind: 'notice:message_reaction', at: t + 2000, text: '[message_reaction]',
      source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: conv, conversationType: 'group', conversationName: 'Stargazers', actor: 'telegram:user:7', actorName: 'Lin', own: false, addressed: false, attention: 'ambient' },
      payload: { update_id: 3, message_reaction: { message_id: 102, user: { id: 7, first_name: 'Lin' }, new_reaction: [{ type: 'emoji', emoji: '✨' }] } },
    });
    // Own reaction action folds onto message 101.
    const react = store.beginAction('tg:react', 'tg_main__setMessageReaction', { chat_id: -100555, message_id: 101, reaction: [{ type: 'emoji', emoji: '👍' }] }, [first.id], [], null, conv).action;
    store.finishAction(react.id, 'success', true);
    store.db.prepare('UPDATE actions SET created_at=? WHERE id=?').run(t + 2500, react.id);

    const page = new ChatRecord(store, conv).page(t, 50).text;
    assert.match(page, /^Chat record of group -100555 \(Stargazers\), from 2026-10-28T21:00:00\.000\+08:00:/);
    assert.match(page, /People: Lin=telegram:user:7; "me" is you/);
    assert.match(page, /Lin: \[image\] Look at the sky\n  ↳ me reacted 👍/);
    assert.match(page, /me: \[reply to #\w{8} \(Lin\)\] So clear tonight!\n  ↳ Lin reacted ✨/);
    assert.equal(page.match(/So clear tonight!/g)?.length, 1, 'echoed send is not repeated');
    assert.ok(!page.includes('tg_main__sendMessage'), 'concise me: caption instead of raw action JSON');

    const observed = observationText(store, [first], {}, 300);
    assert.match(observed, /^Group -100555 \(Stargazers\): \[telegram:900:group:-100555\]/);
    assert.match(observed, /\[message_id 101\] Lin\(7\): \[image 0\] Look at the sky/);
  } finally { store.close(); }
});

test('Telegram group quietness, normalized conversation names in LifeReader, and ephemeral events work without QQ assumptions', async t => {
  const { LifeReader } = await import('../src/webui/reader.js');
  const { PiBrain } = await import('../src/brain.js');
  const { createTools } = await import('../src/tools.js');
  const { createModels, fauxProvider, fauxAssistantMessage } = await import('@earendil-works/pi-ai');
  const now = Date.parse('2026-11-26T10:40:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-tg-quiet-'));
  const dbPath = join(dir, 'life.sqlite');
  const store = new Store(dbPath);
  const cfg = config();
  cfg.adapters = [tg({ tools: { allow: ['sendMessage'], deny: [] } })];
  const adapter = telegramAdapter(cfg.adapters[0]!, () => '900:test', (async url => {
    const op = String(url).split('/').at(-1);
    if (op === 'getMe') return response({ id: 900, username: 'qiuyue_bot' });
    if (op === 'getWebhookInfo') return response({ url: '' });
    return response([]);
  }) as typeof fetch);
  const customEphemeral = nativeAdapterPlugin({
    instance: 'ext_main', platform: 'ext', accountId: '1', version: 'ext-1',
    actions: [{ name: 'send', readOnly: false, inputSchema: { type: 'object', properties: {} } }],
    execute: async () => ({ ok: true }),
    start: ctx => {
      ctx.publish({ key: 'typing:1', kind: 'notice:typing', at: now - 5_000, text: 'typing', payload: {}, conversation: { type: 'channel', id: 'room1' }, conversationName: 'Lounge', actor: 'u1', actorName: 'Kai', attention: 'ambient', ephemeral: true });
      ctx.publish({ key: 'msg:1', kind: 'message', at: now - 4_000, text: 'hello room', payload: {}, conversation: { type: 'channel', id: 'room1' }, conversationName: 'Lounge', actor: 'u1', actorName: 'Kai', messageId: 'm-1', attention: 'normal' });
    },
  }, store);
  const host = new PluginHost([nativeAdapterPlugin(adapter, store), customEphemeral]);
  try {
    await host.start();
    // Ephemeral presence event is excluded from ChatRecord without any platform-specific SQL kind check.
    const extRecord = new ChatRecord(store, 'ext:1:channel:room1').page(0, 20).text;
    assert.ok(extRecord.includes('hello room'));
    assert.ok(!extRecord.includes('notice:typing'));
    assert.equal(store.conversationName('ext:1:channel:room1'), 'Lounge');

    // Drain startup/ext events so the upcoming life wake is claimed by itself.
    for (let batch = store.claim(10); batch; batch = store.claim(10)) store.acknowledge(batch.batchId);

    const tgConv = 'telegram:900:group:-100888';
    const msg = store.receive({
      key: 'tg:quiet:1', kind: 'message', at: now - 25 * 60_000, text: 'anyone up?',
      source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: tgConv, conversationType: 'group', conversationName: 'Night Owls', actor: 'telegram:user:7', actorName: 'Lin', messageId: '1', own: false, addressed: false, attention: 'normal' },
      payload: { update_id: 10 },
    }, true)!;
    store.writeMemory({ kind: 'habit', title: 'Stay concise', content: 'Keep late-night notes brief.', importance: 3, sources: [msg.id], scope: `conversation:${tgConv}` }, false);
    const reader = new LifeReader(dbPath);
    assert.equal(reader.development()[0]?.scopeName, 'Night Owls');

    store.setSetting('lifeEnabled', true);
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    let brain!: InstanceType<typeof PiBrain>;
    const tools = createTools(cfg, store, () => brain.thought, undefined, host);
    brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) });
    store.schedule('Free time', 'life', now); store.enqueueDue();
    let prompt = '';
    faux.setResponses([context => { prompt = JSON.stringify(context.messages.findLast(m => JSON.stringify(m).includes('New environment observations'))); return fauxAssistantMessage('Quiet'); }]);
    await brain.run(store.claim(10)!);
    assert.ok(prompt.includes('Group chats right now: -100888 (Night Owls): quiet 25m.'));
  } finally { await host.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});
