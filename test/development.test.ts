import { beginAction } from './helpers.js';
import { qqEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentTools, type Message } from '@earendil-works/pi-ai';
import { Store, eventRef } from '../src/store.js';
import { ChatRecord } from '../src/record.js';
import { handleControl } from '../src/control.js';
import { LifeRuntime } from '../src/runtime.js';
import { deferred, event, fixture } from './helpers.js';

const limits = { entryChars: 60, scopeChars: 60 };
function say(store: Store, actorId: number, text: string, options: { groupId?: number; messageId?: number; name?: string; at?: number; segments?: unknown[] } = {}) {
  const groupId = 'groupId' in options ? options.groupId : 100;
  return store.receive(qqEvent({ key: crypto.randomUUID(), kind: 'message', at: options.at ?? Date.now(), text, groupId, actorId, payload: { message_id: options.messageId, message_type: groupId ? 'group' : 'private', sender: { user_id: actorId, card: options.name ?? `P${actorId}` }, message: options.segments ?? [{ type: 'text', data: { text } }] } }, store))!;
}
function notice(store: Store, kind: string, actorId: number, payload: Record<string, unknown>, at = Date.now()) {
  return store.receive(qqEvent({ key: crypto.randomUUID(), kind, at, text: kind, groupId: 100, actorId, payload: { group_id: 100, user_id: actorId, ...payload } }, store))!;
}
function sent(store: Store, kind: string, args: Record<string, unknown>, messageId?: number) {
  const action = beginAction(store, crypto.randomUUID(), kind, args, []).action;
  store.finishAction(action.id, 'success', messageId === undefined ? null : { message_id: messageId });
  return action;
}
const updates = (messages: Message[]) => messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')
  ? [JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>')))] : []);

test('development holds everywhere unless it belongs to one group, an impression is of one person, and all of it needs support beyond its own messages', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const other = say(store, 7, '你这也太长了吧');
    const mine = say(store, 900, '（叉腰）我就是要说很长很长的一段话！');
    const echo = store.receive(qqEvent({ key: 'tool:1', kind: 'adapter:qq_main:send_group_msg', at: Date.now(), text: '{}', payload: { result: {}, origin: 'self' } }, store), true)!;
    const base = { title: 'Short replies', content: 'Keep group replies short', importance: 5 };
    // What one person wants belongs to the impression of them, not to a habit.
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', scope: "person:qq:user:7", sources: [other.id] }, false), /habit or practice scope is global/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'practice', scope: "person:qq:user:7", sources: [other.id] }, false), /habit or practice scope is global/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'impression', sources: [other.id] }, false), /impression scope is person/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', sources: [mine.id, echo.id] }, false), /cannot rest only on your own messages/);
    // Its own notes and the program's bookkeeping are no more evidence than its messages; a memory carries the evidence it cites.
    const wake = store.receive(qqEvent({ key: 'wake:1', kind: 'wake', at: Date.now(), text: 'Plan the day', payload: {} }, store))!;
    const ownNote = store.writeMemory({ ...base, kind: 'note', sources: [mine.id] }, false);
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', sources: [ownNote.id, wake.id] }, false), /cannot rest only on your own messages/);
    // A plan cites what was in view when it was set; its wake event does not pass that on as evidence.
    const plan = store.schedule('Check in', 'commitment', 0, [other.id]); store.enqueueDue();
    const due = String(store.db.prepare('SELECT id FROM events WHERE source_key=?').get(plan.id)!.id);
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', sources: [due] }, false), /cannot rest only on your own messages/);
    assert.ok(store.writeMemory({ ...base, kind: 'habit', sources: [store.writeMemory({ ...base, kind: 'note', sources: [other.id] }, false).id] }, false));
    const habit = store.writeMemory({ ...base, kind: 'habit', sources: [mine.id, other.id] }, false);
    assert.equal(habit.scope, 'global');
    assert.equal(store.writeMemory({ ...base, kind: 'practice', sources: [other.id] }, false).scope, 'global');
    // A practice describes others; citing what it saw itself do is allowed.
    assert.ok(store.writeMemory({ ...base, kind: 'practice', scope: "conversation:qq:900:group:100", sources: [mine.id] }, false));
    const impression = store.writeMemory({ ...base, kind: 'impression', title: 'P7', content: 'Teases me about long messages', scope: "person:qq:user:7", sources: [eventRef(other.id)] }, false);
    assert.deepEqual(impression.sources, [other.id]); assert.deepEqual(impression.subjects, ['qq:user:7']);
    // What is known of a person is several entries, each revised alone (ADR-0026).
    const second = store.writeMemory({ ...base, kind: 'impression', title: 'Where', content: 'Lives in Chengdu', scope: "person:qq:user:7", sources: [other.id] }, false);
    const revised = store.writeMemory({ ...base, kind: 'impression', content: 'Teases me, kindly', scope: "person:qq:user:7", sources: [other.id], supersedes: impression.id }, false);
    assert.deepEqual(store.development(["person:qq:user:7"]).map(memory => memory.id), [second.id, revised.id]);
    assert.deepEqual(second.subjects, ['qq:user:7']);
    assert.throws(() => store.writeMemory({ ...base, kind: 'note', sources: ['#00000000'] }, false), /does not exist/);
  } finally { store.close(); }
});

test('development is bounded per kind and scope for the digital life but not for operator corrections, and retired entries leave use', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const source = say(store, 7, '+1');
    const write = (content: string, supersedes?: string) => store.writeMemory({ kind: 'practice', title: 'Chains', content, importance: 5, scope: "conversation:qq:900:group:100", sources: [source.id], supersedes }, false, limits);
    const first = write('x'.repeat(40));
    const habit = store.writeMemory({ kind: 'habit', title: 'Join chains', content: 'h'.repeat(50), importance: 5, scope: "conversation:qq:900:group:100", sources: [source.id] }, false, limits);
    assert.throws(() => write('y'.repeat(30)), /practices in conversation:qq:900:group:100 would reach 70 characters, above the limit of 60.*retire_memory/);
    const merged = write('z'.repeat(55), first.id);
    assert.equal(store.development(["conversation:qq:900:group:100"]).length, 2);
    const corrected = handleControl(store, { args: ['memory', 'correct', merged.id, 'w'.repeat(80)] }) as { id: string; scope: string };
    assert.equal(corrected.scope, "conversation:qq:900:group:100");
    assert.throws(() => store.retireMemory(say(store, 7, 'x').id), /Only a current habit/);
    const generationBefore = store.settings().generation;
    const retired = handleControl(store, { args: ['memory', 'retire', corrected.id] }) as { id: string; active: boolean };
    assert.deepEqual(retired, { ...store.memory(corrected.id)!, active: false });
    assert.equal(store.settings().generation, generationBefore + 1);
    assert.deepEqual(store.development(["conversation:qq:900:group:100"]).map(memory => memory.id), [habit.id]);
    assert.equal(store.memory(corrected.id)?.active, false);
    assert.ok(store.logs().some(log => log.kind === 'memory_retired'));
    // Batch retire validates every ID before writing and retires all atomically without touching sources.
    const extra = store.writeMemory({ kind: 'impression', title: 'P7', content: 'Likes tea', importance: 5, scope: 'person:qq:user:7', sources: [source.id] }, false, limits);
    assert.throws(() => handleControl(store, { args: ['memory', 'retire', habit.id, corrected.id] }), /Only a current habit, practice, or impression can be retired/);
    assert.equal(store.memory(habit.id)?.active, true);
    const batch = handleControl(store, { args: ['memory', 'retire', habit.id, extra.id] }) as { id: string; active: boolean }[];
    assert.deepEqual(batch.map(item => [item.id, item.active]), [[habit.id, false], [extra.id, false]]);
    assert.equal(store.event(source.id)?.id, source.id);
    assert.equal(store.development(["conversation:qq:900:group:100", 'person:qq:user:7']).length, 0);
  } finally { store.close(); }
});

test('a habit or practice entry says one thing: one too long is refused, and revising one entry leaves the others as they were', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const bounds = { entryChars: 20, scopeChars: 200 };
    const seen = say(store, 7, '+1'); const later = say(store, 8, '+1');
    const write = (kind: 'habit' | 'practice' | 'impression', content: string, extra: { supersedes?: string; sources?: string[]; scope?: string } = {}) => store.writeMemory({ kind, title: 'Chains', content, importance: 5, sources: [seen.id], ...extra }, false, bounds);
    // The refusal says how long an entry may be and what to do with the rest, and saves nothing.
    assert.throws(() => write('habit', 'h'.repeat(21)), /A habit entry says one thing in at most 20 characters.*this content has 21\. Save each point as an entry of its own/);
    assert.throws(() => write('practice', '字'.repeat(21)), /A practice entry says one thing in at most 20 characters/);
    assert.doesNotMatch((() => { try { write('habit', 'h'.repeat(21)); return ''; } catch (error) { return String(error); } })(), /break up a longer entry/);
    assert.equal(store.development(['global']).length, 0);
    // An impression entry is bound the same way, and what is kept about one person shares the scope's bound.
    assert.throws(() => write('impression', 'i'.repeat(21), { scope: 'person:qq:user:7' }), /An impression entry says one thing in at most 20 characters/);
    for (let entry = 0; entry < 10; entry++) write('impression', `${entry}`.repeat(20), { scope: 'person:qq:user:7' });
    assert.throws(() => write('impression', 'one more', { scope: 'person:qq:user:7' }), /impressions in person:qq:user:7 would reach 208 characters, above the limit of 200/);
    assert.ok(write('impression', 'another person', { scope: 'person:qq:user:8' }));
    const chains = write('habit', 'Join a chain once'); const short = write('habit', 'Keep replies short'); const stickers = write('habit', 'One sticker ends it');
    // Revising one entry replaces that entry alone: the others keep their IDs, wording, and time.
    const before = store.development(['global']).filter(memory => memory.id !== chains.id);
    const revised = write('habit', 'Join a chain of 3+', { supersedes: chains.id, sources: [later.id] });
    assert.deepEqual(store.development(['global']).filter(memory => memory.id !== revised.id), before);
    assert.deepEqual(store.development(['global']).map(memory => memory.id).sort(), [short.id, stickers.id, revised.id].sort());
    assert.deepEqual(revised.sources.sort(), [later.id, chains.id].sort());
    const corrected = handleControl(store, { args: ['memory', 'correct', short.id, 'w'.repeat(80)] }) as { id: string };
    assert.equal(store.memory(corrected.id)?.content.length, 80);
    // A longer entry, such as one the operator wrote, is broken up by replacing it with one of its points.
    assert.throws(() => write('habit', 'v'.repeat(30), { supersedes: corrected.id }), /To break up a longer entry, supersede it with one of its points and write the others as new entries\./);
  } finally { store.close(); }
});

test('a list kept as one entry is split once into its items, which rest on its evidence and are forgotten with it', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  try {
    const store = f.store; store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.development.entryChars = 40; f.cfg.compaction.idleAfterMs = 60_000;
    const seen = say(store, 7, '绷'); const other = say(store, 8, '神了');
    store.acknowledge(store.claim(10)!.batchId);
    const group = 'conversation:qq:900:group:100';
    const write = (kind: 'habit' | 'practice', content: string, scope = 'global', sources = [seen.id]) => store.writeMemory({ kind, title: '群聊节奏（昨晚修）', content, importance: 8, scope, sources }, false);
    const list = write('habit', '群聊节奏（昨晚修）：\n1. 一句就够，接当下那口气。\n2、反应词换着来：绷、神了。\n3) 复读链三四人以上原样抄一遍就停，抄完不加评论；只有一两条就不动，这一条本身就超过了四十个字的上限。');
    const bullets = write('practice', '- 极短句不带句末标点，两到六个字就是一条完整的话\n- 单发问号是没看懂，连发是集体懵，不用解释', group);
    const prose = write('practice', '这个群说话很短，多半不带标点。\n有人讲翻车的事先接具体感受，不给建议，也不替人安排。', 'global', [other.id]);
    const mixed = write('habit', '对熟人：\n1. 被逗了回一句嘴硬就收，不解释也不追问为什么\n私聊时：\n2. 先接具体感受，再说自己的事情，不抢话', group);
    const brief = write('habit', '1. 早上只回一次早\n2. 揉一揉回一个就停', group, [other.id]);
    const terse = write('practice', '1. 绷，是这里最常见的单字反应，谁都会用，不必解释它的意思\n2. 「笑死」连发会被当成模子，他们会换着词来', 'conversation:qq:900:group:200');
    const person = store.writeMemory({ kind: 'impression', title: 'P7（昨晚修）', content: 'P7（昨晚修）：\n1. 群里的老朋友，爱拿我的长消息开玩笑，但从不过火\n2. 他说的“我老婆”指的是 P8，是个固定玩笑', importance: 7, scope: 'person:qq:user:7', sources: [seen.id] }, false);
    runtime.start(); await runtime.idle();
    // Items keep their wording, order, scope, importance, and time; the heading and the numbering go.
    const habits = store.development(['global']).filter(memory => memory.kind === 'habit');
    assert.deepEqual(habits.map(memory => memory.content), ['一句就够，接当下那口气。', '反应词换着来：绷、神了。', '复读链三四人以上原样抄一遍就停，抄完不加评论；只有一两条就不动，这一条本身就超过了四十个字的上限。']);
    assert.deepEqual(habits.map(memory => memory.title), ['一句就够', '反应词换着来', '复读链三四人以上原样抄一遍就停']);
    for (const entry of habits) assert.deepEqual({ supersedes: entry.supersedes, sources: entry.sources, importance: entry.importance, createdAt: entry.createdAt, conversations: entry.conversations }, { supersedes: list.id, sources: [list.id], importance: 8, createdAt: list.createdAt, conversations: list.conversations });
    assert.equal(store.memory(list.id)?.active, false);
    assert.deepEqual(store.development([group]).filter(memory => memory.kind === 'practice').map(memory => memory.content), ['极短句不带句末标点，两到六个字就是一条完整的话', '单发问号是没看懂，连发是集体懵，不用解释']);
    assert.equal(store.memory(bullets.id)?.active, false);
    // An opening too short to look an entry up by gives way to the start of the item.
    assert.deepEqual(store.development(['conversation:qq:900:group:200']).map(memory => memory.title), ['绷，是这里最常见的单字反应，谁都会用，不必解释它的意思', '「笑死」连发会被当成模子，他们会换着词来']);
    assert.equal(store.memory(terse.id)?.active, false);
    // What is not plainly one list, or is short enough already, stays as written.
    for (const kept of [prose, mixed, brief]) assert.equal(store.memory(kept.id)?.active, true);
    // What was known of a person as one list becomes entries about that person.
    const known = store.development(['person:qq:user:7']);
    assert.deepEqual(known.map(memory => [memory.kind, memory.title, memory.content, memory.importance]), [['impression', '群里的老朋友', '群里的老朋友，爱拿我的长消息开玩笑，但从不过火', 7], ['impression', '他说的“我老婆”指的是 P8', '他说的“我老婆”指的是 P8，是个固定玩笑', 7]]);
    assert.deepEqual(known.map(memory => memory.subjects), [['qq:user:7'], ['qq:user:7']]);
    assert.equal(store.memory(person.id)?.active, false);
    assert.equal(store.logs(80).filter(log => log.kind === 'development_split').length, 4);
    assert.equal(store.logs(50).filter(log => log.kind === 'memory_written' && (log.data as { supersedes?: string }).supersedes === list.id).length, 3);
    // An item rests on others through the list, so it can be revised with new evidence alone, and its siblings stay.
    const revised = store.writeMemory({ kind: 'habit', title: '一句就够', content: '一句就够；同一件事可以分几口气发。', importance: 8, sources: [other.id], supersedes: habits[0]!.id }, false, { ...f.cfg.development });
    assert.deepEqual(store.development(['global']).filter(memory => memory.kind === 'habit').map(memory => memory.id).sort(), [revised.id, habits[1]!.id, habits[2]!.id].sort());
    // Whoever still holds the list's ID hears what it became.
    assert.throws(() => store.writeMemory({ kind: 'habit', title: 'x', content: 'x', importance: 5, sources: [seen.id], supersedes: list.id }, false), new RegExp(`already been revised\\. It was split into 3 entries, which hold now: .*${habits[1]!.id} \\(反应词换着来\\).*The one you mean is among them\\.`));
    // It happens once: a list an operator writes afterwards stays one entry.
    const corrected = handleControl(store, { args: ['memory', 'correct', prose.id, '1. 这个群说话很短，多半不带标点，一条两到六个字\n2. 有人讲翻车的事先接具体感受，不给建议'] }) as { id: string };
    assert.equal(store.splitDevelopment(40), 0);
    assert.equal(store.memory(corrected.id)?.active, true);
    // Forgetting the evidence takes the list and every entry that came of it (ADR-0003).
    const plan = store.forgetPlan(seen.id);
    for (const gone of [list.id, bullets.id, person.id, ...known.map(memory => memory.id), habits[1]!.id, habits[2]!.id, revised.id, ...store.development([group]).filter(memory => memory.kind === 'practice').map(memory => memory.id)]) assert.ok(plan.includes(gone));
    assert.ok(!plan.includes(brief.id));
    store.forget(seen.id);
    assert.deepEqual(store.development(['global', group]).map(memory => memory.id).sort(), [corrected.id, brief.id].sort());
    assert.equal(store.search('反应词换着来', 8, [], true).length, 0);
  } finally { await runtime.stop(); f.store.close(); }
});

test('the chat record shows everyone in order, folds echoes and reactions into the lines they belong to, and keeps chats apart', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const t = Date.parse('2026-10-28T13:00:00Z');
    const joke = say(store, 7, '地铁以前叫地下高铁', { messageId: 11, name: '寒火', at: t });
    say(store, 8, '1', { messageId: 12, name: '地铁', at: t + 1000 });
    store.receive(qqEvent({ key: 'typing', kind: 'notice:notify:input_status', at: t + 1500, text: 'typing', groupId: 100, actorId: 8, payload: {} }, store));
    const reply = sent(store, 'send_group_msg', { group_id: 100, message: [{ type: 'reply', data: { id: '11' } }, { type: 'text', data: { text: '听着就跑得好累' } }] }, -5);
    store.db.prepare('UPDATE actions SET created_at=? WHERE id=?').run(t + 2000, reply.id);
    say(store, 900, '听着就跑得好累', { messageId: -5, at: t + 2000 });
    notice(store, 'notice:group_msg_emoji_like:add', 8, { operator_id: 8, message_id: -5, likes: [{ emoji_id: '76', count: 1 }] }, t + 3000);
    notice(store, 'notice:group_msg_emoji_like:add', 8, { operator_id: 8, message_id: 11, likes: [{ emoji_id: '424', count: 1 }] }, t + 3500);
    sent(store, 'set_group_reaction', { group_id: 100, message_id: 11, code: '66', is_set: true });
    store.db.prepare("UPDATE actions SET created_at=? WHERE kind='set_group_reaction'").run(t + 3600);
    notice(store, 'notice:group_msg_emoji_like:add', 900, { operator_id: 900, message_id: 11, likes: [{ emoji_id: '66', count: 1 }] }, t + 3700);
    notice(store, 'notice:group_recall:', 8, { operator_id: 8, message_id: 12 }, t + 4000);
    notice(store, 'notice:notify:poke', 7, { target_id: 900, action: '拍了拍', suffix: '的头' }, t + 5000);
    say(store, 7, 'private hello', { groupId: undefined, name: '寒火', at: t + 6000 });
    const text = new ChatRecord(store, "qq:900:group:100").page(t, 50).text;
    assert.match(text, /^Chat record of group 100, from 2026-10-28T21:00:00\.000\+08:00:/);
    assert.match(text, /People: 寒火=qq:user:7, 地铁=qq:user:8; "me" is you/);
    assert.match(text, new RegExp(`21:00:00 ${eventRef(joke.id)} 寒火: 地铁以前叫地下高铁\\n  ↳ 地铁 reacted \\[emoji 424\\]\\n  ↳ me reacted \\[emoji 66\\]\\n`));
    assert.equal(text.match(/emoji 66/g)?.length, 1);
    assert.match(text, new RegExp(`21:00:02 me: \\[reply to ${eventRef(joke.id)} \\(寒火\\)\\] 听着就跑得好累\\n  ↳ 地铁 reacted \\[emoji 76\\]`));
    assert.match(text, /地铁 recalled their message #\w{8} \(地铁\)/);
    assert.match(text, /寒火 拍了拍 me的头/);
    assert.equal(text.match(/听着就跑得好累/g)?.length, 1);
    assert.doesNotMatch(text, /typing|private hello/);
    assert.match(text, /This is the end of the record so far\./);
    assert.match(new ChatRecord(store, "qq:900:private:7").page(t, 50).text, /寒火: private hello/);
  } finally { store.close(); }
});

test('the chat record names faces and reactions, shows what its own stickers are, and quotes what a separate reaction was on', async () => {
  const sticker = 'sticker:1';
  const f = fixture({ execute: async (kind: string) => kind === 'fetch_sys_faces' ? { packs: [{ pack_name: 'Default', emojis: [{ q_sid: '212', q_des: '/托腮' }, { q_sid: '277', q_des: '/汪汪' }, { q_sid: '🙂', q_des: '/smile' }] }] } : { message_id: -9 } });
  f.brain.thought.lifeOnly = false;
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const t = Date.now() - 60_000;
    say(f.store, 7, 'earlier joke here', { messageId: 30, name: '寒火', at: t - 3_600_000 });
    say(f.store, 8, 'look', { messageId: 31, name: '地铁', at: t, segments: [{ type: 'text', data: { text: 'look' } }, { type: 'face', data: { id: '277' } }] });
    notice(f.store, 'notice:group_msg_emoji_like:add', 7, { operator_id: 7, message_id: 31, likes: [{ emoji_id: '212', count: 1 }, { emoji_id: '128077', count: 1 }] }, t + 1000);
    const note = sent(f.store, 'modify_custom_face', { emoji_id: sticker, desc: 'A cat jumping for joy, for happy moments' });
    const face = sent(f.store, 'send_custom_face', { group_id: 100, emoji_id: sticker }, -6);
    const reaction = sent(f.store, 'set_group_reaction', { group_id: 100, message_id: 30, code: '212' });
    for (const [action, at] of [[note, t + 1500], [face, t + 2000], [reaction, t + 3000]] as const) f.store.db.prepare('UPDATE actions SET created_at=? WHERE id=?').run(at, action.id);
    const read = (args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === 'read_chat_record')!.execute('read', args as never).then(result => (result.content[0] as { text: string }).text);
    const text = await read({ conversation: "qq:900:group:100", from: new Date(t).toISOString() });
    assert.match(text, /地铁: look\[face 277 汪汪\]\n  ↳ 寒火 reacted \[emoji 212 托腮\]\[emoji 128077 👍\]/);
    assert.match(text, /me: \[saved sticker: A cat jumping for joy, for happy moments\]/);
    assert.match(text, /me reacted \[emoji 212 托腮\] to #\w{8} \(寒火: earlier joke here\)/);
    assert.deepEqual(f.store.setting('faces'), { 212: { name: '托腮' }, 277: { name: '汪汪' } });
    // Only one's own lines, as a review reads them.
    assert.match(await read({ conversation: "qq:900:group:100", person: 'self' }), /me: \[saved sticker: A cat.*\n.*me reacted \[emoji 212 托腮\] to #\w{8} \(寒火: earlier joke here\)/);
  } finally { f.store.close(); }
});

test('only a review moves the review point, by reading on or jumping ahead, while a conversation looking back leaves it', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const t = Date.now() - 60_000;
    for (let index = 0; index < 5; index++) say(f.store, 7 + (index % 2), `line ${index}`, { at: t + index * 1000 });
    const before = f.store.reviewMark("qq:900:group:100");
    assert.ok(before < t);
    f.faux.setResponses([
      answer(call('read_chat_record', { conversation: "qq:900:group:100", limit: 2 })),
      context => {
        const result = JSON.stringify(context.messages.at(-1));
        assert.match(result, /line 0.*line 1/); assert.doesNotMatch(result, /line 2/);
        assert.match(result, /More follows: read_chat_record with from=/);
        return answer(call('read_chat_record', { conversation: "qq:900:group:100", from: new Date(t + 4000).toISOString() }));
      },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /line 4/); return answer(call('read_chat_record', { conversation: "qq:900:group:100", query: 'LINE 3' })); },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /latest items containing \\"LINE 3\\".*line 3/); return answer('Read enough'); },
    ]);
    event(f.store, 'A new message', 100);
    await f.brain.run(f.store.claim(20)!);
    assert.ok(f.store.reviewMark("qq:900:group:100") < t);
    assert.deepEqual(f.store.reviewBacklog().find(item => item.conversation === "qq:900:group:100")?.messages, 6);
    // A review reads on from the point, and its jump ahead is a deliberate skip.
    const review = f.store.receive(qqEvent({ key: 'review', kind: 'memory_maintenance', at: Date.now(), text: 'Review', payload: {} }, f.store), true)!;
    f.reviewFaux.setResponses([
      answer(call('read_chat_record', { conversation: "qq:900:group:100", limit: 2 })),
      context => {
        assert.match(JSON.stringify(context.messages.at(-1)), /line 0.*line 1/);
        assert.equal(f.store.reviewMark("qq:900:group:100"), t + 1001);
        assert.deepEqual(f.store.reviewBacklog().find(item => item.conversation === "qq:900:group:100")?.messages, 4);
        return answer(call('read_chat_record', { conversation: "qq:900:group:100", from: new Date(t + 3000).toISOString(), limit: 1 }));
      },
      answer('Skipped ahead'),
    ]);
    await f.reviewer.review({ batchId: 'review', events: [review] });
    assert.equal(f.store.reviewMark("qq:900:group:100"), t + 3001);
  } finally { f.store.close(); }
});

test('a conversation that reads a chat record to its end hears that new messages come by themselves', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const t = Date.now() - 60_000;
    for (let index = 0; index < 3; index++) say(f.store, 7, `line ${index}`, { at: t + index * 1000 });
    f.faux.setResponses([
      answer(call('read_chat_record', { conversation: "qq:900:group:100", from: new Date(t).toISOString(), limit: 1 })),
      context => {
        const result = JSON.stringify(context.messages.at(-1));
        assert.match(result, /More follows/); assert.doesNotMatch(result, /by themselves/);
        return answer(call('read_chat_record', { conversation: "qq:900:group:100", from: new Date(t + 1000).toISOString() }));
      },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /line 2.*This is the end of the record so far\.\\nNewer messages come to you by themselves.*潜水.*end your thought without a tool call/); return answer(''); },
    ]);
    event(f.store, 'A new message', 100);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.faux.state.callCount, 3);
  } finally { f.store.close(); }
});

test('of what is known of a person the most important comes with a thought, and the rest is listed by title and read when asked for', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.development.personChars = 30;
    const source = say(f.store, 7, 'source'); f.store.acknowledge(f.store.claim(5)!.batchId);
    const know = (title: string, content: string, importance: number, supersedes?: string) => f.store.writeMemory({ kind: 'impression', title, content, importance, scope: 'person:qq:user:7', sources: [source.id], supersedes }, false, f.cfg.development);
    const friend = know('Friend', 'A close friend who teases', 9);
    const city = know('Where he lives', 'Lives in Chengdu', 5);
    const joke = know('The wife joke', 'My wife means P8', 7);
    const texts = (messages: Message[]) => JSON.stringify(messages.filter(message => message.role === 'toolResult').at(-1)?.content);
    say(f.store, 7, 'Hello');
    f.faux.setResponses([
      context => {
        const snapshot = updates(context.messages as Message[]).at(-1);
        // The first always comes; the next by importance does not fit beside it, and neither does the last.
        assert.deepEqual(snapshot.impressions.map((item: { id: string }) => item.id), [friend.id]);
        assert.deepEqual(snapshot.impressionIndex, [{ id: city.id, scope: 'person:qq:user:7', title: 'Where he lives' }, { id: joke.id, scope: 'person:qq:user:7', title: 'The wife joke' }]);
        return answer(call('recall', { id: joke.id }));
      },
      context => { assert.match(texts(context.messages as Message[]), /My wife means P8/); assert.doesNotMatch(texts(context.messages as Message[]), /Chengdu/); return answer(call('recall', { scope: 'person:qq:user:7' })); },
      context => { assert.match(texts(context.messages as Message[]), /close friend.*Chengdu.*My wife means P8/); return answer(call('recall', {})); },
      context => { assert.match(texts(context.messages as Message[]), /Give a query to search for, an id to read, or a scope to read/); return answer(call('recall', { id: 'm:none' })); },
      context => { assert.match(texts(context.messages as Message[]), /does not exist or has been forgotten/); return answer('Read'); },
    ]);
    await f.brain.run(f.store.claim(20)!);
    // Reading one by its ID or a person's entries together counts as recalling them deliberately.
    assert.deepEqual([friend, city, joke].map(memory => f.store.recalls(memory.id)?.deliberate ?? 0), [1, 1, 2]);
    // Given more importance, where he lives now comes whole. What the context already shows whole stays shown and takes no line in the index.
    const moved = know('Where he lives', 'Moved to Beijing', 10, city.id);
    say(f.store, 7, 'Again');
    f.faux.setResponses([context => {
      const delta = updates(context.messages as Message[]).at(-1);
      assert.equal(delta.format, 'delta');
      assert.deepEqual(delta.impressions, { upsert: [{ id: moved.id, scope: 'person:qq:user:7', title: 'Where he lives', content: 'Moved to Beijing', createdAt: new Date(moved.createdAt).toISOString() }], removedIds: [] });
      assert.deepEqual(delta.impressionIndex, { upsert: [], removedIds: [city.id] });
      return answer('Seen');
    }]);
    await f.brain.run(f.store.claim(20)!);
    // Someone else speaking brings nothing of him.
    say(f.store, 8, 'Hi');
    f.faux.setResponses([context => { const snapshot = updates(context.messages as Message[]).at(-1); assert.deepEqual([snapshot.format, snapshot.impressions, snapshot.impressionIndex], ['snapshot', [], []]); return answer('Quiet'); }]);
    f.brain.abort(); const fresh = f.restart(); await fresh.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('development reaches each thought by scope and people present, and chat records are folded when the thought ends', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const source = say(f.store, 7, 'source');
    const write = (kind: 'habit' | 'practice' | 'impression', scope: string, content: string) => f.store.writeMemory({ kind, title: content, content, importance: 5, scope, sources: [source.id] }, false);
    const habit = write('habit', 'global', 'Short replies in groups');
    const practice = write('practice', "conversation:qq:900:group:100", 'People here answer jokes with 草');
    write('practice', "conversation:qq:900:group:200", 'Another group formal');
    const impression = write('impression', "person:qq:user:7", 'Likes teasing');
    write('impression', "person:qq:user:8", 'Not present');
    f.faux.setResponses([
      context => {
        const snapshot = updates(context.messages as Message[]).at(-1);
        assert.deepEqual(snapshot.myHabits.map((item: { id: string }) => item.id), [habit.id]);
        assert.equal(snapshot.myHabits[0].createdAt, new Date(habit.createdAt).toISOString());
        assert.deepEqual(snapshot.practices.map((item: { id: string }) => item.id), [practice.id]);
        assert.deepEqual(snapshot.impressions.map((item: { id: string }) => item.id), [impression.id]);
        assert.deepEqual(snapshot.recalled, []);
        return answer(call('read_chat_record', { conversation: "qq:900:group:100" }));
      },
      // She goes on to do something, so the record she read stays, folded (a thought of lookups alone leaves none, ADR-0024).
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /P7: Hello/); return answer(call('set_activity', { activity: 'Reading the record' })); },
      answer('Noted'),
    ]);
    event(f.store, 'Hello', 100);
    await f.brain.run(f.store.claim(20)!);
    const results = f.brain.agent.state.messages.filter(message => message.role === 'toolResult' && message.toolName === 'read_chat_record');
    assert.equal(results.length, 1);
    const folded = JSON.stringify(results[0]);
    assert.match(folded, /Folded when the thought ended; read it again with read_chat_record, or read_context ctx:\w+.*Chat record of group 100/);
    assert.doesNotMatch(folded, /P7: Hello/);
    const original = f.store.contextRecord(folded.match(/ctx:\w+/)![0]);
    assert.match(JSON.stringify(original?.message), /P7: Hello/);
    assert.ok(f.store.logs().some(log => log.kind === 'context_folded'));
  } finally { f.store.close(); }
});

test('a review sees the development of the chats it lists and of the people who spoke there', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const source = say(f.store, 7, 'source', { groupId: 200 });
    say(f.store, 8, 'hi', { groupId: undefined });
    f.store.acknowledge(f.store.claim(20)!.batchId);
    const write = (kind: 'practice' | 'impression', scope: string, content: string) => f.store.writeMemory({ kind, title: content, content, importance: 5, scope, sources: [source.id] }, false);
    const rule = write('practice', "conversation:qq:900:group:200", 'No stickers in this group');
    const speaker = write('impression', "person:qq:user:7", 'Likes teasing');
    const friend = write('impression', "person:qq:user:8", 'Chats privately');
    write('impression', "person:qq:user:9", 'Did not speak');
    const review = f.store.receive(qqEvent({ key: 'review', kind: 'memory_maintenance', at: Date.now(), text: 'Review', payload: { backlog: f.store.reviewBacklog() } }, f.store), true)!;
    f.reviewFaux.setResponses([context => {
      const snapshot = updates(context.messages as Message[]).at(-1);
      assert.deepEqual(snapshot.practices.map((item: { id: string }) => item.id), [rule.id]);
      assert.deepEqual(snapshot.impressions.map((item: { id: string }) => item.id), [speaker.id, friend.id]);
      return answer('Reviewed');
    }]);
    await f.reviewer.review({ batchId: 'review', events: [review] });
  } finally { f.store.close(); }
});

test('a thing is kept as it is said: content alone is enough beside a reply, and the reply still ends the thought', async () => {
  const f = fixture();
  try {
    const store = f.store; store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const noted = () => store.logs(80).filter(log => log.kind === 'remembered').reverse().map(log => log.data as { id: string; kind: string; where: string; defaulted?: string[] });
    // Two people speak; what she keeps about one of them rests on that one's message.
    const other = say(store, 8, '今天好冷'); const told = say(store, 7, '我在北京读研，不是上海');
    f.faux.setResponses([answer([call('qq_main__send_group_msg', { group_id: 100, message: '记住啦' }), call('remember', { kind: 'impression', scope: 'person:qq:user:7', content: '在北京读研，不是上海' })]), answer('Must not be called')]);
    await f.brain.run(store.claim(10)!);
    assert.equal(f.faux.state.callCount, 1);
    const [kept] = store.development(['person:qq:user:7']);
    assert.deepEqual([kept!.title, kept!.content, kept!.importance, kept!.sources], ['在北京读研', '在北京读研，不是上海', 5, [told.id]]);
    assert.deepEqual(noted(), [{ id: kept!.id, kind: 'impression', where: 'conversation', defaulted: ['sources', 'title', 'importance'] }]);
    // How she wants to act is kept the same way, resting on everything in front of her; what she gives herself is kept as given.
    const teased = say(store, 7, '你这也太长了吧');
    f.faux.setResponses([answer([call('qq_main__send_group_msg', { group_id: 100, message: '好嘛' }), call('remember', { kind: 'habit', title: '说短点', content: '群里一句就够', importance: 8, sources: [teased.id] }), call('remember', { kind: 'practice', scope: 'conversation:qq:900:group:100', content: '这里的人嫌长消息' })])]);
    await f.brain.run(store.claim(10)!);
    assert.equal(f.faux.state.callCount, 2);
    assert.deepEqual(store.development(['global']).map(memory => [memory.title, memory.importance, memory.sources]), [['说短点', 8, [teased.id]]]);
    assert.deepEqual(store.development(['conversation:qq:900:group:100']).map(memory => memory.sources), [[teased.id]]);
    assert.deepEqual(noted().slice(1).map(item => item.defaulted), [undefined, ['sources', 'title', 'importance']]);
    // Remembering alone does not end a thought, so she can still answer; and the rule on evidence holds for what rests on defaults.
    say(store, 7, '在吗');
    f.faux.setResponses([answer(call('remember', { kind: 'experience', content: 'P7 问我在不在' })), answer(call('qq_main__send_group_msg', { group_id: 100, message: '在' })), answer('Must not be called')]);
    await f.brain.run(store.claim(10)!);
    assert.equal(f.faux.state.callCount, 4);
    store.setSetting('lifeEnabled', true); store.receive({ key: 'wake:noting', kind: 'wake', at: Date.now(), text: 'Free time', payload: { wakeKind: 'life' } });
    let refusal = '';
    f.faux.setResponses([answer(call('remember', { kind: 'habit', content: '我要多说话' })), context => { refusal = JSON.stringify(context.messages.at(-1)); return answer('Fine'); }]);
    await f.brain.run(store.claim(10)!);
    assert.match(refusal, /cannot rest only on your own messages, notes, or judgments/);
    assert.equal(store.development(['global']).length, 1);
    void other;
  } finally { f.store.close(); }
});

test('a review gives its sources itself, and checks against the record what was kept in conversation since the last one', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  try {
    const store = f.store; store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.memory.reflectionEveryEvents = 1; f.cfg.memory.revisitBatch = 0; f.cfg.compaction.idleAfterMs = 0;
    say(store, 7, '我在北京读研');
    f.faux.setResponses([answer([call('qq_main__send_group_msg', { group_id: 100, message: '好' }), call('remember', { kind: 'impression', scope: 'person:qq:user:7', title: '读研的地方', content: '在北京读研' }), call('remember', { kind: 'note', content: '今天的日记' })])]);
    let prompt = ''; let refusal = '';
    f.reviewFaux.setResponses([
      context => { prompt = JSON.stringify(context.messages); return answer(call('remember', { kind: 'experience', content: 'P7 说他在北京读研' })); },
      context => { refusal = JSON.stringify(context.messages.at(-1)); return answer(call('remember', { kind: 'experience', content: 'P7 说他在北京读研', sources: [store.recent(5).find(event => event.kind === 'message')!.id] })); },
      answer('Reviewed'),
    ]);
    runtime.start(); await runtime.idle(); await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 3);
    const kept = store.development(['person:qq:user:7'])[0]!;
    // The review is told what she kept as it was said, though not her diary, and asked to check it against the record.
    assert.match(prompt, new RegExp(`Since your last review you kept these in conversation, as they were said: ${kept.id} \\(impression: 读研的地方\\)\\. Each had only that moment to go on\\..*check them against it`));
    assert.doesNotMatch(prompt, /今天的日记/);
    assert.match(prompt, /Keep as an entry of its own anything the record shows that you would want to have the next time that person or group comes up/);
    // A review has no message in front of it to rest a memory on.
    assert.match(refusal, /A memory review has no message in front of it to rest this on\. Give in sources the events from the record that show it; for a revision, the events that show the change/);
    assert.match(prompt, /Whatever you save or revise here, give its sources: the lines of the record that show it/);
    assert.deepEqual(store.logs(80).filter(log => log.kind === 'remembered').map(log => (log.data as { where: string }).where).sort(), ['conversation', 'conversation', 'review']);
    // The next review is told only of what was kept since, and what a review itself wrote is not among it.
    say(store, 7, '又来了');
    f.faux.setResponses([answer('Quiet')]);
    f.reviewFaux.setResponses([context => { prompt = JSON.stringify(context.messages); return answer('Reviewed again'); }]);
    await runtime.tick(); await runtime.idle(); await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 4);
    assert.doesNotMatch(prompt, /Since your last review you kept these/);
  } finally { await runtime.stop(); f.store.close(); }
});

test('an experience tells one thing, and the longer ones from before are due to be gone back over, once', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const bounds = { entryChars: 60, scopeChars: 200, experienceChars: 30 };
    const DAY = 86_400_000; const now = Date.now();
    const first = say(store, 7, '午饭吃了小笼包', { at: now - 3 * DAY }); const last = say(store, 8, '晚上去看新番', { at: now - 3 * DAY + 3_600_000 });
    const elsewhere = say(store, 7, '私下说的', { groupId: undefined, at: now - 3 * DAY + 60_000 });
    const write = (kind: 'experience' | 'note', title: string, content: string, sources: string[], limits?: typeof bounds, age = 2) => { const memory = store.writeMemory({ kind, title, content, importance: 5, sources }, false, limits); store.db.prepare('UPDATE memories SET created_at=? WHERE id=?').run(now - age * DAY, memory.id); return memory; };
    // Her own long experience is refused with what to do instead; a note of any length, and an experience from before the bound, are not.
    assert.throws(() => write('experience', 'A day', 'x'.repeat(31), [first.id], bounds), /An experience tells one thing that happened in at most 30 characters, under a title that names it; this content has 31\. Save each thing as an experience of its own.*belongs in a note\.$/);
    assert.ok(write('note', 'Diary', 'x'.repeat(300), [first.id], bounds));
    const digest = write('experience', 'A whole afternoon', '1. 午饭吃了小笼包，大家都在聊\n2. 晚上约了去看新番的首映\n3. 私下里他说下周搬家', [first.id, last.id, elsewhere.id]);
    assert.throws(() => store.writeMemory({ kind: 'experience', title: 'Lunch', content: 'y'.repeat(31), importance: 5, sources: [first.id], supersedes: digest.id }, false, bounds), /To break up a longer experience, supersede it with one of the things it tells and write the others as new experiences\.$/);
    const older = write('experience', 'An older afternoon', 'z'.repeat(40), [first.id], undefined, 5);
    const brief = write('experience', 'Lunch', '午饭吃了小笼包', [first.id]);
    const recalled = write('experience', 'Film', '晚上去看新番', [last.id]);
    const young = write('experience', 'Just now', 'w'.repeat(40), [last.id], undefined, 0.5);
    store.noteRecalled('spontaneous', [{ id: recalled.id, similarity: 0.7 }]); store.noteRecalled('deliberate', [{ id: recalled.id }]);
    // Only the long ones, from the oldest; a short one is left however often it came to mind, and so is one written today.
    const due = store.revisitDue(10, 30, now);
    assert.deepEqual(due.map(item => item.memory.id), [older.id, digest.id]);
    assert.ok(![brief.id, recalled.id, young.id].some(id => due.some(item => item.memory.id === id)));
    // Each comes with the stretch of every chat its events are from.
    assert.deepEqual(due[1]!.spans, [{ conversation: 'qq:900:group:100', from: first.at, to: last.at, events: 2 }, { conversation: 'qq:900:private:7', from: elsewhere.at, to: elsewhere.at, events: 1 }]);
    assert.deepEqual(store.revisitDue(1, 30, now).map(item => item.memory.id), [older.id]);
    // Among them, the one that has come to mind goes first.
    store.noteRecalled('spontaneous', [{ id: digest.id, similarity: 0.7 }]);
    assert.deepEqual(store.revisitDue(10, 30, now).map(item => item.memory.id), [digest.id, older.id]);
    // Once gone over it is not due again, and neither is one replaced or forgotten meanwhile.
    store.markRevisited([digest.id, 'm:none']);
    store.writeMemory({ kind: 'experience', title: 'Older, checked', content: 'short', importance: 5, sources: [first.id], supersedes: older.id }, false);
    assert.deepEqual(store.revisitDue(10, 30, now), []);
    store.forget(digest.id);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM memory_revisits').get()!.n), 0);
  } finally { store.close(); }
});

test('going back over old memories runs batch after batch until none are left, reads each with the record it rests on, and counts a batch only when it finishes', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  const DAY = 86_400_000; const now = Date.now();
  try {
    const store = f.store; store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.memory.reflectionEveryEvents = 10_000; f.cfg.memory.experienceChars = 30; f.cfg.memory.revisitBatch = 1; f.cfg.compaction.idleAfterMs = 0;
    const lunch = say(store, 7, '午饭吃了小笼包', { at: now - 3 * DAY }); const film = say(store, 8, '晚上去看新番', { at: now - 3 * DAY + 3_600_000 });
    say(store, 9, '后来才来的人', { at: now - DAY });
    store.acknowledge(store.claim(10)!.batchId);
    const aged = (memory: { id: string }, days = 2) => { store.db.prepare('UPDATE memories SET created_at=? WHERE id=?').run(now - days * DAY, memory.id); return memory; };
    const digest = aged(store.writeMemory({ kind: 'experience', title: 'A whole afternoon', content: '1. 午饭吃了小笼包，大家都在聊\n2. 晚上约了去看新番的首映', importance: 5, sources: [lunch.id, film.id] }, false), 4);
    const second = aged(store.writeMemory({ kind: 'experience', title: 'Another afternoon', content: 'z'.repeat(40), importance: 5, sources: [film.id] }, false), 3);
    const knows = (person: number, content: string) => store.writeMemory({ kind: 'impression', title: `P${person}`, content, importance: 5, scope: `person:qq:user:${person}`, sources: [lunch.id] }, false);
    const seven = knows(7, 'Likes buns'); knows(9, 'Came later');
    // A diary entry rests on the digest, and a commitment under way had it in view.
    const diary = store.writeMemory({ kind: 'note', title: 'Diary', content: 'A good afternoon', importance: 5, sources: [digest.id] }, false);
    store.schedule('Bring buns', 'commitment', now + DAY, [digest.id]);
    // It does not wait for a rest: any quiet moment with no review under way will do.
    store.setSetting('lifeEnabled', true); store.schedule('Plan the day', 'life', now + DAY);
    let prompt = ''; let impressions: string[] = []; let tools: string[] = []; let results = '';
    f.reviewFaux.setResponses([
      context => {
        prompt = JSON.stringify(context.messages.at(-2) ?? ''); tools = getCurrentTools(context.messages).map(tool => tool.name);
        impressions = updates(context.messages as Message[]).at(-1).impressions.map((item: { id: string }) => item.id);
        return answer([call('recall', { id: digest.id }), call('read_chat_record', { conversation: 'qq:900:group:100', from: new Date(lunch.at).toISOString() })]);
      },
      context => {
        assert.match(JSON.stringify(context.messages.slice(-2)), /小笼包.*P7: 午饭吃了小笼包/);
        return answer([call('remember', { kind: 'experience', title: '午饭的小笼包', content: '午饭吃了小笼包，大家都在聊', importance: 5, sources: [lunch.id], supersedes: digest.id }), call('remember', { kind: 'experience', title: '约看新番首映', content: '晚上约了去看新番的首映', importance: 5, sources: [film.id] })]);
      },
      context => { results = JSON.stringify(context.messages.filter(message => message.role === 'toolResult').slice(-2)); return answer('Done'); },
    ]);
    runtime.start(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 3); assert.ok(!store.logs(80).some(log => log.kind === 'review_stopped'));
    // The prompt names the oldest due memory and where to read what it rests on; the review has what is kept of those who spoke in that stretch, not of who came later.
    assert.match(prompt, new RegExp(`go back over memories you wrote a while ago.*${digest.id} \\(A whole afternoon\\), written \\S+: 2 events in qq:900:group:100 from \\S+\\+08:00 to \\S+\\+08:00`));
    assert.doesNotMatch(prompt, new RegExp(second.id));
    assert.deepEqual(impressions, [seven.id]);
    assert.ok(tools.includes('remember') && tools.includes('read_chat_record') && !tools.some(name => name.endsWith('send_group_msg')));
    // What it wrote is one thing each and has just been checked; the batch counts as gone over.
    const kept = store.search('', 20).filter(memory => memory.kind === 'experience' && memory.id !== second.id);
    assert.deepEqual(kept.map(memory => memory.title).sort(), ['午饭的小笼包', '约看新番首映'].sort());
    assert.equal(store.memory(digest.id)?.active, false);
    // It changed how the memory is kept: what rested on it stays, and the conversations are not woken to hear of it.
    assert.equal(store.memory(diary.id)?.active, true);
    assert.match(results, /stillRestingOnOldVersion.*Diary.*cites.*Bring buns/); assert.doesNotMatch(results, /withdrawn|citesHandedOn/);
    assert.equal(Number(store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='memory_revision'").get()!.n), 0);
    assert.deepEqual(store.db.prepare('SELECT memory_id FROM memory_revisits ORDER BY 1').all().map(row => String(row.memory_id)), [digest.id, ...kept.map(memory => memory.id)].sort());
    assert.deepEqual(store.logs(80).find(log => log.kind === 'revisit_finished')?.data, { memories: [digest.id] });
    // The next batch follows at once. One that stops before it finishes leaves its batch due, and waits before it is tried again.
    f.reviewFaux.setResponses([() => { throw new Error('model down'); }]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 4);
    assert.ok(store.logs(80).some(log => log.kind === 'review_stopped'));
    assert.deepEqual(store.revisitDue(5, 30).map(item => item.memory.id), [second.id]);
    f.reviewFaux.setResponses([answer('Must not be called yet')]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 4);
    // Turned off, nothing is gone back over.
    (runtime as unknown as { revisitAfter: number }).revisitAfter = 0; f.cfg.memory.revisitBatch = 0;
    await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 4);
    // Turned on again it takes up the batch that stopped, and when none are left it is over for good.
    f.cfg.memory.revisitBatch = 1;
    f.reviewFaux.setResponses([answer('Nothing to change')]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 5);
    assert.equal(store.revisitPending(30), false); assert.equal(store.setting('revisitsDone', false), false);
    await runtime.tick(); await runtime.idle();
    assert.equal(store.setting('revisitsDone', false), true); assert.ok(store.logs(80).some(log => log.kind === 'revisits_done'));
    // A long experience that appears afterwards, such as one the operator writes, starts nothing.
    store.db.prepare('UPDATE memories SET created_at=? WHERE id=?').run(now - 3 * DAY, store.writeMemory({ kind: 'experience', title: 'Written by hand', content: 'h'.repeat(80), importance: 5, sources: [film.id] }, false).id);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.reviewFaux.state.callCount, 5);
  } finally { await runtime.stop(); f.store.close(); }
});

test('review waits for a quiet moment and lists the chats it has not read', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.memory.reflectionEveryEvents = 1; f.cfg.compaction.idleAfterMs = 60_000;
    say(f.store, 7, 'Earlier chat'); f.store.acknowledge(f.store.claim(1)!.batchId);
    event(f.store, 'Arrives while due');
    f.faux.setResponses([context => { assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /memory_maintenance/); return answer('Reply'); }]);
    runtime.start(); await runtime.idle();
    // Just settled: not yet quiet, and the backlog is under three times the threshold.
    await runtime.tick(); await runtime.idle();
    assert.equal(f.store.pending(), 0); assert.equal(f.reviewFaux.state.callCount, 0);
    f.cfg.compaction.idleAfterMs = 0;
    let review = '';
    f.reviewFaux.setResponses([context => { review = JSON.stringify(context.messages); return answer('Reviewed'); }]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.reviewFaux.state.callCount, 1);
    // Checked here rather than in the callback, where the runtime would record a failed assertion as review_stopped and the test would still pass.
    assert.ok(!f.store.logs(50).some(log => log.kind === 'review_stopped'));
    assert.match(review, /memory_maintenance.*apart from your conversations.*schedule it as a commitment.*Unreviewed chat records: \S*group:100: 2 new messages since .*read_chat_record.*person=self/);
    // What happened comes before form: corrections, unstated outcomes, what lasts about people, then her own lines beside theirs,
    // habits in plain speech that one slip does not make, and one person's ways kept in their impression.
    assert.match(review, /asked of you and whether you did it.*corrected, questioned, or contradicted you.*leave it unstated.*over rules for answering someone.*how they differ in form, not content.*not for a single joke, tease, or slip.*in plain speech.*is not retired for being a restriction.*into your impression of them/);
    // The earlier rebalance told her most reviews need no habit and to read her own lines only for recurring patterns; she then stopped reading them.
    assert.doesNotMatch(review, /Most reviews need no new habit or practice|Only check your own lines/);
    // The prompt is the review's instructions: it arrives whole, not cut off with a pointer to read_event.
    assert.match(review, /retire entries that no longer hold\./); assert.doesNotMatch(review, /chars; read_event/);
  } finally { await runtime.stop(); f.store.close(); }
});

test('a review runs beside a conversation: new messages reach the thought, never the review, which sends nothing and keeps no context', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  const deciding = deferred(); const release = deferred();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.memory.reflectionEveryEvents = 1; f.cfg.compaction.idleAfterMs = 0;
    say(f.store, 7, 'Earlier chat'); f.store.acknowledge(f.store.claim(1)!.batchId);
    f.reviewFaux.setResponses([
      async context => {
        deciding.resolve();
        const tools = getCurrentTools(context.messages).map(tool => tool.name);
        assert.ok(['read_chat_record', 'remember', 'retire_memory', 'schedule_activity'].every(name => tools.includes(name)));
        assert.ok(!tools.some(name => ['send_group_msg', 'send_private_msg', 'send_custom_face', 'set_activity', 'finish_activity', 'update_pursuit'].includes(name)));
        await release.promise;
        return answer(call('inspect_actions', {}));
      },
      context => { assert.doesNotMatch(JSON.stringify(context.messages), /Are you there/); return answer('Reviewed'); },
    ]);
    runtime.start(); await deciding.promise;
    // The conversation goes on while the review is still deciding.
    say(f.store, 7, 'Are you there?');
    const exchanges = (messages: unknown[]) => JSON.stringify(messages.filter(message => (message as { role: string }).role !== 'system'));
    f.faux.setResponses([context => {
      release.resolve();
      assert.doesNotMatch(exchanges(context.messages), /memory_maintenance/);
      return answer(call("qq_main__send_group_msg", { group_id: 100, message: 'Here' }));
    }]);
    await runtime.tick(); await runtime.idle();
    assert.deepEqual(f.sent.map(item => item.args.message), ['Here']);
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.reviewFaux.state.callCount, 2);
    assert.doesNotMatch(exchanges(f.brain.agent.state.messages), /memory_maintenance/);
    assert.equal(f.reviewer.agent.state.messages.length, 1);
  } finally { release.resolve(); await runtime.stop(); f.store.close(); }
});

test('a review schedules only commitments, and hands on together, once it ends, the revisions that something under way cites', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    f.cfg.memory.reflectionEveryEvents = 1; f.cfg.compaction.idleAfterMs = 0;
    const said = say(f.store, 7, 'I moved to Wuhan', { groupId: undefined });
    f.store.acknowledge(f.store.claim(20)!.batchId);
    const where = f.store.writeMemory({ kind: 'impression', title: 'P7', content: 'Lives in Beijing', importance: 5, scope: "person:qq:user:7", sources: [said.id] }, false);
    const style = f.store.writeMemory({ kind: 'habit', title: 'Short replies', content: 'Short replies', importance: 5, sources: [said.id] }, false);
    const tone = f.store.writeMemory({ kind: 'practice', title: 'Tildes', content: 'Friends end lines with ~', importance: 4, sources: [said.id] }, false);
    // A plan cites what was in view when it was set, so one plan can cite several memories a review revises.
    f.store.schedule('Visit P7 in Beijing', 'commitment', Date.now() + 86_400_000, [where.id, style.id]);
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const results = (messages: Message[]) => messages.filter(message => message.role === 'toolResult');
    f.reviewFaux.setResponses([
      answer([call('schedule_activity', { title: 'Read in the evening', kind: 'life', at }), call('schedule_activity', { title: 'Nap', kind: 'commitment', at, rest: true }), call('schedule_activity', { title: 'Send P7 the photo I promised', kind: 'commitment', at })]),
      context => {
        const [life, rest, owed] = results(context.messages as Message[]);
        assert.match(JSON.stringify(life), /schedules only commitments/); assert.match(JSON.stringify(rest), /schedules only commitments/);
        assert.equal(owed?.role === 'toolResult' && owed.isError, false);
        return answer([
          call('remember', { kind: 'impression', title: 'P7', content: 'Lives in Wuhan now', importance: 6, scope: "person:qq:user:7", sources: [said.id], supersedes: where.id }),
          call('remember', { kind: 'habit', title: 'Short replies', content: 'Short replies, longer in private', importance: 5, sources: [said.id], supersedes: style.id }),
          call('remember', { kind: 'practice', title: 'Tildes', content: 'Friends end lines with ~ or ～', importance: 4, sources: [said.id], supersedes: tone.id }),
        ]);
      },
      context => {
        const [impression, habit, practice] = results(context.messages as Message[]).slice(-3);
        assert.match(JSON.stringify(impression), /cites.*Visit P7 in Beijing.*citesHandedOn.*when this review ends/);
        assert.match(JSON.stringify(habit), /citesHandedOn/);
        assert.doesNotMatch(JSON.stringify(practice), /citesHandedOn/);
        // Nothing reaches the conversations while the review goes on.
        assert.equal(f.store.pending(), 0);
        return answer('Reviewed');
      },
    ]);
    runtime.start(); await runtime.idle();
    assert.deepEqual(f.store.wakes().map(wake => wake.title).sort(), ['Send P7 the photo I promised', 'Visit P7 in Beijing']);
    // The two revisions the plan cites come as one event that names the plan once; the third, cited by nothing, does not come at all.
    const handed = f.store.claim(20)!.events;
    assert.deepEqual(handed.map(item => item.kind), ['memory_revision']);
    assert.match(handed[0]!.text, /^Understandings were revised outside your thoughts: m:\S+ replaces m:\S+; m:\S+ replaces m:\S+\. What is under way cites them: /);
    assert.equal(handed[0]!.text.split('Visit P7 in Beijing').length - 1, 1);
    assert.equal(f.faux.state.callCount, 0);
  } finally { await runtime.stop(); f.store.close(); }
});

test('revising or citing a version that was already replaced names the version that holds now', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const said = say(store, 7, 'Call me Qi');
    const impression = (content: string, supersedes?: string) => store.writeMemory({ kind: 'impression', title: 'P7', content, importance: 5, scope: "person:qq:user:7", sources: [said.id], supersedes }, false);
    const first = impression('Goes by P7');
    const second = impression('Goes by Qi', first.id);
    // A review that read the first version revises it after a conversation already has.
    assert.throws(() => impression('Goes by P7, likes jokes', first.id), new RegExp(`already been revised\\. Its current version is ${second.id} \\(P7\\): Goes by Qi Revise that version instead, keeping what it added`));
    assert.throws(() => store.writeMemory({ kind: 'experience', title: 'Nickname', content: 'P7 has a nickname', importance: 4, sources: [first.id] }, false), new RegExp(`read its current version first: ${first.id}\\. Its current version is ${second.id}`));
    store.retireMemory(second.id);
    assert.throws(() => impression('Goes by Qi still', second.id), /^Error: The memory to revise does not exist or has already been revised\.$/);
  } finally { store.close(); }
});

test('a reference resolves without its #, and a full ID made up from one resolves by its digits', () => {
  const store = new Store(':memory:'); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const said = say(store, 7, 'Hello');
    const digits = said.id.slice(2, 10);
    assert.equal(store.resolve(`#${digits}`), said.id);
    assert.equal(store.resolve(digits), said.id);
    const madeUp = `e:${digits}-0000-4000-8000-000000000000`;
    assert.equal(store.resolve(madeUp), said.id);
    // Cited by a made-up full ID, the event it meant becomes the source.
    assert.deepEqual(store.writeMemory({ kind: 'experience', title: 'Greeting', content: 'P7 said hello', importance: 3, sources: [madeUp] }, false).sources, [said.id]);
    // Digits that name no event leave a full ID as written for its caller to report, and a reference fails as before.
    assert.equal(store.resolve('e:00000000-0000-4000-8000-000000000000'), 'e:00000000-0000-4000-8000-000000000000');
    assert.throws(() => store.resolve('00000000'), /Reference 00000000 does not exist or has been deleted/);
    assert.equal(store.resolve('m:00000000-0000-4000-8000-000000000000'), 'm:00000000-0000-4000-8000-000000000000');
  } finally { store.close(); }
});

test('her own revision reports what it reached in its result and starts no thought; an operator correction comes to her as an event', async () => {
  const f = fixture();
  try {
    f.store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
    const source = say(f.store, 7, 'I moved to Wuhan', { groupId: undefined });
    f.store.acknowledge(f.store.claim(20)!.batchId);
    const fact = f.store.writeMemory({ kind: 'understanding', title: 'Where P7 lives', content: 'Lives in Beijing', importance: 5, sources: [source.id] }, false);
    const plan = f.store.writeMemory({ kind: 'note', title: 'Visit plan', content: 'Visit P7 in Beijing', importance: 4, sources: [fact.id] }, false);
    const visit = f.store.schedule('Visit P7', 'commitment', Date.now() + 86_400_000, [fact.id]);
    say(f.store, 7, 'Wuhan, remember?', { groupId: undefined });
    let result: Record<string, unknown> = {};
    f.faux.setResponses([
      () => answer(call('remember', { kind: 'understanding', title: 'Where P7 lives', content: 'Lives in Wuhan', importance: 5, sources: [source.id], supersedes: fact.id })),
      context => { const last = context.messages.at(-1)!; result = JSON.parse((last.content as { text: string }[])[0]!.text); return answer('Noted'); },
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.deepEqual(Object.keys(result), ['id', 'kind', 'supersedes', 'withdrawn', 'cites']);
    assert.deepEqual(result.withdrawn, [{ id: plan.id, kind: 'note', title: 'Visit plan' }]);
    assert.deepEqual(result.cites, [{ id: visit.id, kind: 'commitment', title: 'Visit P7' }]);
    assert.equal(f.store.pending(), 0);
    handleControl(f.store, { args: ['memory', 'correct', String(result.id), 'Lives in Wuhan, near the lake'] });
    const [revision] = f.store.claim(20)!.events;
    assert.equal(revision?.kind, 'memory_revision');
    assert.match(revision!.text, new RegExp(`revised outside your thoughts: m:\\S+ replaces ${result.id}\\.`));
  } finally { f.store.close(); }
});

test('the limit on impressions counts people who have one, not everyone who spoke', async () => {
  const f = fixture();
  try {
    f.cfg.development.people = 1;
    const known = say(f.store, 8, 'I only drink oolong');
    f.store.acknowledge(f.store.claim(20)!.batchId);
    f.store.writeMemory({ kind: 'impression', title: 'P8', content: 'Drinks only oolong', importance: 5, scope: 'person:qq:user:8', sources: [known.id] }, false);
    // The most recent speaker has no impression yet; the one before has.
    say(f.store, 8, 'Tea, anyone?'); say(f.store, 7, 'Hello');
    let seen = '';
    f.faux.setResponses([context => { seen = JSON.stringify(context.messages); return answer('Quiet'); }]);
    await f.brain.run(f.store.claim(20)!);
    assert.match(seen, /Drinks only oolong/);
  } finally { f.store.close(); }
});
