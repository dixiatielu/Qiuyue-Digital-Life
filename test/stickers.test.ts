import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { SnowLumaActionError as SnowLumaApiError } from '../src/adapters/snowluma/index.js';
import { Store, eventRef } from '../src/store.js';
import { SemanticRecall } from '../src/recall.js';
import { StickerStore } from '../src/plugins/stickers-store.js';
import { StickerRecall, stickerLines } from '../src/plugins/stickers-recall.js';
import { stickersPlugin } from '../src/plugins/stickers.js';
import { findSnowLumaAction } from '../src/snowluma-catalog.js';
import { deferred, event, fixture } from './helpers.js';
import { topics, embeddingConfig } from './embedding-helpers.js';

const stickerAction = (store: Store, kind: string, args: Record<string, unknown>, result: unknown = null) => { const { action } = store.beginAction(crypto.randomUUID(), kind, args, []); store.finishAction(action.id, 'success', result); };
/** A sticker saved through her own actions, described if desc is given. */
const saveSticker = (store: Store, emojiId: string, desc?: string) => {
  stickerAction(store, 'add_custom_face', { file: `https://example.com/${emojiId}.gif` }, { emoji_id: emojiId });
  if (desc) stickerAction(store, 'modify_custom_face', { emoji_id: emojiId, desc });
};
const stickerRows = (store: Store) => store.db.prepare('SELECT emoji_id, model, desc FROM sticker_vectors ORDER BY emoji_id, chunk').all().map(row => [String(row.emoji_id), String(row.model), String(row.desc)]);

test('a received image already saved as a sticker is seen as one, and saving it again says so', async () => {
  const md5 = 'FB1708EDC2A2803B6CA831085EBEAC29'; const market = 'ff862d42053a56c468834db523978ecb';
  const saved = `900_0_0_0_${md5}_0_0`; const marketSaved = '900_0_0_0_A02AC0D33A8A95F1C6E9D322F5EC0F6F_0_0';
  const f = fixture({ execute: async (kind: string, args: Record<string, unknown>) => kind === 'add_custom_face' ? { emoji_id: String(args.file).includes(market) ? marketSaved : saved } : null });
  f.brain.thought.lifeOnly = false;
  try {
    assert.equal(new StickerStore(f.store).savedSticker({ file: `${md5}.jpg` }), undefined);
    let adds: unknown[] = [];
    event(f.store);
    f.faux.setResponses([
      answer(call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=1' })),
      answer(call('modify_custom_face', { emoji_id: saved, desc: 'Two dolls bopping, for silly joy' })),
      // The same image under another URL, as QQ signs each delivery anew.
      answer(call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=b&rkey=2' })),
      answer(call('add_custom_face', { file: `https://gxh.vip.qq.com/club/item/parcel/item/ff/${market}/raw300.gif` })),
      context => { adds = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'add_custom_face'); return answer('Done'); },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(adds.length, 3);
    assert.doesNotMatch(JSON.stringify(adds[0]), /alreadySaved/);
    assert.match(JSON.stringify(adds[1]), /\\"alreadySaved\\":true,\\"desc\\":\\"Two dolls bopping, for silly joy\\"/);
    assert.doesNotMatch(JSON.stringify(adds[2]), /alreadySaved/);
    // A received image is matched by the MD5 it is named by, a market face by its emoji_id.
    const prompts: string[] = [];
    const image = f.store.receive({ key: 'image', kind: 'message', at: Date.now(), text: '[image]', groupId: 100, actorId: 7, payload: { message: [
      { type: 'image', data: { file: `${md5.toLowerCase()}.jpg`, summary: '[动画表情]' } },
      { type: 'image', data: { file: `ff-${market}.gif`, emoji_id: market, summary: '[嘿嘿]' } },
      { type: 'image', data: { file: 'CA3BD9F231FC29304CE90BB45EB88482.jpg' } },
    ] } })!;
    f.faux.setResponses([context => { prompts.push(JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')))); return answer('Nice'); }]);
    await f.brain.run(f.store.claim(10)!);
    const ref = eventRef(image.id);
    assert.ok(prompts[0]!.includes(`${ref} 7: [image 0 [动画表情]][image 1 [嘿嘿]][image 2]`));
    assert.ok(prompts[0]!.includes(`Image 0 in ${ref} (already your saved sticker ${saved}: Two dolls bopping, for silly joy) has no readable URL`));
    assert.ok(prompts[0]!.includes(`Image 1 in ${ref} (already your saved sticker ${marketSaved}) has no readable URL`));
    assert.ok(prompts[0]!.includes(`Image 2 in ${ref} has no readable URL`));
    const deleted = f.store.beginAction(crypto.randomUUID(), 'delete_custom_face', { emoji_id: saved }, []).action;
    f.store.finishAction(deleted.id, 'success', null);
    assert.equal(new StickerStore(f.store).savedSticker({ file: `${md5}.jpg` }), undefined);
    assert.equal(new StickerStore(f.store).savedSticker({ emoji_id: market })?.emojiId, marketSaved);
  } finally { f.store.close(); }
});

test('a sticker is described as it is saved, in the same call and batch as a send, and keeps a description it already had', async () => {
  const ids: Record<string, string> = { a: '900_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0', b: '900_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0' };
  const calls: { kind: string; args: Record<string, unknown> }[] = [];
  let refuse = false;
  const f = fixture({ execute: async (kind: string, args: Record<string, unknown>) => {
    calls.push({ kind, args });
    if (kind === 'add_custom_face') return { emoji_id: ids[String(args.file).includes('fileid=b') ? 'b' : 'a'] };
    if (kind === 'modify_custom_face' && refuse) throw new SnowLumaApiError({ status: 'failed', retcode: 1400, data: null, wording: 'bad desc' });
    return kind === 'modify_custom_face' ? null : { message_id: -42 };
  } });
  f.brain.thought.lifeOnly = false;
  const results = (context: { messages: any[] }) => context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'add_custom_face').map(message => message.details as Record<string, any>);
  try {
    assert.equal((f.tools.current().find(tool => tool.name === 'add_custom_face')!.parameters as any).properties.desc.type, 'string');
    let seen: Record<string, any>[] = [];
    event(f.store);
    f.faux.setResponses([
      answer([call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=1', desc: '  A cat leaping, for happy moments ' }), call('send_group_msg', { group_id: 100, message: 'Saved it!' })]),
      answer('Must not be called'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    // One model call saved, described, and replied, and the thought ended there, as after a batch of messages alone.
    assert.deepEqual(calls.map(call => call.kind), ['add_custom_face', 'modify_custom_face', 'send_group_msg']);
    assert.equal(f.faux.state.callCount, 1);
    seen = results({ messages: f.brain.agent.state.messages });
    assert.deepEqual(calls[0]!.args, { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=1' });
    assert.deepEqual(calls[1]!.args, { emoji_id: ids.a, desc: 'A cat leaping, for happy moments' });
    assert.equal(seen[0]!.described.outcome, 'success');
    const recorded = f.store.actions().map(action => [action.kind, action.status, action.args]);
    assert.deepEqual(recorded.filter(([kind]) => kind !== 'send_group_msg').reverse(), [['add_custom_face', 'success', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=1' }], ['modify_custom_face', 'success', { emoji_id: ids.a, desc: 'A cat leaping, for happy moments' }]]);
    assert.deepEqual(new StickerStore(f.store).savedStickers(), [{ emojiId: ids.a, desc: 'A cat leaping, for happy moments' }]);
    // Saving it again under another URL keeps the description it has; a new sticker whose description fails stays saved.
    calls.length = 0; refuse = true;
    event(f.store);
    f.faux.setResponses([
      answer([call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=a&rkey=2', desc: 'Something else' }), call('add_custom_face', { file: 'https://multimedia.nt.qq.com.cn/download?fileid=b&rkey=3', desc: 'A dog sighing, for tired days' })]),
      // The working context carries the first thought's save too.
      context => { seen = results(context).slice(-2); return answer('Done'); },
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(calls.map(call => call.kind), ['add_custom_face', 'add_custom_face', 'modify_custom_face']);
    assert.deepEqual([seen[0]!.alreadySaved, seen[0]!.desc, seen[0]!.described], [true, 'A cat leaping, for happy moments', undefined]);
    assert.equal(seen[1]!.outcome, 'success');
    assert.deepEqual([seen[1]!.described.outcome, seen[1]!.described.error.wording], ['failed', 'bad desc']);
    assert.match(seen[1]!.described.instruction, /saved, but its description was not set/);
    assert.deepEqual(new StickerStore(f.store).savedStickers(), [{ emojiId: ids.a, desc: 'A cat leaping, for happy moments' }, { emojiId: ids.b, desc: '' }]);
    // Without modify_custom_face, the save takes no description.
    f.cfg.snowluma.tools = { allow: '*', deny: ['modify_custom_face'] };
    const add = f.tools.current().find(tool => tool.name === 'add_custom_face')!;
    assert.deepEqual(add.parameters, findSnowLumaAction('add_custom_face').inputSchema);
    assert.match(add.description, /after a successful save, use its returned emoji_id with modify_custom_face/);
  } finally { f.store.close(); }
});

test('saved stickers are embedded by what they suit, come up for what is said, follow a new description, and go when deleted', async () => {
  assert.deepEqual(stickerLines('少女捧着包子流口水，适合表达想吃小笼包'), ['适合表达想吃小笼包', '少女捧着包子流口水，适合表达想吃小笼包']);
  assert.deepEqual(stickerLines('举着对勾牌子笑，表示赞同'), ['表示赞同', '举着对勾牌子笑，表示赞同']);
  assert.deepEqual(stickerLines(' A cat leaping '), ['A cat leaping']);
  const store = new Store(':memory:'); store.bindAccount(900);
  const food = '少女捧着包子流口水，适合表达想吃小笼包'; const rain = '少女在雨里打伞，适合表达天气不好';
  saveSticker(store, 'food', food); saveSticker(store, 'rain', rain); saveSticker(store, 'plain');
  const embedder = topics();
  const cfg = embeddingConfig(); const semantics = new SemanticRecall(cfg, store, embedder);
  const recall = new StickerRecall(cfg.embedding, new StickerStore(store), semantics);
  try {
    semantics.start(); recall.start(); await semantics.idle(); await recall.idle();
    // A sticker without a description says nothing to match.
    assert.deepEqual(stickerRows(store), [['food', 'topics', food], ['food', 'topics', food], ['rain', 'topics', rain], ['rain', 'topics', rain]]);
    assert.ok(embedder.calls.some(texts => texts[0] === '适合表达想吃小笼包'));
    const hungry = event(store, '好想吃小笼包'); const weather = event(store, '今天天气真差'); const chat = event(store, '随便聊聊');
    await semantics.idle(); await recall.idle();
    assert.deepEqual(recall.suggestions([hungry]).map(item => [item.emojiId, item.desc]), [['food', food]]);
    assert.deepEqual(recall.suggestions([chat]), []);
    assert.deepEqual(new Set(recall.suggestions([hungry, weather, chat]).map(item => item.emojiId)), new Set(['food', 'rain']));
    assert.deepEqual(recall.suggestions([hungry, weather], new Set(['food'])).map(item => item.emojiId), ['rain']);
    stickerAction(store, 'modify_custom_face', { emoji_id: 'food', desc: '少女看着窗外，适合表达天气转晴' });
    stickerAction(store, 'delete_custom_face', { emoji_id: 'rain' });
    await semantics.idle(); await recall.idle();
    assert.deepEqual(stickerRows(store), [['food', 'topics', '少女看着窗外，适合表达天气转晴'], ['food', 'topics', '少女看着窗外，适合表达天气转晴']]);
    assert.deepEqual(recall.suggestions([hungry]), []);
    assert.deepEqual(recall.suggestions([weather]).map(item => item.emojiId), ['food']);
  } finally { await Promise.all([recall.stop(), semantics.stop()]); store.close(); }
});

test('sticker vectors are reused after a restart, a rejected description holds up no other, and another model starts over', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  saveSticker(store, 'food', '少女捧着包子，适合表达想吃小笼包');
  const saved = new StickerStore(store);
  let semantics = new SemanticRecall(embeddingConfig(), store, topics());
  let recall = new StickerRecall(embeddingConfig().embedding, saved, semantics);
  try {
    semantics.start(); recall.start(); await semantics.idle(); await recall.idle(); await Promise.all([recall.stop(), semantics.stop()]);
    saveSticker(store, 'bad', '这一张的描述坏了，适合表达天气');
    saveSticker(store, 'rain', '少女打伞，适合表达天气不好');
    const again = topics('topics', texts => texts.some(text => text.includes('坏')) ? Object.assign(new Error('HTTP 400'), { status: 400 }) : undefined);
    semantics = new SemanticRecall(embeddingConfig(), store, again); semantics.start();
    recall = new StickerRecall(embeddingConfig().embedding, saved, semantics); recall.start(); await recall.idle();
    assert.ok(again.calls.every(texts => !texts.some(text => text.includes('小笼包'))), 'vectors saved before a restart are reused');
    assert.deepEqual([...new Set(stickerRows(store).map(([id]) => id))], ['food', 'rain']);
    assert.deepEqual(store.logs(10).filter(log => log.kind === 'recall_error').map(log => (log.data as { stage: string; emojiId: string })), [{ stage: 'sticker', emojiId: 'bad', message: 'HTTP 400' }]);
    const hungry = event(store, '小笼包'); await semantics.idle(); await recall.idle();
    assert.deepEqual(recall.suggestions([hungry]).map(item => item.emojiId), ['food']);
    await Promise.all([recall.stop(), semantics.stop()]);
    semantics = new SemanticRecall(embeddingConfig({ model: 'other' }), store, topics('other')); semantics.start();
    recall = new StickerRecall(embeddingConfig().embedding, saved, semantics); recall.start(); await recall.idle();
    assert.deepEqual(new Set(stickerRows(store).map(([, model]) => model)), new Set(['other']));
  } finally { await Promise.all([recall.stop(), semantics.stop()]); store.close(); }
});

test('an observation brings the saved stickers that fit what was said, and none when nothing fits', async () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  saveSticker(store, '900_0_0_0_F00D_0_0', '少女捧着包子流口水，适合表达想吃小笼包');
  const recall = new SemanticRecall(embeddingConfig(), store, topics());
  let suggestions!: StickerRecall;
  const f = fixture(undefined, store, recall, (store, cfg) => {
    const saved = new StickerStore(store); suggestions = new StickerRecall(cfg.embedding, saved, recall);
    return [stickersPlugin(cfg, saved, suggestions)];
  });
  const prompts: string[] = [];
  const observe = () => f.faux.setResponses([context => { prompts.push(JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations')))); return answer(''); }]);
  try {
    recall.start(); await f.plugins.start(); await recall.idle(); await suggestions.idle();
    event(store, '好想吃小笼包'); await recall.idle(); await suggestions.idle();
    observe(); await f.brain.run(store.claim(20)!);
    assert.match(prompts[0]!, /Saved stickers of yours whose descriptions fit what was just said, in case you want to send one with send_custom_face/);
    assert.ok(prompts[0]!.includes('900_0_0_0_F00D_0_0'));
    event(store, '随便聊聊'); await recall.idle();
    observe(); await f.brain.run(store.claim(20)!);
    assert.doesNotMatch(prompts[1]!, /Saved stickers of yours/);
  } finally { await Promise.all([f.plugins.stop(), recall.stop()]); store.close(); }
});

test('disabling sticker enhancement restores native tools and blocks a held enhanced tool', async () => {
  const f = fixture({ execute: async () => ({ emoji_id: 'saved' }) });
  f.brain.thought.lifeOnly = false;
  const current = (name: string) => f.tools.current().find(tool => tool.name === name)!;
  try {
    const enhanced = current('add_custom_face');
    assert.ok('desc' in (enhanced.parameters as any).properties);
    f.cfg.plugins['qq-stickers'] = false;
    assert.deepEqual(current('add_custom_face').parameters, findSnowLumaAction('add_custom_face').inputSchema);
    assert.doesNotMatch(current('add_custom_face').description, /alreadySaved|Pass desc/);
    const detail = await current('load_snowluma_tools').execute('detail', { names: ['add_custom_face'] });
    assert.deepEqual(JSON.parse((detail.content[0] as { text: string }).text)[0].inputSchema, findSnowLumaAction('add_custom_face').inputSchema);
    await assert.rejects(enhanced.execute('held', { file: 'a', desc: 'a cat' }), /disabled/);
    assert.equal(f.store.actions().length, 0);
    const saved = await current('add_custom_face').execute('native', { file: 'a' });
    assert.equal(saved.details.alreadySaved, undefined);
    assert.equal(saved.details.described, undefined);
    await current('modify_custom_face').execute('describe', { emoji_id: 'saved', desc: 'a cat' });
    await current('send_custom_face').execute('send', { emoji_id: 'saved', group_id: 100 });
    assert.equal(f.store.actions().length, 3);
    assert.equal(f.plugins.imageCaption({ emoji_id: 'saved' }), '');
    f.cfg.plugins['qq-stickers'] = true;
    assert.ok('desc' in (current('add_custom_face').parameters as any).properties);
  } finally { f.store.close(); }
});

test('an enhanced save rechecks description permission without leaking desc to the native request', async () => {
  const f = fixture(); f.brain.thought.lifeOnly = false;
  try {
    const enhanced = f.tools.current().find(tool => tool.name === 'add_custom_face')!;
    f.cfg.snowluma.tools.deny = ['modify_custom_face'];
    await assert.rejects(enhanced.execute('held', { file: 'a', desc: 'a cat' }), /not enabled describing/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.store.actions().length, 0);
  } finally { f.store.close(); }
});

test('an uncertain description leaves the save standing and is never blindly repeated', async () => {
  const calls: string[] = [];
  const f = fixture({ execute: async name => { calls.push(name); if (name === 'modify_custom_face') throw new Error('receipt lost'); return { emoji_id: 'saved' }; } });
  f.brain.thought.lifeOnly = false;
  f.brain.thought.triggers = new Set([event(f.store, 'Save a cat').id]);
  const save = () => f.tools.current().find(tool => tool.name === 'add_custom_face')!.execute('save', { file: 'a', desc: 'a cat' });
  try {
    const first = await save();
    assert.equal(first.details.outcome, 'success'); assert.equal(first.details.described.outcome, 'unknown');
    const again = await save();
    assert.equal(again.details.reused, true); assert.equal(again.details.described.reused, true);
    assert.deepEqual(calls, ['add_custom_face', 'modify_custom_face']);
    assert.deepEqual(f.store.actions().map(action => [action.kind, action.status]).sort(), [['add_custom_face', 'success'], ['modify_custom_face', 'unknown']]);
  } finally { f.store.close(); }
});

test('describing shares the core action budget and its exhaustion does not undo a save', async () => {
  const f = fixture({ execute: async () => ({ emoji_id: 'saved' }) });
  f.brain.thought.lifeOnly = false; f.cfg.limits.actionsPerHour = 1;
  try {
    const result = await f.tools.current().find(tool => tool.name === 'add_custom_face')!.execute('save', { file: 'a', desc: 'a cat' });
    assert.equal(result.details.outcome, 'success'); assert.equal(result.details.described.outcome, 'failed');
    assert.match(result.details.described.error.message, /rate limit/);
    assert.deepEqual(new StickerStore(f.store).savedStickers(), [{ emojiId: 'saved', desc: '' }]);
    assert.equal(f.store.actions().length, 1);
  } finally { f.store.close(); }
});

test('sticker recommendations reuse message vectors, are shown once per thought, and never enter a review', async () => {
  const cfg = embeddingConfig(); const store = new Store(':memory:'); store.bindAccount(900);
  const saved = new StickerStore(store); saveSticker(store, 'food', '少女捧着包子，适合表达想吃小笼包');
  const embedder = topics(); const semantics = new SemanticRecall(cfg, store, embedder);
  const recommendations = new StickerRecall(cfg.embedding, saved, semantics);
  const plugin = stickersPlugin(cfg, saved, recommendations);
  const thought = { generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false };
  try {
    semantics.start(); plugin.start?.(); await semantics.idle(); await recommendations.idle();
    const hungry = event(store, '我好想吃小笼包呀'); await semantics.idle();
    assert.equal(embedder.calls.flat().filter(text => text === hungry.text).length, 1);
    assert.equal(plugin.observation!([hungry], { ...thought, reviewing: true }).length, 0);
    assert.equal(plugin.observation!([hungry], thought).length, 1);
    assert.equal(plugin.observation!([hungry], thought).length, 0);
    assert.equal(plugin.observation!([hungry], { ...thought }).length, 1);
    cfg.plugins['snowluma-tools'] = false;
    assert.deepEqual(plugin.observation!([hungry], { ...thought }), []);
    assert.equal(embedder.calls.flat().filter(text => text === hungry.text).length, 1);
  } finally { await Promise.all([plugin.stop?.(), semantics.stop()]); store.close(); }
});

test('turning off the plugin stops collection indexing while memory recall continues', async () => {
  const cfg = embeddingConfig(); const store = new Store(':memory:'); store.bindAccount(900);
  const saved = new StickerStore(store); saveSticker(store, 'food', '少女捧着包子，适合表达想吃小笼包');
  const source = event(store, '小笼包话题');
  const memory = store.writeMemory({ kind: 'note', title: '午饭', content: '昨天一起吃小笼包，非常开心', importance: 4, sources: [source.id] }, false);
  const embedder = topics(); const semantics = new SemanticRecall(cfg, store, embedder);
  let recommendations!: StickerRecall;
  const f = fixture(undefined, store, semantics, (_store, config) => {
    config.plugins['qq-stickers'] = false;
    recommendations = new StickerRecall(config.embedding, saved, semantics);
    return [stickersPlugin(config, saved, recommendations)];
  });
  try {
    semantics.start(); await f.plugins.start(); await semantics.idle(); await recommendations.idle();
    assert.deepEqual(stickerRows(store), []);
    assert.ok(!embedder.calls.flat().some(text => text.includes('少女')));
    const hungry = event(store, '好想吃小笼包'); await semantics.idle();
    assert.deepEqual(semantics.recall([hungry]).map(item => item.memory.id), [memory.id]);
    assert.deepEqual(f.plugins.observation([hungry], f.brain.thought), []);
  } finally { await Promise.all([f.plugins.stop(), semantics.stop()]); store.close(); }
});

test('a description changed while embedding was under way never stores the old vectors, and shutdown settles it', async () => {
  const cfg = embeddingConfig(); const store = new Store(':memory:'); store.bindAccount(900);
  const saved = new StickerStore(store); saveSticker(store, 'food', '少女捧着包子，适合表达想吃小笼包');
  const entered = deferred(); const release = deferred();
  const embedder = topics(); const original = embedder.embed;
  let first = true;
  embedder.embed = async (texts, signal) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    signal?.throwIfAborted(); return original(texts, signal);
  };
  const semantics = new SemanticRecall(cfg, store, embedder);
  const recommendations = new StickerRecall(cfg.embedding, saved, semantics);
  try {
    semantics.start(); recommendations.start(); await entered.promise;
    stickerAction(store, 'modify_custom_face', { emoji_id: 'food', desc: '少女打伞，适合表达天气不好' });
    release.resolve(); await recommendations.idle();
    assert.ok(stickerRows(store).every(([, , desc]) => desc === '少女打伞，适合表达天气不好'));
    await recommendations.stop();
    stickerAction(store, 'modify_custom_face', { emoji_id: 'food', desc: '少女捧着包子，适合表达想吃小笼包' });
    await recommendations.idle();
    assert.ok(stickerRows(store).every(([, , desc]) => desc === '少女打伞，适合表达天气不好'));
  } finally { release.resolve(); await Promise.all([recommendations.stop(), semantics.stop()]); store.close(); }
});
