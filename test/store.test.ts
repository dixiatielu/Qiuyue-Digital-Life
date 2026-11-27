import { beginAction } from './helpers.js';
import { qqEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { handleControl, requestControl } from '../src/control.js';
import { config } from './helpers.js';
import { event } from './helpers.js';

test('persistence recovers claimed observations, commitments and uncertain side effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-store-'));
  let store = new Store(join(dir, 'life.sqlite'));
  try {
    const source = event(store); store.claim(10);
    store.setActivity('Reading a book', [source.id]);
    const wake = store.schedule('Promised to return tomorrow', 'commitment', Date.now() + 100000, [source.id]);
    const action = beginAction(store, 'send-1', "qq_main__send_group_msg", { group_id: 100, message: 'OK' }, [source.id]);
    store.close(); store = new Store(join(dir, 'life.sqlite')); store.recover();
    assert.equal(store.pending(), 1); assert.equal(store.settings().activity, 'Reading a book');
    assert.equal(store.wakes()[0]?.id, wake.id); assert.equal(store.actions()[0]?.status, 'unknown');
    assert.deepEqual(store.actions()[0]?.result, { reason: 'Process interrupted; the remote outcome is unconfirmed' });
    assert.equal(beginAction(store, 'different-key', "qq_main__send_group_msg", { group_id: 100, message: 'OK' }, []).action.id, action.action.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('one local process owns one life database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-lease-'));
  const first = new Store(join(dir, 'life.sqlite')); const second = new Store(join(dir, 'life.sqlite'));
  try {
    const release = first.acquireDaemon(); assert.throws(() => second.acquireDaemon(), /already has a daemon/);
    release(); second.acquireDaemon()();
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Chinese memories recall the same person across groups, and correction retires dependent conclusions', () => {
  const store = new Store(':memory:');
  try {
    const source = event(store, 'I like oolong tea lately');
    const memory = store.writeMemory({ kind: 'understanding', title: 'Tea preference', content: '小明说喜欢乌龙茶', importance: 8, subjects: ['7', '小明'], sources: [source.id] }, false);
    const derived = store.writeMemory({ kind: 'understanding', title: 'Conversation topic', content: 'We can talk about tea', importance: 5, sources: [memory.id] }, false);
    assert.equal(store.search('小明')[0]?.id, memory.id);
    assert.equal(store.search('What to drink today', 5, ['7'])[0]?.id, memory.id);
    const corrected = handleControl(store, { args: ['memory', 'correct', memory.id, 'Correction: now prefers coffee'] }) as { id: string };
    assert.equal(store.memory(derived.id)?.active, false);
    assert.equal(store.memory(memory.id)?.active, false);
    assert.equal(store.search('coffee')[0]?.id, corrected.id);
    assert.equal(store.search('乌龙茶').length, 0);
    assert.equal(store.search('乌龙茶', 10, [], true)[0]?.id, memory.id);
    assert.throws(() => store.writeMemory({ kind: 'understanding', title: 'Old understanding', content: 'Tea', importance: 1, sources: [derived.id] }, false), /has been revised/);
    const next = handleControl(store, { args: ['memory', 'correct', corrected.id, 'Latest correction: prefers plain water'] }) as { id: string };
    assert.ok(store.memory(next.id)?.active);
  } finally { store.close(); }
});

test('forgetting removes source, derived memories, state, scheduled work and FTS; replay cannot restore', () => {
  const store = new Store(':memory:', true);
  try {
    const source = event(store, 'Secret code mooncake', 100, 'original-event');
    const memory = store.writeMemory({ kind: 'experience', title: 'Secret code', content: source.text, importance: 9, sources: [source.id] }, false);
    const derived = store.writeMemory({ kind: 'note', title: 'Diary', content: source.text, importance: 7, sources: [memory.id] }, false);
    store.setActivity(source.text, [derived.id]); store.schedule(source.text, 'commitment', Date.now() - 1, [memory.id]); store.enqueueDue();
    const action = beginAction(store, 'a', "qq_main__send_group_msg", { group_id: 100, message: source.text }, [memory.id]);
    const affected = store.forget(memory.id);
    assert.ok(affected.includes(derived.id)); assert.ok(affected.includes(source.id));
    assert.equal(store.settings().activity, ''); assert.equal(store.wakes().length, 0);
    assert.equal(store.search('mooncake', 10, [], true).length, 0);
    assert.equal(store.pending(), 0);
    assert.equal(store.receive(qqEvent({ ...source, key: 'original-event' }, store)), undefined);
    store.finishAction(action.action.id, 'success', { text: source.text });
    assert.deepEqual(store.actions()[0]?.result, { redacted: true });
    assert.ok(!JSON.stringify(store.status()).includes('mooncake'));
  } finally { store.close(); }
});

test('forgetting and revising reach what rests on a record, and a plan that had it in view, but nothing through the rest of what that plan had in view', () => {
  const store = new Store(':memory:');
  try {
    const note = (title: string, sources: string[]) => store.writeMemory({ kind: 'note', title, content: title, importance: 5, sources }, false);
    const due = (wakeId: string) => { store.enqueueDue(); return store.db.prepare("SELECT id FROM events WHERE kind='wake' AND source_key=?").get(wakeId)!.id as string; };
    const [secret, bystander] = [event(store, 'Secret'), event(store, 'Something else said at the time')];
    const unrelated = note('Unrelated', [bystander.id]);
    // The first plan was set with the secret, the bystander, and an unrelated memory in view; the second with only the first plan's wake event.
    const first = store.schedule('Morning walk', 'commitment', Date.now() - 2, [secret.id, bystander.id, unrelated.id]); const firstDue = due(first.id);
    const diary = note('Walked this morning', [firstDue]);
    const second = store.schedule('Evening reading', 'commitment', Date.now() - 1, [firstDue, diary.id]); const secondDue = due(second.id);
    const later = note('Read in the evening', [secondDue]);

    // The diary rests on the first plan's wake event: forgetting it takes that event and its plan, not what the plan had in view.
    const fromDiary = store.forgetPlan(diary.id);
    for (const taken of [diary.id, firstDue, first.id, second.id, secondDue, later.id]) assert.ok(fromDiary.includes(taken));
    for (const kept of [secret.id, bystander.id, unrelated.id]) assert.ok(!fromDiary.includes(kept));
    // Forgetting the secret takes the plan that had it in view and what rests on that plan's wake event; the chain of later plans stops there.
    const fromSecret = store.forgetPlan(secret.id);
    for (const taken of [secret.id, first.id, firstDue, diary.id]) assert.ok(fromSecret.includes(taken));
    for (const kept of [bystander.id, unrelated.id, second.id, secondDue, later.id]) assert.ok(!fromSecret.includes(kept));

    // Revising the unrelated memory names the plan that cites it; the diary, which only rests on that plan's wake event, stays in everyday recall.
    const reach = store.revisionReach(unrelated.id);
    assert.deepEqual(reach.withdrawn, []); assert.deepEqual(reach.cites.map(item => item.id), [first.id]);
    store.writeMemory({ kind: 'note', title: 'Unrelated', content: 'Revised', importance: 5, sources: [bystander.id], supersedes: unrelated.id }, false);
    assert.equal(store.memory(diary.id)!.active, true); assert.equal(store.memory(later.id)!.active, true);

    store.forget(secret.id);
    assert.equal(store.memory(diary.id), undefined); assert.ok(store.memory(later.id)); assert.ok(store.event(bystander.id));
    assert.deepEqual(store.wakes().map(wake => wake.id), [second.id]);
  } finally { store.close(); }
});

test('retention preserves pending events and required evidence; processed watermark is monotonic', () => {
  const store = new Store(':memory:');
  try {
    const old = { kind: 'message', at: 1, text: 'Old experience', payload: {} };
    const retained = store.receive(qqEvent({ ...old, key: 'retained' }, store))!;
    store.writeMemory({ kind: 'experience', title: 'Important experience', content: 'Old experience', importance: 8, sources: [retained.id] }, false);
    store.receive(qqEvent({ ...old, key: 'forgettable' }, store));
    const claimed = store.claim(10)!; store.acknowledge(claimed.batchId); store.acknowledge(claimed.batchId);
    const pending = store.receive(qqEvent({ ...old, key: 'pending' }, store))!;
    assert.equal(store.processedCount(), 2); assert.equal(store.retain(90), 1);
    assert.equal(store.processedCount(), 2); assert.ok(store.event(retained.id)); assert.ok(store.event(pending.id));
  } finally { store.close(); }
});

test('retention keeps what an unresolved action cites until its outcome is known', () => {
  const store = new Store(':memory:');
  try {
    const old = { kind: 'message', at: 1, text: 'Old experience', payload: {} };
    const [waiting, unconfirmed, settled] = ['waiting', 'unconfirmed', 'settled'].map(key => store.receive(qqEvent({ ...old, key }, store))!);
    store.acknowledge(store.claim(10)!.batchId);
    const pending = store.beginAction('k:waiting', 'send', { n: 1 }, [waiting!.id]).action;
    store.finishAction(store.beginAction('k:unconfirmed', 'send', { n: 2 }, [unconfirmed!.id]).action.id, 'unknown', { reason: 'timeout' });
    store.finishAction(store.beginAction('k:settled', 'send', { n: 3 }, [settled!.id]).action.id, 'success', {});
    assert.equal(store.retain(90), 1);
    assert.ok(store.event(waiting!.id)); assert.ok(store.event(unconfirmed!.id)); assert.equal(store.event(settled!.id), undefined);
    store.finishAction(pending.id, 'success', {});
    assert.equal(store.retain(90), 1);
    assert.equal(store.event(waiting!.id), undefined); assert.ok(store.event(unconfirmed!.id));
  } finally { store.close(); }
});

test('pursuits are bounded, keep fiction behind its switch, and leave with forgotten sources', () => {
  const store = new Store(':memory:');
  try {
    const source = event(store, 'Let us both learn this song');
    assert.throws(() => store.updatePursuit({ title: 'Drawing clouds', progress: 'Sketched one', fictional: true }, [], false), /Fictional daily life is disabled/);
    const pursuit = store.updatePursuit({ title: 'Learning the song with a friend', progress: 'First verse', fictional: false }, [source.id], false);
    for (let n = 1; n < 8; n++) store.updatePursuit({ title: `Pursuit ${n}`, progress: 'Started', fictional: false }, [], false);
    assert.throws(() => store.updatePursuit({ title: 'One too many', progress: 'Started', fictional: false }, [], false), /Eight pursuits/);
    store.finishPursuit(store.pursuits()[0]!.id, 'dropped');
    assert.equal(store.pursuits().length, 7);
    assert.throws(() => store.finishPursuit('p:missing', 'done'), /No active pursuit/);
    assert.ok(store.status().pursuits.some(item => item.id === pursuit.id));
    store.forget(source.id);
    assert.ok(!store.pursuits().some(item => item.id === pursuit.id));
  } finally { store.close(); }
});

test('a diary entry about a fictional day is kept as fiction and needs no actual source', () => {
  const store = new Store(':memory:');
  try {
    const input = { kind: 'note' as const, title: 'Rainy day', content: 'Stayed in and drew clouds', importance: 3, sources: [], fictional: true };
    assert.throws(() => store.writeMemory(input, false), /Fictional daily life is disabled/);
    assert.equal(store.writeMemory(input, true).fictional, true);
    assert.throws(() => store.writeMemory({ ...input, fictional: false }, true), /must reference IDs/);
  } finally { store.close(); }
});

test('a plan or pursuit that ended before the period leaves with what it had in view; what is under way keeps its events', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now(); const long = now - 100 * 86_400_000;
    const old = { kind: 'message', at: long, text: 'Old experience', payload: {} };
    const [planned, pursued, underWay, remembered] = ['planned', 'pursued', 'under way', 'remembered'].map(key => store.receive(qqEvent({ ...old, key }, store))!);
    store.acknowledge(store.claim(10)!.batchId);
    const ended = store.schedule('Finished long ago', 'life', long, [planned!.id]); store.finishWake(ended.id, 'done');
    const open = store.schedule('Still to come', 'commitment', long, [underWay!.id]);
    const recent = store.schedule('Finished yesterday', 'life', now - 86_400_000, [underWay!.id]); store.finishWake(recent.id, 'done');
    const pursuit = store.updatePursuit({ title: 'Learning the koto', progress: 'Dropped', fictional: false }, [pursued!.id], false); store.finishPursuit(pursuit.id, 'dropped');
    store.db.prepare('UPDATE pursuits SET updated_at=? WHERE id=?').run(long, pursuit.id);
    store.writeMemory({ kind: 'experience', title: 'Kept', content: 'Old experience', importance: 8, sources: [remembered!.id] }, false);
    store.db.prepare('INSERT INTO trace(at,kind,data) VALUES (?,?,?)').run(long, 'old', '{}'); store.log('new', {});
    store.db.prepare('INSERT INTO calls VALUES (?,?,?)').run('call:old', long, 'run'); store.chargeCall('run', null);
    assert.equal(store.retain(90, now), 2);
    assert.equal(store.event(planned!.id), undefined); assert.equal(store.event(pursued!.id), undefined);
    assert.ok(store.event(underWay!.id)); assert.ok(store.event(remembered!.id));
    assert.deepEqual(store.wakes().map(wake => wake.id), [open.id]); assert.deepEqual(store.pastLifePlans(8).map(wake => wake.id), [recent.id]);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM pursuits').get()!.n), 0);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM sources WHERE owner_id IN (?,?)').get(ended.id, pursuit.id)!.n), 0);
    assert.ok(!store.logs().some(log => log.kind === 'old')); assert.ok(store.logs().some(log => log.kind === 'new')); assert.equal(store.dailyCalls(now), 1);
    assert.equal(Number(store.db.prepare('SELECT count(*) AS n FROM calls').get()!.n), 1);
  } finally { store.close(); }
});

test('fiction retains provenance and cannot become real evidence', () => {
  const store = new Store(':memory:');
  try {
    const input = { kind: 'fiction' as const, title: 'Dream', content: 'Drinking tea on the Moon', importance: 5, sources: [] };
    assert.throws(() => store.writeMemory(input, false), /Fictional daily life is disabled/);
    const fiction = store.writeMemory(input, true);
    const derived = store.writeMemory({ ...input, kind: 'understanding', sources: [fiction.id] }, true);
    assert.equal(derived.fictional, true);
    assert.throws(() => store.writeMemory({ ...input, kind: 'experience', sources: [fiction.id] }, false), /Fictional daily life is disabled/);
  } finally { store.close(); }
});

test('success is deduplicated for replayed observations, but new events can produce the same action', () => {
  const store = new Store(':memory:');
  try {
    const first = beginAction(store, 'a', "qq_main__send_group_msg", { group_id: 100, message: 'Hello' }, [], ['e:1']);
    store.finishAction(first.action.id, 'success', {});
    assert.equal(beginAction(store, 'b', "qq_main__send_group_msg", { group_id: 100, message: 'Hello' }, [], ['e:1']).fresh, false);
    assert.equal(beginAction(store, 'c', "qq_main__send_group_msg", { group_id: 100, message: 'Hello' }, [], ['e:2']).fresh, true);
    assert.throws(() => beginAction(store, 'a', "qq_main__send_group_msg", { group_id: 100, message: 'Different' }, []), /same action key/);
  } finally { store.close(); }
});

test('whole pause stops wakes; life off keeps commitments and blocks life plans', () => {
  const store = new Store(':memory:');
  try {
    store.schedule('reading', 'life', 1); store.schedule('Agreed to meet', 'commitment', 1);
    store.setSetting('paused', true); store.enqueueDue(); assert.equal(store.pending(), 0);
    store.setSetting('paused', false); store.enqueueDue(); assert.equal(store.pending(), 1);
    assert.equal(store.claim(10, false)?.events[0]?.payload.wakeKind, 'commitment');
    store.setSetting('lifeEnabled', true); store.enqueueDue(); assert.equal(store.pending(), 1);
    store.setSetting('lifeEnabled', false); assert.equal(store.claim(10, false), undefined);
  } finally { store.close(); }
});

test('events from before receive times were recorded count as overdue, and ambient events are timed separately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-received-')); const path = join(dir, 'life.sqlite');
  const store = new Store(path);
  const old = store.receive(qqEvent({ key: 'old', kind: 'message', at: 1, groupId: 100, actorId: 7, text: 'Before receive timestamps', payload: {} }, store))!;
  store.db.prepare('UPDATE events SET received_at=NULL WHERE id=?').run(old.id);
  try {
    assert.deepEqual(store.pendingTiming(), { first: 0, last: 0, ambient: undefined });
    assert.equal(store.event(old.id)?.receivedAt, undefined);
    const typing = store.receive(qqEvent({ key: 'typing', kind: 'notice:notify:input_status', at: 2000, actorId: 7, text: 'notify', payload: {} }, store))!;
    assert.deepEqual(store.pendingTiming(), { first: 0, last: typing.receivedAt, ambient: typing.receivedAt });
    assert.equal(store.event(typing.id)?.receivedAt, typing.receivedAt);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('while the digital life rests, group chat not addressed to it is neither claimed nor timed', () => {
  const store = new Store(':memory:', true); store.bindPlatformAccount('qq_main', { platform: 'qq', accountId: String(900) });
  try {
    const { action } = beginAction(store, 'send-1', "qq_main__send_group_msg", { group_id: 100, message: 'Hi' }, []);
    store.finishAction(action.id, 'success', { message_id: -42 });
    const receive = (kind: string, payload: Record<string, unknown>, groupId: number | undefined = 100, actorId = 7) => store.receive(qqEvent({ key: crypto.randomUUID(), kind, at: Date.now(), groupId, actorId, text: kind, payload }, store))!;
    const say = (...message: unknown[]) => receive('message', { message_type: 'group', message });
    const chatter = say({ type: 'text', data: { text: 'Chatter' } });
    const reaction = receive('notice:group_msg_emoji_like:add', { user_id: 8 }, 100, 8);
    const pokeOther = receive('notice:notify:poke', { user_id: 7, target_id: 8 });
    const mention = say({ type: 'at', data: { qq: '900' } }, { type: 'text', data: { text: ' Awake?' } });
    const reply = say({ type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: 'Nice' } });
    const poke = receive('notice:notify:poke', { user_id: 7, target_id: 900 });
    const ban = receive('notice:group_ban:ban', { user_id: 900, operator_id: 7, duration: 60 }, 100, 900);
    const whisper = receive('message', { message_type: 'private', message: [{ type: 'text', data: { text: 'Psst' } }] }, undefined);
    const temporary = receive('message', { message_type: 'private', message: [{ type: 'text', data: { text: 'From the group' } }] });
    assert.equal(store.resting(), false);
    store.schedule('Get up', 'life', Date.now() + 3_600_000, [], true);
    assert.equal(store.resting(), true);
    assert.deepEqual(store.restHeld().map(item => item.id), [chatter.id, reaction.id, pokeOther.id]);
    assert.deepEqual(store.claim(20, true, true)?.events.map(item => item.id), [mention.id, reply.id, poke.id, ban.id, whisper.id, temporary.id]);
    assert.deepEqual(store.pendingTiming(true, true), { first: undefined, last: undefined, ambient: undefined });
    assert.equal(store.pendingTiming(true, false).first, chatter.receivedAt);
    // A rest belongs to autonomous life; with life mode off, nothing is held.
    store.setSetting('lifeEnabled', false); assert.equal(store.resting(), false);
  } finally { store.close(); }
});

test('with no daemon a management command answers from the life that exists and never creates one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-control-'));
  try {
    const cfg = config(); cfg.database = join(dir, 'data/life.sqlite'); cfg.socket = join(dir, 'data/control.sock'); cfg.life.enabled = true;
    await assert.rejects(requestControl(cfg, { args: ['status'] }), /start the daemon first/);
    assert.equal(existsSync(cfg.database), false);
    new Store(cfg.database, cfg.life.enabled).close();
    await requestControl(cfg, { args: ['pause'] });
    const store = new Store(cfg.database);
    try { assert.equal(store.settings().paused, true); assert.equal(store.settings().lifeEnabled, true); } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('shared read-only store queries serve both Store and read-only LifeReader consistently', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { LifeReader } = await import('../src/webui/reader.js');
  const { readConversationName, readDevelopmentMemories, readLatestActorName, readMemoryCounts, readMemoryDetail } = await import('../src/store/queries.js');
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-ro-queries-'));
  const dbPath = join(dir, 'life.sqlite');
  const store = new Store(dbPath);
  try {
    const conv = 'telegram:900:group:-100777';
    const msg = store.receive({
      key: 'tg:ro:1', kind: 'message', at: Date.now(), text: 'Hi from shared query test',
      source: { platform: 'telegram', accountId: '900', instance: 'tg_main', conversation: conv, conversationType: 'group', conversationName: 'Book Club', actor: 'telegram:user:42', actorName: 'Mina', messageId: '1', own: false, addressed: true, attention: 'normal' },
      payload: {},
    }, true)!;
    const habit = store.writeMemory({ kind: 'habit', title: 'Book notes', content: 'Keep notes brief.', importance: 4, sources: [msg.id], scope: `conversation:${conv}` }, false);
    const updated = store.writeMemory({ kind: 'habit', title: 'Book notes', content: 'Keep notes brief and clear.', importance: 5, sources: [msg.id], scope: `conversation:${conv}`, supersedes: habit.id }, false);

    const ro = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(readConversationName(ro, conv), 'Book Club');
      assert.equal(readLatestActorName(ro, 'telegram:user:42'), 'Mina');
      assert.deepEqual(readMemoryCounts(ro), { habit: 1 });
      const dev = readDevelopmentMemories(ro);
      assert.equal(dev.length, 1);
      assert.equal(dev[0]!.scopeName, 'Book Club');
      const detail = readMemoryDetail(ro, updated.id)!;
      assert.equal(detail.versions.length, 1);
      assert.equal(detail.versions[0]!.id, habit.id);
      assert.equal(detail.scopeName, 'Book Club');
    } finally { ro.close(); }

    const reader = new LifeReader(dbPath);
    assert.equal(reader.development()[0]?.scopeName, 'Book Club');
    assert.equal(reader.memory(updated.id)?.versions[0]?.id, habit.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
