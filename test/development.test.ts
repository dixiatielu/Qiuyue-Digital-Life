import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, type Message } from '@earendil-works/pi-ai';
import { Store, eventRef } from '../src/store.js';
import { ChatRecord } from '../src/record.js';
import { handleControl } from '../src/control.js';
import { LifeRuntime } from '../src/runtime.js';
import { event, fixture } from './helpers.js';

const limits = { scopeChars: 60, personChars: 40 };
function say(store: Store, actorId: number, text: string, options: { groupId?: number; messageId?: number; name?: string; at?: number; segments?: unknown[] } = {}) {
  const groupId = 'groupId' in options ? options.groupId : 100;
  return store.receive({ key: crypto.randomUUID(), kind: 'message', at: options.at ?? Date.now(), text, groupId, actorId, payload: { message_id: options.messageId, message_type: groupId ? 'group' : 'private', sender: { user_id: actorId, card: options.name ?? `P${actorId}` }, message: options.segments ?? [{ type: 'text', data: { text } }] } })!;
}
function notice(store: Store, kind: string, actorId: number, payload: Record<string, unknown>, at = Date.now()) {
  return store.receive({ key: crypto.randomUUID(), kind, at, text: kind, groupId: 100, actorId, payload: { group_id: 100, user_id: actorId, ...payload } })!;
}
function sent(store: Store, kind: string, args: Record<string, unknown>, messageId?: number) {
  const action = store.beginAction(crypto.randomUUID(), kind, args, []).action;
  store.finishAction(action.id, 'success', messageId === undefined ? null : { message_id: messageId });
  return action;
}
const updates = (messages: Message[]) => messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')
  ? [JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>')))] : []);

test('development holds everywhere unless it belongs to one group, with one impression per person and support beyond its own messages', () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  try {
    const other = say(store, 7, '你这也太长了吧');
    const mine = say(store, 900, '（叉腰）我就是要说很长很长的一段话！');
    const echo = store.receive({ key: 'tool:1', kind: 'snowluma:send_group_msg', at: Date.now(), text: '{}', payload: { result: {} } }, true)!;
    const base = { title: 'Short replies', content: 'Keep group replies short', importance: 5 };
    // What one person wants belongs to the impression of them, not to a habit.
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', scope: 'person:7', sources: [other.id] }, false), /habit or practice scope is global/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'practice', scope: 'person:7', sources: [other.id] }, false), /habit or practice scope is global/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'impression', sources: [other.id] }, false), /impression scope is person/);
    assert.throws(() => store.writeMemory({ ...base, kind: 'habit', sources: [mine.id, echo.id] }, false), /cannot rest only on your own messages/);
    const habit = store.writeMemory({ ...base, kind: 'habit', sources: [mine.id, other.id] }, false);
    assert.equal(habit.scope, 'global');
    assert.equal(store.writeMemory({ ...base, kind: 'practice', sources: [other.id] }, false).scope, 'global');
    // A practice describes others; citing what it saw itself do is allowed.
    assert.ok(store.writeMemory({ ...base, kind: 'practice', scope: 'group:100', sources: [mine.id] }, false));
    const impression = store.writeMemory({ ...base, kind: 'impression', title: 'P7', content: 'Teases me about long messages', scope: 'person:7', sources: [eventRef(other.id)] }, false);
    assert.deepEqual(impression.sources, [other.id]); assert.deepEqual(impression.subjects, ['7']);
    assert.throws(() => store.writeMemory({ ...base, kind: 'impression', scope: 'person:7', sources: [other.id] }, false), /already exists.*supersedes/);
    const revised = store.writeMemory({ ...base, kind: 'impression', content: 'Teases me, kindly', scope: 'person:7', sources: [other.id], supersedes: impression.id }, false);
    assert.deepEqual(store.development(['person:7']).map(memory => memory.id), [revised.id]);
    assert.throws(() => store.writeMemory({ ...base, kind: 'note', sources: ['#00000000'] }, false), /does not exist/);
  } finally { store.close(); }
});

test('development is bounded per kind and scope for the digital life but not for operator corrections, and retired entries leave use', () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  try {
    const source = say(store, 7, '+1');
    const write = (content: string, supersedes?: string) => store.writeMemory({ kind: 'practice', title: 'Chains', content, importance: 5, scope: 'group:100', sources: [source.id], supersedes }, false, limits);
    const first = write('x'.repeat(40));
    const habit = store.writeMemory({ kind: 'habit', title: 'Join chains', content: 'h'.repeat(50), importance: 5, scope: 'group:100', sources: [source.id] }, false, limits);
    assert.throws(() => write('y'.repeat(30)), /practices in group:100 would reach 70 characters, above the limit of 60.*retire_memory/);
    const merged = write('z'.repeat(55), first.id);
    assert.equal(store.development(['group:100']).length, 2);
    const corrected = handleControl(store, { args: ['memory', 'correct', merged.id, 'w'.repeat(80)] }) as { id: string; scope: string };
    assert.equal(corrected.scope, 'group:100');
    assert.throws(() => store.retireMemory(say(store, 7, 'x').id), /Only a current habit/);
    store.retireMemory(corrected.id);
    assert.deepEqual(store.development(['group:100']).map(memory => memory.id), [habit.id]);
    assert.equal(store.memory(corrected.id)?.active, false);
    assert.ok(store.logs().some(log => log.kind === 'memory_retired'));
  } finally { store.close(); }
});

test('the chat record shows everyone in order, folds echoes and reactions into the lines they belong to, and keeps chats apart', () => {
  const store = new Store(':memory:'); store.bindAccount(900);
  try {
    const t = Date.parse('2026-10-28T13:00:00Z');
    const joke = say(store, 7, '地铁以前叫地下高铁', { messageId: 11, name: '寒火', at: t });
    say(store, 8, '1', { messageId: 12, name: '地铁', at: t + 1000 });
    store.receive({ key: 'typing', kind: 'notice:notify:input_status', at: t + 1500, text: 'typing', groupId: 100, actorId: 8, payload: {} });
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
    const text = new ChatRecord(store, 900, 'group:100').page(t, 50).text;
    assert.match(text, /^Chat record of group 100, from 2026-10-28T21:00:00\.000\+08:00:/);
    assert.match(text, /People: 寒火=7, 地铁=8; "me" is you/);
    assert.match(text, new RegExp(`21:00:00 ${eventRef(joke.id)} 寒火: 地铁以前叫地下高铁\\n  ↳ 地铁 reacted \\[emoji 424\\]\\n  ↳ me reacted \\[emoji 66\\]\\n`));
    assert.equal(text.match(/emoji 66/g)?.length, 1);
    assert.match(text, new RegExp(`21:00:02 me: \\[reply to ${eventRef(joke.id)} \\(寒火\\)\\] 听着就跑得好累\\n  ↳ 地铁 reacted \\[emoji 76\\]`));
    assert.match(text, /地铁 recalled their message #\w{8} \(地铁\)/);
    assert.match(text, /寒火 拍了拍 me的头/);
    assert.equal(text.match(/听着就跑得好累/g)?.length, 1);
    assert.doesNotMatch(text, /typing|private hello/);
    assert.match(text, /This is the end of the record so far\./);
    assert.match(new ChatRecord(store, 900, 'private:7').page(t, 50).text, /寒火: private hello/);
  } finally { store.close(); }
});

test('the chat record names faces and reactions, shows what its own stickers are, and quotes what a separate reaction was on', async () => {
  const sticker = 'sticker:1';
  const f = fixture({ execute: async (kind: string) => kind === 'fetch_sys_faces' ? { packs: [{ pack_name: 'Default', emojis: [{ q_sid: '212', q_des: '/托腮' }, { q_sid: '277', q_des: '/汪汪' }, { q_sid: '🙂', q_des: '/smile' }] }] } : { message_id: -9 } });
  f.brain.thought.lifeOnly = false;
  try {
    f.store.bindAccount(900);
    const t = Date.now() - 60_000;
    say(f.store, 7, 'earlier joke here', { messageId: 30, name: '寒火', at: t - 3_600_000 });
    say(f.store, 8, 'look', { messageId: 31, name: '地铁', at: t, segments: [{ type: 'text', data: { text: 'look' } }, { type: 'face', data: { id: '277' } }] });
    notice(f.store, 'notice:group_msg_emoji_like:add', 7, { operator_id: 7, message_id: 31, likes: [{ emoji_id: '212', count: 1 }, { emoji_id: '128077', count: 1 }] }, t + 1000);
    const note = sent(f.store, 'modify_custom_face', { emoji_id: sticker, desc: 'A cat jumping for joy, for happy moments' });
    const face = sent(f.store, 'send_custom_face', { group_id: 100, emoji_id: sticker }, -6);
    const reaction = sent(f.store, 'set_group_reaction', { group_id: 100, message_id: 30, code: '212' });
    for (const [action, at] of [[note, t + 1500], [face, t + 2000], [reaction, t + 3000]] as const) f.store.db.prepare('UPDATE actions SET created_at=? WHERE id=?').run(at, action.id);
    const read = (args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === 'read_chat_record')!.execute('read', args as never).then(result => (result.content[0] as { text: string }).text);
    const text = await read({ conversation: 'group:100', from: new Date(t).toISOString() });
    assert.match(text, /地铁: look\[face 277 汪汪\]\n  ↳ 寒火 reacted \[emoji 212 托腮\]\[emoji 128077 👍\]/);
    assert.match(text, /me: \[saved sticker: A cat jumping for joy, for happy moments\]/);
    assert.match(text, /me reacted \[emoji 212 托腮\] to #\w{8} \(寒火: earlier joke here\)/);
    assert.deepEqual(f.store.faceNames(), { 212: '托腮', 277: '汪汪' });
    // Only one's own lines, as a review reads them.
    assert.match(await read({ conversation: 'group:100', person: 900 }), /me: \[saved sticker: A cat.*\n.*me reacted \[emoji 212 托腮\] to #\w{8} \(寒火: earlier joke here\)/);
  } finally { f.store.close(); }
});

test('reading on from the review point moves it forward, while lookups and jumps ahead do not', async () => {
  const f = fixture();
  try {
    f.store.bindAccount(900);
    const t = Date.now() - 60_000;
    for (let index = 0; index < 5; index++) say(f.store, 7 + (index % 2), `line ${index}`, { at: t + index * 1000 });
    const before = f.store.reviewMark('group:100');
    assert.ok(before < t);
    f.faux.setResponses([
      answer(call('read_chat_record', { conversation: 'group:100', limit: 2 })),
      context => {
        const result = JSON.stringify(context.messages.at(-1));
        assert.match(result, /line 0.*line 1/); assert.doesNotMatch(result, /line 2/);
        assert.match(result, /More follows: read_chat_record with from=/);
        return answer(call('read_chat_record', { conversation: 'group:100', from: new Date(t + 4000).toISOString() }));
      },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /line 4/); return answer(call('read_chat_record', { conversation: 'group:100', query: 'LINE 3' })); },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /latest items containing \\"LINE 3\\".*line 3/); return answer('Read enough'); },
    ]);
    event(f.store, 'A new message', 100);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.reviewMark('group:100'), t + 1001);
    assert.deepEqual(f.store.reviewBacklog(900).find(item => item.conversation === 'group:100')?.messages, 4);
    // In a review, a jump ahead is a deliberate skip.
    f.store.receive({ key: 'review', kind: 'memory_maintenance', at: Date.now(), text: 'Review', payload: {} });
    f.faux.setResponses([answer(call('read_chat_record', { conversation: 'group:100', from: new Date(t + 3000).toISOString(), limit: 1 })), answer('Skipped ahead')]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.reviewMark('group:100'), t + 3001);
  } finally { f.store.close(); }
});

test('development reaches each thought by scope and people present, and chat records are folded when the thought ends', async () => {
  const f = fixture();
  try {
    f.store.bindAccount(900);
    const source = say(f.store, 7, 'source');
    const write = (kind: 'habit' | 'practice' | 'impression', scope: string, content: string) => f.store.writeMemory({ kind, title: content, content, importance: 5, scope, sources: [source.id] }, false);
    const habit = write('habit', 'global', 'Short replies in groups');
    const practice = write('practice', 'group:100', 'People here answer jokes with 草');
    write('practice', 'group:200', 'Another group formal');
    const impression = write('impression', 'person:7', 'Likes teasing');
    write('impression', 'person:8', 'Not present');
    f.faux.setResponses([
      context => {
        const snapshot = updates(context.messages as Message[]).at(-1);
        assert.deepEqual(snapshot.myHabits.map((item: { id: string }) => item.id), [habit.id]);
        assert.deepEqual(snapshot.practices.map((item: { id: string }) => item.id), [practice.id]);
        assert.deepEqual(snapshot.impressions.map((item: { id: string }) => item.id), [impression.id]);
        assert.deepEqual(snapshot.recalled, []);
        return answer(call('read_chat_record', { conversation: 'group:100' }));
      },
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /P7: Hello/); return answer('Noted'); },
    ]);
    event(f.store, 'Hello', 100);
    await f.brain.run(f.store.claim(20)!);
    const results = f.brain.agent.state.messages.filter(message => message.role === 'toolResult');
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
    f.store.bindAccount(900);
    const source = say(f.store, 7, 'source', { groupId: 200 });
    say(f.store, 8, 'hi', { groupId: undefined });
    f.store.acknowledge(f.store.claim(20)!.batchId);
    const write = (kind: 'practice' | 'impression', scope: string, content: string) => f.store.writeMemory({ kind, title: content, content, importance: 5, scope, sources: [source.id] }, false);
    const rule = write('practice', 'group:200', 'No stickers in this group');
    const speaker = write('impression', 'person:7', 'Likes teasing');
    const friend = write('impression', 'person:8', 'Chats privately');
    write('impression', 'person:9', 'Did not speak');
    f.store.receive({ key: 'review', kind: 'memory_maintenance', at: Date.now(), text: 'Review', payload: { backlog: f.store.reviewBacklog(900) } });
    f.faux.setResponses([context => {
      const snapshot = updates(context.messages as Message[]).at(-1);
      assert.deepEqual(snapshot.practices.map((item: { id: string }) => item.id), [rule.id]);
      assert.deepEqual(snapshot.impressions.map((item: { id: string }) => item.id), [speaker.id, friend.id]);
      return answer('Reviewed');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('review waits for a quiet moment and lists the chats it has not read', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    f.store.bindAccount(900);
    f.cfg.memory.reflectionEveryEvents = 1; f.cfg.compaction.idleAfterMs = 60_000;
    say(f.store, 7, 'Earlier chat'); f.store.acknowledge(f.store.claim(1)!.batchId);
    event(f.store, 'Arrives while due');
    f.faux.setResponses([context => { assert.doesNotMatch(JSON.stringify(context.messages.at(-1)), /memory_maintenance/); return answer('Reply'); }]);
    runtime.start(); await runtime.idle();
    // Just settled: not yet quiet, and the backlog is under three times the threshold.
    await runtime.tick(); await runtime.idle();
    assert.equal(f.store.pending(), 0);
    f.cfg.compaction.idleAfterMs = 0;
    f.faux.setResponses([context => {
      assert.match(JSON.stringify(context.messages.at(-1)), /memory_maintenance.*Unreviewed chat records: group:100: 2 new messages since .*read_chat_record.*person=900/);
      return answer('Reviewed');
    }]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 2);
  } finally { await runtime.stop(); f.store.close(); }
});
