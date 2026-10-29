import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { handleControl } from '../src/control.js';
import { event } from './helpers.js';

test('persistence recovers claimed observations, commitments and uncertain side effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-store-'));
  let store = new Store(join(dir, 'life.sqlite'));
  try {
    const source = event(store); store.claim(10);
    store.setActivity('Reading a book', [source.id]);
    const wake = store.schedule('Promised to return tomorrow', 'commitment', Date.now() + 100000, [source.id]);
    const action = store.beginAction('send-1', 'send_group_msg', { group_id: 100, message: 'OK' }, [source.id]);
    store.close(); store = new Store(join(dir, 'life.sqlite')); store.recover();
    assert.equal(store.pending(), 1); assert.equal(store.settings().activity, 'Reading a book');
    assert.equal(store.wakes()[0]?.id, wake.id); assert.equal(store.actions()[0]?.status, 'unknown');
    assert.deepEqual(store.actions()[0]?.result, { reason: 'Process interrupted; the remote outcome is unconfirmed' });
    assert.equal(store.beginAction('different-key', 'send_group_msg', { group_id: 100, message: 'OK' }, []).action.id, action.action.id);
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
    assert.equal(store.search('What to drink today', 5, ['7'], [200])[0]?.id, memory.id);
    const corrected = handleControl(store, { args: ['memory', 'correct', memory.id, 'Correction: now prefers coffee'] }) as { id: string };
    assert.equal(store.memory(derived.id)?.active, false);
    assert.equal(store.memory(memory.id)?.active, false);
    assert.equal(store.search('coffee')[0]?.id, corrected.id);
    assert.equal(store.search('乌龙茶').length, 0);
    assert.equal(store.search('乌龙茶', 10, [], [], true)[0]?.id, memory.id);
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
    const action = store.beginAction('a', 'send_group_msg', { group_id: 100, message: source.text }, [memory.id]);
    const affected = store.forget(memory.id);
    assert.ok(affected.includes(derived.id)); assert.ok(affected.includes(source.id));
    assert.equal(store.settings().activity, ''); assert.equal(store.wakes().length, 0);
    assert.equal(store.search('mooncake', 10, [], [], true).length, 0);
    assert.equal(store.pending(), 0);
    assert.equal(store.receive({ ...source, key: 'original-event' }), undefined);
    store.finishAction(action.action.id, 'success', { text: source.text });
    assert.deepEqual(store.actions()[0]?.result, { redacted: true });
    assert.ok(!JSON.stringify(store.status()).includes('mooncake'));
  } finally { store.close(); }
});

test('retention preserves pending events and required evidence; processed watermark is monotonic', () => {
  const store = new Store(':memory:');
  try {
    const old = { kind: 'message', at: 1, text: 'Old experience', payload: {} };
    const retained = store.receive({ ...old, key: 'retained' })!;
    store.writeMemory({ kind: 'experience', title: 'Important experience', content: 'Old experience', importance: 8, sources: [retained.id] }, false);
    store.receive({ ...old, key: 'forgettable' });
    const claimed = store.claim(10)!; store.acknowledge(claimed.batchId); store.acknowledge(claimed.batchId);
    const pending = store.receive({ ...old, key: 'pending' })!;
    assert.equal(store.processedCount(), 2); assert.equal(store.retain(90), 1);
    assert.equal(store.processedCount(), 2); assert.ok(store.event(retained.id)); assert.ok(store.event(pending.id));
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
    const first = store.beginAction('a', 'send_group_msg', { group_id: 100, message: 'Hello' }, [], ['e:1']);
    store.finishAction(first.action.id, 'success', {});
    assert.equal(store.beginAction('b', 'send_group_msg', { group_id: 100, message: 'Hello' }, [], ['e:1']).fresh, false);
    assert.equal(store.beginAction('c', 'send_group_msg', { group_id: 100, message: 'Hello' }, [], ['e:2']).fresh, true);
    assert.throws(() => store.beginAction('a', 'send_group_msg', { group_id: 100, message: 'Different' }, []), /same action key/);
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
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE events(id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, group_id INTEGER, actor_id INTEGER, text TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', batch_id TEXT); INSERT INTO events(id,source_key,kind,at,text,payload) VALUES ('e:old','old','message',1,'Before upgrade','{}')");
  legacy.close();
  const store = new Store(path);
  try {
    assert.deepEqual(store.pendingTiming(), { first: 0, last: 0, ambient: undefined });
    assert.equal(store.event('e:old')?.receivedAt, undefined);
    const typing = store.receive({ key: 'typing', kind: 'notice:notify:input_status', at: 2000, actorId: 7, text: 'notify', payload: {} })!;
    assert.deepEqual(store.pendingTiming(), { first: 0, last: typing.receivedAt, ambient: typing.receivedAt });
    assert.equal(store.event(typing.id)?.receivedAt, typing.receivedAt);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
