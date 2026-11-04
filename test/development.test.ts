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

const limits = { scopeChars: 60, personChars: 40 };
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

test('development holds everywhere unless it belongs to one group, with one impression per person and support beyond its own messages', () => {
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
    assert.ok(store.writeMemory({ ...base, kind: 'habit', sources: [store.writeMemory({ ...base, kind: 'note', sources: [other.id] }, false).id] }, false));
    const habit = store.writeMemory({ ...base, kind: 'habit', sources: [mine.id, other.id] }, false);
    assert.equal(habit.scope, 'global');
    assert.equal(store.writeMemory({ ...base, kind: 'practice', sources: [other.id] }, false).scope, 'global');
    // A practice describes others; citing what it saw itself do is allowed.
    assert.ok(store.writeMemory({ ...base, kind: 'practice', scope: "conversation:qq:900:group:100", sources: [mine.id] }, false));
    const impression = store.writeMemory({ ...base, kind: 'impression', title: 'P7', content: 'Teases me about long messages', scope: "person:qq:user:7", sources: [eventRef(other.id)] }, false);
    assert.deepEqual(impression.sources, [other.id]); assert.deepEqual(impression.subjects, ['qq:user:7']);
    assert.throws(() => store.writeMemory({ ...base, kind: 'impression', scope: "person:qq:user:7", sources: [other.id] }, false), /already exists.*supersedes/);
    const revised = store.writeMemory({ ...base, kind: 'impression', content: 'Teases me, kindly', scope: "person:qq:user:7", sources: [other.id], supersedes: impression.id }, false);
    assert.deepEqual(store.development(["person:qq:user:7"]).map(memory => memory.id), [revised.id]);
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
    store.retireMemory(corrected.id);
    assert.deepEqual(store.development(["conversation:qq:900:group:100"]).map(memory => memory.id), [habit.id]);
    assert.equal(store.memory(corrected.id)?.active, false);
    assert.ok(store.logs().some(log => log.kind === 'memory_retired'));
  } finally { store.close(); }
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
      context => { assert.match(JSON.stringify(context.messages.at(-1)), /line 2.*This is the end of the record so far\.\\nNewer messages come to you by themselves.*潜水.*reply empty/); return answer(''); },
    ]);
    event(f.store, 'A new message', 100);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.faux.state.callCount, 3);
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
    f.reviewFaux.setResponses([context => {
      const review = JSON.stringify(context.messages.at(-1));
      assert.match(review, /memory_maintenance.*apart from your conversations.*schedule it as a commitment.*Unreviewed chat records: group:100: 2 new messages since .*read_chat_record.*person=900/);
      // What happened comes before form: corrections, unknown outcomes, and one person's ways kept in their impression.
      assert.match(review, /asked of you and whether you did it.*corrected, questioned, or contradicted you.*say it is unknown.*into your impression of them/);
      return answer('Reviewed');
    }]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.reviewFaux.state.callCount, 1);
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
