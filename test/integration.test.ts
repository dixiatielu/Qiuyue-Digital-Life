import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { Store } from '../src/store.js';
import { normalizeEvent, SnowLumaAdapter } from '../src/snowluma.js';
import { callControl, handleControl, serveControl } from '../src/control.js';
import { publicAddress, publicFetch } from '../src/web.js';
import { compactionSplit, estimatedContextTokens, messageTokens } from '../src/context.js';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { config, deferred, event, fixture } from './helpers.js';
import { snowlumaCatalog } from '../src/snowluma-catalog.js';
import { SNOWLUMA_ACTIONS, SnowLumaApiError } from '@snowluma/sdk';
import { LifeRuntime } from '../src/runtime.js';

test('SnowLuma adapter uses real SDK transport, stores notices and history, and passes native actions', async () => {
  const cfg = config(); const store = new Store(':memory:');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const addr = server.address(); assert.ok(typeof addr === 'object' && addr);
  cfg.snowluma.url = `ws://127.0.0.1:${addr.port}`;
  const requests: { action: string; params: Record<string, unknown> }[] = [];
  const received = deferred();
  server.on('connection', socket => {
    socket.on('message', data => {
      const request = JSON.parse(data.toString()); requests.push(request);
      let result: unknown = {};
      if (request.action === 'get_login_info') {
        result = { user_id: 900, nickname: 'Qiuyue' };
        // A live event before history must not advance the saved recovery cursor.
        socket.send(JSON.stringify({ post_type: 'message', self_id: 900, group_id: 100, user_id: 7, time: 100, message_id: 12, message: 'Live message' }));
      }
      if (request.action === 'get_group_msg_history') result = { messages: [{ user_id: 7, time: 90, message_id: 11, message: [{ type: 'text', data: { text: 'Message received while offline' } }] }] };
      if (request.action === 'send_group_msg') result = { message_id: -55 };
      if (request.action === 'get_msg') result = { message_id: -55, group_id: 100, message_type: 'group' };
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: result, echo: request.echo }));
    });
  });
  store.receive(normalizeEvent({ post_type: 'message', self_id: 900, group_id: 100, user_id: 7, time: 80, message_id: 10, message: 'Previously online' }, cfg.snowluma)!);
  const adapter = new SnowLumaAdapter(cfg.snowluma, store, () => { if (store.pending() >= 8) received.resolve(); });
  try {
    await adapter.connect();
    assert.equal(requests.find(r => r.action === 'get_group_msg_history' && r.params.group_id === 100)?.params.message_id, 10);
    store.setSetting('paused', true);
    const client = [...server.clients][0]!;
    client.send(JSON.stringify({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 900, group_id: 100, user_id: 7, target_id: 900, time: 101 }));
    client.send(JSON.stringify({ post_type: 'notice', notice_type: 'group_msg_emoji_like', self_id: 900, group_id: 100, user_id: 7, message_id: 12, likes: [{ emoji_id: '76', count: 1 }], time: 102 }));
    await received.promise;
    const observation = store.claim(20)!;
    assert.equal(observation.events.filter(e => e.kind === 'perception_gap').length, 3);
    assert.ok(observation.events.filter(e => e.kind === 'perception_gap').every(e => !/[\p{Script=Han}]/u.test(e.text)));
    assert.ok(observation.events.some(e => e.kind.includes('poke') && e.payload.target_id === 900));
    assert.ok(observation.events.some(e => e.kind.includes('emoji')));
    assert.deepEqual(await adapter.execute('send_group_msg', { group_id: 100, message: [{ type: 'text', data: { text: 'Here' } }] }), { message_id: -55 });
    await adapter.execute('set_group_reaction', { group_id: 100, message_id: -55, code: '76', is_set: true });
    await adapter.execute('group_poke', { group_id: 100, user_id: 7 });
    assert.equal((await adapter.execute('get_msg', { message_id: -55 }) as any).group_id, 100);
    assert.deepEqual(requests.slice(-4).map(r => r.action), ['send_group_msg', 'set_group_reaction', 'group_poke', 'get_msg']);
  } finally {
    await adapter.close(); for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});

test('every exposed action reaches the SDK unchanged, including multi-frame streams', async () => {
  const cfg = config(); const store = new Store(':memory:');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const addr = server.address(); assert.ok(typeof addr === 'object' && addr);
  cfg.snowluma.url = `ws://127.0.0.1:${addr.port}`;
  const requests: { action: string; params: Record<string, unknown> }[] = [];
  let streamFailure = false;
  server.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString()); requests.push(request);
    if (!request.params?.contract_probe && request.action === 'get_login_info') {
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 900 }, echo: request.echo })); return;
    }
    if (!request.params?.contract_probe && request.action === 'get_group_msg_history') {
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [] }, echo: request.echo })); return;
    }
    const action = snowlumaCatalog.find(action => action.name === request.action)!;
    if (action.stream) {
      if (streamFailure) {
        socket.send(JSON.stringify({ status: 'failed', retcode: 1403, data: null, wording: 'Streaming call failed', echo: request.echo })); return;
      }
      const send = (value: unknown) => socket.send(JSON.stringify({ stream: 'stream-action', status: 'ok', retcode: 0, data: value, echo: request.echo }));
      // Uploads terminate after one ACK; downloads keep receiving until response.
      send({ type: 'stream', chunk_data: 'aGVsbG8=', chunk_index: 0 });
      if (action.name !== 'upload_file_stream') send({ type: 'response', native_action: action.name });
    } else socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { native_action: action.name }, echo: request.echo }));
  }));
  const adapter = new SnowLumaAdapter(cfg.snowluma, store, () => {});
  try {
    await adapter.connect();
    for (const action of snowlumaCatalog) {
      const params = { contract_probe: action.name, nested: { untouched: [null, false, 'Original parameters'] } };
      const result = await adapter.execute(action.name, params);
      assert.deepEqual(requests.at(-1), { action: action.name, params, echo: (requests.at(-1) as any).echo });
      if (action.stream) {
        assert.ok(Array.isArray(result)); assert.deepEqual(result[0], { type: 'stream', chunk_data: 'aGVsbG8=', chunk_index: 0 });
        assert.equal(result.length, action.name === 'upload_file_stream' ? 1 : 2);
      } else assert.deepEqual(result, { native_action: action.name });
    }
    const beforeUnknown = requests.length;
    const names = new Set(snowlumaCatalog.map(action => action.name));
    for (const name of SNOWLUMA_ACTIONS.filter(name => !names.has(name))) await assert.rejects(adapter.execute(name, {}), /Unknown/);
    assert.equal(requests.length, beforeUnknown);
    cfg.snowluma.tools.deny = ['fetch_ptt_text'];
    const beforeDenied = requests.length;
    await assert.rejects(adapter.execute('fetch_ptt_text', { message_id: -42 }), /not enabled/);
    assert.equal(requests.length, beforeDenied);
    streamFailure = true;
    await assert.rejects(adapter.execute('test_download_stream', {}), error => error instanceof SnowLumaApiError && error.retcode === 1403);
    streamFailure = false; cfg.snowluma.maxStreamBytes = 1;
    await assert.rejects(adapter.execute('test_download_stream', {}), /maxStreamBytes/);
    const beforeCancelled = requests.length;
    await assert.rejects(adapter.execute('send_group_msg', { group_id: 999, message: 'Not sent' }, AbortSignal.abort()), /abort/i);
    assert.equal(requests.length, beforeCancelled);
  } finally {
    await adapter.close(); for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
  }
});

test('normalization preserves rich messages from all groups while rejecting other accounts and non-events', () => {
  const cfg = config().snowluma;
  const raw = { post_type: 'message', self_id: 900, group_id: 100, user_id: 7, time: 1, message_id: -3, message: '[CQ:reply,id=-2][CQ:at,qq=900]Take a look[CQ:image,url=https://example.com/a.png][CQ:record,file=a.amr]' };
  const normalized = normalizeEvent(raw, cfg)!;
  assert.equal(normalized.key, 'qq:900:group:100:message:-3'); assert.ok(normalized.text.includes('[@900]'));
  assert.deepEqual((normalized.payload.message as any[]).map(s => s.type), ['reply', 'at', 'text', 'image', 'record']);
  assert.equal(normalizeEvent({ ...raw, group_id: 999 }, cfg)?.groupId, 999);
  assert.equal(normalizeEvent({ ...raw, self_id: 901 }, cfg), undefined);
  assert.equal(normalizeEvent({ self_id: 900, status: 'ok', retcode: 0, data: {} }, cfg), undefined);
  assert.equal(normalizeEvent({ ...raw, post_type: '' }, cfg), undefined);
});

test('the digital life\'s own pokes come back as ambient notices attributed to it', () => {
  const cfg = config().snowluma; const store = new Store(':memory:'); store.bindAccount(900);
  const poke = (fields: Record<string, unknown>) => normalizeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: 900, time: 100, ...fields }, cfg)!;
  try {
    // In a private chat QQ names the other person as user_id and target_id; sender_id is who poked.
    const privateEcho = poke({ user_id: 7, target_id: 7, sender_id: 900 }); const groupEcho = poke({ group_id: 100, user_id: 900, target_id: 7 });
    const incoming = poke({ user_id: 7, target_id: 900, sender_id: 7 });
    assert.deepEqual([privateEcho.actorId, groupEcho.actorId, incoming.actorId], [900, 900, 7]);
    store.receive(privateEcho); store.receive(groupEcho);
    assert.equal(store.pendingTiming().first, undefined); assert.notEqual(store.pendingTiming().ambient, undefined);
    store.receive(incoming); assert.notEqual(store.pendingTiming().first, undefined);
  } finally { store.close(); }
});

test('private message keys separate peers and groups, preserve direction, and deduplicate redelivery', () => {
  const cfg = config().snowluma; const store = new Store(':memory:');
  const raw = { post_type: 'message', message_type: 'private', self_id: 900, user_id: 7, time: 1, message_id: -3, message: 'Private chat' };
  try {
    const first = normalizeEvent(raw, cfg)!;
    assert.equal(first.groupId, undefined); assert.equal(first.actorId, 7);
    assert.equal(first.key, 'qq:900:private:7:message:-3');
    assert.ok(store.receive(first)); assert.equal(store.receive(normalizeEvent(raw, cfg)!), undefined);
    assert.ok(store.receive(normalizeEvent({ ...raw, user_id: 8 }, cfg)!));
    assert.ok(store.receive(normalizeEvent({ ...raw, message_type: 'group', group_id: 7 }, cfg)!));
    const sent = normalizeEvent({ ...raw, post_type: 'message_sent', message_id: -4 }, cfg)!;
    assert.equal(sent.payload.post_type, 'message_sent'); assert.equal(sent.payload.message_type, 'private');
    assert.ok(store.receive(sent));
    assert.equal(store.pending(), 4);
  } finally { store.close(); }
});

test('SDK pushes reach observation after pause while heartbeats remain stored outside model context', { timeout: 10000 }, async () => {
  const f = fixture(); f.cfg.snowluma.groups = [];
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const addr = server.address(); assert.ok(typeof addr === 'object' && addr);
  f.cfg.snowluma.url = `ws://127.0.0.1:${addr.port}`;
  const actions: string[] = [];
  server.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString()); actions.push(request.action);
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 900 }, echo: request.echo }));
  }));
  const pushes = [
    { post_type: 'message', message_type: 'private', user_id: 7, message_id: 21, message: 'Private chat observation' },
    { post_type: 'message_sent', message_type: 'private', user_id: 7, message_id: 22, message: 'Own output' },
    { post_type: 'message', message_type: 'group', group_id: 999, user_id: 8, message_id: 23, message: 'Observation from an unconfigured group' },
    { post_type: 'notice', notice_type: 'friend_recall', user_id: 7, message_id: 21 },
    { post_type: 'request', request_type: 'friend', user_id: 8, flag: 'friend-flag', comment: 'Add me as a friend' },
    { post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true }, interval: 30000 },
    { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' },
    { post_type: 'future_push', custom: { content: 'Extended event' } },
  ].map((push, index) => ({ ...push, self_id: 900, time: 100 + index }));
  const received = deferred();
  const adapter = new SnowLumaAdapter(f.cfg.snowluma, f.store, () => {
    void runtime.tick();
    if (f.store.pending() === pushes.length) received.resolve();
  });
  try {
    f.store.setSetting('paused', true);
    await adapter.connect(); runtime.start();
    const client = [...server.clients][0]!;
    client.send(JSON.stringify({ ...pushes[0], self_id: 901 }));
    client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { unsolicited: true } }));
    for (const push of pushes) client.send(JSON.stringify(push));
    // Re-delivery of a request must not create another observation.
    client.send(JSON.stringify(pushes[4]));
    await received.promise;
    assert.equal(f.faux.state.callCount, 0); assert.equal(f.store.pending(), pushes.length);
    const heartbeat = f.store.db.prepare("SELECT status,payload FROM events WHERE kind='meta_event:heartbeat:'").get()!;
    assert.equal(heartbeat.status, 'processed'); assert.equal(JSON.parse(String(heartbeat.payload)).status.online, true);
    assert.deepEqual(actions, ['get_login_info']);
    f.faux.setResponses([context => {
      const user = context.messages.find(message => message.role === 'user')!;
      assert.equal(typeof user.content, 'object');
      const content = user.content as { type: string; text: string }[];
      const observations = JSON.parse(content[0]!.text.split('\n').slice(1).join('\n'));
      assert.equal(observations.length, pushes.length);
      assert.ok(observations.some((e: any) => e.messageType === 'private' && e.text === 'Private chat observation' && e.groupId === undefined));
      assert.ok(observations.some((e: any) => e.postType === 'message_sent'));
      assert.ok(observations.some((e: any) => e.groupId === 999));
      assert.ok(observations.some((e: any) => e.notice?.notice_type === 'friend_recall'));
      assert.ok(observations.some((e: any) => e.details?.flag === 'friend-flag' && e.details.comment === 'Add me as a friend'));
      assert.ok(!observations.some((e: any) => e.details?.meta_event_type === 'heartbeat'));
      assert.ok(observations.some((e: any) => e.details?.meta_event_type === 'lifecycle'));
      assert.ok(observations.some((e: any) => e.details?.custom?.content === 'Extended event'));
      return fauxAssistantMessage('Perceived; staying quiet for now');
    }]);
    runtime.control('resume'); await runtime.tick(); await runtime.idle();
    assert.equal(f.store.processedCount(), pushes.length); assert.equal(f.sent.length, 0);
    assert.equal(f.store.pending(), 0);
    assert.ok(f.store.recent(20).some(e => e.kind === 'perception_gap' && !e.groupId));
    assert.ok(!f.store.logs().some(log => log.kind === 'thought_error'));
  } finally {
    await adapter.close(); await runtime.stop(); for (const client of server.clients) client.terminate();
    await new Promise<void>(resolve => server.close(() => resolve())); f.store.close();
  }
});

test('management socket changes persistent controls and previews deletion before explicit execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-control-')); const store = new Store(':memory:');
  const path = join(dir, 'control.sock');
  const server = await serveControl(path, request => handleControl(store, request));
  try {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    await callControl(path, { args: ['pause'] }); assert.equal(store.settings().paused, true);
    const source = event(store, 'A past experience');
    const preview = await callControl(path, { args: ['memory', 'forget', source.id] }) as { affectedIds: string[] };
    assert.ok(preview.affectedIds.includes(source.id)); assert.ok(store.event(source.id));
    await callControl(path, { args: ['memory', 'forget', source.id], yes: true }); assert.equal(store.event(source.id), undefined);
    await callControl(path, { args: ['life', 'on'] }); assert.equal(store.settings().lifeEnabled, true);
    await callControl(path, { args: ['resume'] }); assert.equal(store.settings().paused, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('compaction splitting retains complete tool exchanges and identifies the old prefix', () => {
  const old: AgentMessage = { role: 'user', content: 'old'.repeat(2000), timestamp: 1 };
  const assistant = fauxAssistantMessage(fauxToolCall('read_event', { id: 'e:1' }, { id: 't:1' }));
  const result: AgentMessage = { role: 'toolResult', toolCallId: 't:1', toolName: 'read_event', content: [{ type: 'text', text: 'Result' }], isError: false, timestamp: 2 };
  const recent: AgentMessage = { role: 'user', content: 'New observation ', timestamp: 3 };
  const system: AgentMessage = { role: 'system', content: 'Fixed instructions', timestamp: 0 };
  const { removed, kept: trimmed } = compactionSplit([system, old, assistant, result, recent], messageTokens(assistant) + messageTokens(result), 1000, 100);
  assert.ok(removed.includes(old));
  assert.ok(!trimmed.includes(old)); assert.ok(trimmed.includes(assistant)); assert.ok(trimmed.includes(result)); assert.ok(trimmed.includes(recent));
  assert.throws(() => compactionSplit([system, old], 10, 10, 1), /exceed the context budget/);
});

test('large observations can be consumed without losing their source IDs or overflowing the default budget', async () => {
  const f = fixture();
  try {
    const sources = Array.from({ length: 20 }, (_, index) => event(f.store, `Event ${index}: ` + 'long message'.repeat(4000)));
    f.faux.setResponses([context => {
      const serialized = JSON.stringify(context);
      for (const source of sources) assert.ok(serialized.includes(source.id));
      assert.ok(estimatedContextTokens(context.messages) < f.cfg.limits.contextTokens - f.cfg.limits.outputReserveTokens - f.cfg.limits.contextSafetyTokens);
      return fauxAssistantMessage('Observe first; read the original source later if needed');
    }]);
    await f.brain.run(f.store.claim(20)!); assert.equal(f.store.processedCount(), 20);
  } finally { f.store.close(); }
});

test('public readers refuse local/private/reserved addresses and non-HTTP protocols', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', '2002:7f00:1::']) assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'https://user:secret@example.com/']) await assert.rejects(publicFetch(url, { maxBytes: 100, timeoutMs: 1000 }));
});
