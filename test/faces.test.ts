import { qqEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { FaceCatalog, qqFacesPlugin, unzip, type Face } from '../src/plugins/faces.js';
import { normalizeEvent } from '../src/adapters/snowluma/index.js';
import { Store } from '../src/store.js';
import { PluginHost } from '../src/plugins.js';
import { createPlugins } from './helpers.js';
import { SemanticRecall } from '../src/recall.js';
import { config, deferred, event, fixture } from './helpers.js';
import { embeddingConfig, topics } from './embedding-helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** A zip archive laid out as QQ's face resources are, with each file stored or deflated. */
function zip(files: Record<string, { data: Buffer; deflate?: boolean }>) {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, file] of Object.entries(files)) {
    const body = file.deflate ? deflateRawSync(file.data) : file.data; const path = Buffer.from(name); const method = file.deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(path.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(method, 10); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(file.data.length, 24); central.writeUInt16LE(path.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, path, body); centrals.push(central, path); offset += 30 + path.length + body.length;
  }
  const directory = Buffer.concat(centrals); const count = Object.keys(files).length;
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('a face picture is read from its archive whether stored or deflated', () => {
  const large = Buffer.concat([PNG, Buffer.alloc(4000, 7)]);
  const archive = zip({ '424/png/424_0.png': { data: large }, '424/png/424.png': { data: PNG, deflate: true } });
  assert.deepEqual(unzip(archive, '424/png/424.png'), PNG);
  assert.deepEqual(unzip(archive, '424/png/424_0.png'), large);
  assert.equal(unzip(archive, '277/png/277.png'), undefined);
  assert.equal(unzip(Buffer.from('not an archive'), '424/png/424.png'), undefined);
});

test('observations name faces and reactions and show each face once a thought, and view_face shows it again', async () => {
  const urls = { 424: 'https://wa.qq.com/sysemoji/424.zip', 277: 'https://wa.qq.com/sysemoji/277.zip' };
  const catalogs: unknown[] = [];
  const pictured: string[] = [];
  const social = { execute: async (kind: string) => {
    if (kind !== 'fetch_sys_faces') return { message_id: -9 };
    catalogs.push(kind);
    return { packs: [{ pack_name: 'Default', emojis: [{ q_sid: '424', q_des: '/续标识', url: urls[424] }, { q_sid: '277', q_des: '/汪汪', url: urls[277] }] }] };
  } };
  const f = fixture(social, undefined, undefined, (store, cfg) => [qqFacesPlugin(cfg, new FaceCatalog(store, social, async url => {
    const id = /\/(\d+)\.zip$/.exec(url)![1]!; pictured.push(id);
    return { data: zip({ [`${id}/png/${id}.png`]: { data: PNG, deflate: true } }), type: 'application/zip', url };
  }))]);
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const receive = (raw: Record<string, unknown>) => f.store.receive(qqEvent(normalizeEvent({ self_id: 900, group_id: 100, user_id: 7, time: Math.floor(Date.now() / 1000), ...raw }, f.cfg.adapters[0]!)!, f.store))!;
    const said = receive({ post_type: 'message', message_type: 'group', message_id: 31, message: [{ type: 'face', data: { id: '424' } }, { type: 'text', data: { text: 'this one?' } }] });
    receive({ post_type: 'notice', notice_type: 'group_msg_emoji_like', message_id: 31, likes: [{ emoji_id: '424', count: 1 }, { emoji_id: '277', count: 1 }, { emoji_id: '128077', count: 1 }] });
    assert.equal(said.text, '[face 424]this one?');
    let observed = '';
    f.faux.setResponses([
      context => { observed = JSON.stringify(context.messages.findLast(message => message.role === 'user' && JSON.stringify(message).includes('New environment observations'))); return answer(call("qq_main__view_face", { id: '277' })); },
      answer('Seen'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    // The reaction joins the line of the message it reacts to.
    assert.match(observed, /\[message_id 31\] 7: \[face 424 续标识\]this one\?\\n  ↳ 7 reacted \[emoji 424 续标识\]\[emoji 277 汪汪\]\[emoji 128077 👍\]/);
    // Seen once each, though 424 is both sent and reacted with.
    assert.equal(observed.split('QQ system face 424 续标识, as it looks:').length, 2);
    assert.equal(observed.split('QQ system face 277 汪汪, as it looks:').length, 2);
    assert.deepEqual(pictured, ['424', '277']);
    assert.equal(catalogs.length, 1);
    assert.deepEqual(f.store.setting<Record<string, Face>>('faces')[424], { name: '续标识', url: urls[424] });
    // Folded when the thought ends, each picture points back to view_face.
    const context = JSON.stringify(f.brain.agent.state.messages);
    assert.doesNotMatch(context, /"type":"image"/);
    assert.match(context, /QQ system face 424 续标识, as it looks:"\},\{"type":"text","text":"\[Folded when the thought ended; view it again with qq_main__view_face\]/);
    assert.match(context, /"toolName":"qq_main__view_face".*QQ system face 277 汪汪, as it looks:"\},\{"type":"text","text":"\[Folded when the thought ended; view it again with qq_main__view_face\]/);
    // A new thought sees the face again.
    receive({ post_type: 'message', message_type: 'group', message_id: 32, message: [{ type: 'face', data: { id: '424' } }] });
    f.faux.setResponses([context => {
      const observation = JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')));
      assert.ok(observation.includes('QQ system face 424 续标识, as it looks:') && observation.includes(PNG.toString('base64')));
      return answer('Again');
    }]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(pictured, ['424', '277'], 'later thoughts and explicit viewing reuse the picture cache');
  } finally { f.store.close(); }
});

test('disabling qq-faces hides its tool and names while native QQ reactions remain available', async () => {
  let catalogs = 0;
  const f = fixture({ execute: async () => { catalogs++; return { message_id: -1 }; } });
  f.brain.thought.lifeOnly = false;
  try {
    f.store.setSetting('faces', { 424: { name: '续标识', url: 'https://example.com/424.zip' } });
    const held = f.tools.current().find(tool => tool.name === "qq_main__view_face")!;
    assert.ok(f.reviewTools.current().some(tool => tool.name === "qq_main__view_face"));
    f.cfg.plugins['qq-main-qq-faces'] = false;
    assert.ok(!f.tools.current().some(tool => tool.name === "qq_main__view_face"));
    assert.ok(!f.reviewTools.current().some(tool => tool.name === "qq_main__view_face"));
    await assert.rejects(held.execute('held', { id: '424' }), /disabled/);
    assert.deepEqual(await f.plugins.emojiNames(), {});
    assert.deepEqual(f.plugins.knownEmojiNames(), {});
    f.store.receive(qqEvent({ key: 'face:off', kind: 'message', at: Date.now(), text: '[face 424]', groupId: 100, actorId: 7, payload: { message: [{ type: 'face', data: { id: '424' } }] } }, f.store));
    f.faux.setResponses([context => {
      const observed = JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')));
      assert.match(observed, /\[face 424\]/); assert.doesNotMatch(observed, /续标识|QQ system face|"type":"image"/);
      return answer('Seen the ID');
    }]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(catalogs, 0);
    await f.tools.current().find(tool => tool.name === "qq_main__set_group_reaction")!.execute('react', { group_id: 100, message_id: 1, code: '424', is_set: true });
    assert.equal(catalogs, 1);
    assert.deepEqual(f.store.setting('faces'), { 424: { name: '续标识', url: 'https://example.com/424.zip' } });
  } finally { f.store.close(); }
});

test('chat images keep priority, and a face skipped for budget can be seen later in the same thought', async () => {
  const entered = deferred(); const release = deferred(); const pictures: string[] = [];
  const social = { execute: async () => { entered.resolve(); await release.promise; return { message_id: -1 }; } };
  const f = fixture(social, undefined, undefined, (store, cfg) => {
    store.setSetting('faces', { 424: { name: '续标识', url: 'https://example.com/424.zip' } });
    return [
      qqFacesPlugin(cfg, new FaceCatalog(store, social, async url => { pictures.push(url); return { data: zip({ '424/png/424.png': { data: PNG } }), type: 'application/zip', url }; })),
      { id: 'test-picture', tools: () => [], images: event => event.kind === 'picture' ? [{ label: 'A priority picture', unavailable: '', deferred: '', autoView: true, load: () => ({ data: PNG, mimeType: 'image/png' }) }] : [] },
    ];
  });
  const receive = () => f.store.receive(qqEvent({ key: crypto.randomUUID(), kind: 'message', at: Date.now(), text: '[face 424]', groupId: 100, actorId: 7, payload: { message: [{ type: 'face', data: { id: '424' } }] } }, f.store));
  try {
    f.cfg.limits.maxImages = 1;
    f.store.receive(qqEvent({ key: 'picture', kind: 'picture', at: Date.now(), text: 'A picture', payload: {} }, f.store)); receive();
    f.faux.setResponses([
      context => { const text = JSON.stringify(context); assert.match(text, /A priority picture/); assert.doesNotMatch(text, /QQ system face 424/); return answer(call("qq_main__get_msg", { message_id: 1 })); },
      context => { assert.match(JSON.stringify(context), /QQ system face 424 续标识, as it looks:/); return answer('Now seen'); },
    ]);
    const running = f.brain.run(f.store.claim(10)!);
    await entered.promise; assert.equal(pictures.length, 0);
    receive(); await f.brain.steer(f.store.claim(10)!); release.resolve(); await running;
    assert.equal(pictures.length, 1);
  } finally { release.resolve(); f.store.close(); }
});

test('warm names survive catalog reconstruction and a bad picture is retried after its backoff', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T12:00:00Z') });
  const store = new Store(':memory:'); const cfg = config();
  store.setSetting('faces', { 424: { name: '续标识', url: 'https://example.com/424.zip' } });
  let requests = 0;
  const faces = new FaceCatalog(store, { execute: async () => { throw new Error('A warm catalog must not be fetched'); } }, async url => ({ data: ++requests === 1 ? Buffer.from('bad archive') : zip({ '424/png/424.png': { data: PNG } }), type: 'application/zip', url }));
  const plugin = qqFacesPlugin(cfg, faces);
  try {
    assert.deepEqual(await plugin.emojiNames!(), { 424: '续标识' });
    await assert.rejects(faces.image('424'), /no readable picture/);
    await assert.rejects(faces.image('424'), /could not be read just now/);
    assert.equal(requests, 1);
    t.mock.timers.tick(600_001);
    assert.deepEqual(await faces.image('424'), PNG); assert.equal(requests, 2);
    assert.deepEqual(await faces.image('424'), PNG); assert.equal(requests, 2);
  } finally { store.close(); }
});

test('a cancelled picture download does not poison the cache', async () => {
  const store = new Store(':memory:'); store.setSetting('faces', { 424: { name: '续标识', url: 'https://example.com/424.zip' } });
  const entered = deferred(); const controller = new AbortController(); let requests = 0;
  const faces = new FaceCatalog(store, { execute: async () => ({}) }, async (url, options) => {
    if (++requests === 1) { entered.resolve(); await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })); }
    return { data: zip({ '424/png/424.png': { data: PNG } }), type: 'application/zip', url };
  });
  try {
    const downloading = faces.image('424', controller.signal); await entered.promise; controller.abort();
    await assert.rejects(downloading, /abort/i);
    assert.deepEqual(await faces.image('424'), PNG); assert.equal(requests, 2);
  } finally { store.close(); }
});

test('concurrent name lookups share the catalog request and cancellation permits an immediate retry', async () => {
  const store = new Store(':memory:'); const entered = deferred(); let calls = 0;
  const controller = new AbortController();
  const faces = new FaceCatalog(store, { execute: async (_action, _args, signal) => {
    if (++calls === 1) { entered.resolve(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); }
    return { packs: [{ emojis: [{ q_sid: '424', q_des: '/续标识' }] }] };
  } });
  try {
    const first = faces.names(controller.signal); const also = faces.names(); await entered.promise;
    assert.equal(calls, 1); controller.abort();
    assert.deepEqual(await first, {}); assert.deepEqual(await also, {});
    assert.deepEqual(await faces.names(), { 424: '续标识' }); assert.equal(calls, 2);
    assert.deepEqual(await faces.names(), { 424: '续标识' }); assert.equal(calls, 2);
  } finally { store.close(); }
});

test('recall receives cached emoji names from the host and drops that enhancement when disabled', async () => {
  const cfg = embeddingConfig(); const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  store.setSetting('faces', { 424: { name: '小笼包' } });
  const source = event(store, '午饭');
  const memory = store.writeMemory({ kind: 'note', title: '午饭', content: '昨天一起吃小笼包，非常开心', importance: 4, sources: [source.id] }, false);
  const embedder = topics(); let plugins!: PluginHost;
  const recall = new SemanticRecall(cfg, store, embedder, () => plugins.knownEmojiNames());
  plugins = createPlugins(cfg, store, { execute: async () => ({}) }, recall);
  try {
    recall.start(); await recall.idle();
    const face = event(store, '[face 424]'); await recall.idle();
    assert.deepEqual(recall.recall([face]).map(item => item.memory.id), [memory.id]);
    cfg.plugins['qq-main-qq-faces'] = false;
    const disabled = event(store, '[face 424]'); await recall.idle();
    assert.deepEqual(recall.recall([disabled]), []);
    assert.equal(embedder.calls.flat().filter(text => text === '小笼包').length, 1);
  } finally { await recall.stop(); store.close(); }
});
