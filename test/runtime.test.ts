import test from 'node:test';
import assert from 'node:assert/strict';
import type { Brain } from '../src/brain.js';
import { LifeRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { config, deferred, event } from './helpers.js';

for (const deadline of [null, 50]) {
  test(`run deadline ${deadline === null ? 'is unlimited and still permits pause' : 'aborts at the configured time'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cfg = config(); cfg.limits.runTimeoutMs = deadline;
    const store = new Store(':memory:'); const release = deferred(); let aborts = 0;
    const brain: Brain = {
      streaming: true, thought: { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: false },
      run: async () => { await release.promise; }, steer: async () => false, consolidate: async () => {}, abort: () => { aborts++; },
    };
    const runtime = new LifeRuntime(cfg, store, brain);
    try {
      event(store); runtime.start();
      if (deadline === null) {
        t.mock.timers.tick(120001); assert.equal(aborts, 0);
        runtime.control('pause'); assert.equal(aborts, 1);
      } else {
        t.mock.timers.tick(deadline - 1); assert.equal(aborts, 0);
        t.mock.timers.tick(1); assert.equal(aborts, 1);
      }
      release.resolve(); await runtime.idle();
      assert.equal(store.pending(), 1);
    } finally { release.resolve(); await runtime.stop(); store.close(); }
  });
}

test('a failed whole run releases its observations and waits thirty seconds before retrying', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = config(); const store = new Store(':memory:'); let calls = 0;
  const brain: Brain = {
    streaming: true, thought: { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: false },
    run: async observation => {
      if (++calls === 1) throw new Error('Model request failed');
      store.acknowledge(observation.batchId);
    },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  try {
    event(store); runtime.start(); await runtime.idle();
    assert.equal(calls, 1); assert.equal(store.pending(), 1);
    assert.ok(store.logs().some(log => log.kind === 'thought_error'));
    t.mock.timers.tick(29999); await runtime.tick(); await runtime.idle(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await runtime.tick(); await runtime.idle();
    assert.equal(calls, 2); assert.equal(store.pending(), 0); assert.equal(store.processedCount(), 1);
  } finally { await runtime.stop(); store.close(); }
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const thought = () => ({ generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false });

test('maintenance waits for the thought and parallel review, saves arrivals, and prevents new dispatch until commit', async () => {
  const cfg = config(); cfg.memory.reflectionEveryEvents = 1;
  const store = new Store(':memory:');
  const thinking = deferred(), reviewing = deferred(), commit = deferred();
  let thoughts = 0, reviews = 0, applying = false;
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { thoughts++; await thinking.promise; store.acknowledge(observation.batchId); },
    review: async () => {}, steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const reviewer: Brain = { ...brain, review: async () => { reviews++; await reviewing.promise; } };
  const runtime = new LifeRuntime(cfg, store, brain, reviewer);
  try {
    for (let i = 0; i < 3; i++) event(store);
    store.acknowledge(store.claim(10)!.batchId);
    event(store); runtime.start(); assert.equal(thoughts, 1); assert.equal(reviews, 1);
    const maintenance = runtime.maintain(new AbortController().signal, async () => { applying = true; await commit.promise; });
    const received = event(store, 'During maintenance');
    thinking.resolve(); await flush(); assert.equal(applying, false, 'the parallel review still owns old bindings');
    await runtime.tick(); assert.equal(thoughts, 1); assert.ok(store.event(received.id));
    reviewing.resolve(); await flush(); assert.equal(applying, true);
    await runtime.tick(); assert.equal(thoughts, 1, 'dispatch stays closed while the change is committed');
    commit.resolve(); await maintenance; await runtime.idle(); assert.equal(thoughts, 2);
  } finally { thinking.resolve(); reviewing.resolve(); commit.resolve(); await runtime.stop(); store.close(); }
});

test('a burst starts one thought after the environment goes quiet, and a busy environment after maxDelayMs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = config(); cfg.limits.debounceMs = 1000; cfg.limits.maxDelayMs = 3000;
  const store = new Store(':memory:'); const runs: string[][] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(observation.events.map(item => item.text)); store.acknowledge(observation.batchId); },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  try {
    runtime.start(); await flush();
    event(store, 'One'); await step(0);
    await step(600); event(store, 'Two'); await step(0);
    await step(999); assert.deepEqual(runs, []);
    await step(1); assert.deepEqual(runs, [['One', 'Two']]);
    for (let index = 0; index < 4; index++) { event(store, `Busy ${index}`); await step(800); }
    assert.deepEqual(runs.at(-1), ['Busy 0', 'Busy 1', 'Busy 2', 'Busy 3']);
    const dispatched = store.logs().reverse().filter(log => log.kind === 'observation_dispatched').map(log => log.data as { mode: string; waitedMs: number });
    assert.deepEqual(dispatched.map(item => [item.mode, item.waitedMs]), [['run', 1600], ['run', 3200]]);
  } finally { await runtime.stop(); store.close(); }
});

test('ambient events ride along with other events and never start or steer a thought alone before ambientDelayMs', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = config(); const store = new Store(':memory:'); const release = deferred();
  const runs: string[][] = []; const steers: string[][] = [];
  const kinds = (events: { kind: string }[]) => events.map(item => item.kind);
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(kinds(observation.events)); await release.promise; store.acknowledge(observation.batchId); },
    steer: async observation => { steers.push(kinds(observation.events)); store.acknowledge(observation.batchId); return true; },
    consolidate: async () => {}, abort: () => {},
  };
  const typing = () => store.receive({ key: crypto.randomUUID(), kind: 'notice:notify:input_status', at: Date.now(), actorId: 7, text: 'notify', payload: { status_text: 'typing' } })!;
  const runtime = new LifeRuntime(cfg, store, brain);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  try {
    runtime.start(); await flush();
    typing(); await step(cfg.limits.ambientDelayMs - 1); assert.deepEqual(runs, []);
    event(store, 'The message that was being typed'); await step(0);
    assert.deepEqual(runs, [['notice:notify:input_status', 'message']]);
    store.receive({ key: crypto.randomUUID(), kind: 'notice:group_msg_emoji_like:add', at: Date.now(), groupId: 100, actorId: 8, text: 'group_msg_emoji_like', payload: {} });
    typing(); await step(0); assert.deepEqual(steers, []);
    event(store, 'Follow-up'); await step(0);
    assert.deepEqual(steers, [['notice:group_msg_emoji_like:add', 'notice:notify:input_status', 'message']]);
    typing(); release.resolve(); await runtime.idle();
    await step(cfg.limits.ambientDelayMs - 1); assert.equal(runs.length, 1);
    await step(1); assert.deepEqual(runs.at(-1), ['notice:notify:input_status']);
    assert.equal(store.pending(), 0);
  } finally { release.resolve(); await runtime.stop(); store.close(); }
});

test('idle consolidation runs once per quiet period and yields to an event that can wake a thought', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = config(); cfg.compaction.idleAfterMs = 1000;
  const store = new Store(':memory:'); let consolidations = 0; let runs = 0;
  let stopConsolidation = () => {}; let finishConsolidation = () => {};
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs++; store.acknowledge(observation.batchId); },
    steer: async () => false,
    consolidate: () => { consolidations++; return new Promise<void>((resolve, reject) => { finishConsolidation = resolve; stopConsolidation = () => reject(new Error('Yielded to a new event')); }); },
    abort: () => stopConsolidation(),
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  try {
    runtime.start(); await flush(); assert.equal(consolidations, 1);
    event(store, 'Message during consolidation'); await step(0);
    assert.equal(runs, 0); assert.ok(store.logs().some(log => log.kind === 'consolidation_stopped'));
    await step(0); assert.equal(runs, 1);
    await step(999); assert.equal(consolidations, 1);
    await step(1); assert.equal(consolidations, 2);
    finishConsolidation(); await flush(); await step(5000); assert.equal(consolidations, 2);
  } finally { await runtime.stop(); store.close(); }
});

test('a quiet stretch, its length drawn afresh each time, offers free time when nothing runs and no other life wake is near', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T02:00:00Z') });
  const cfg = config(); cfg.life.freeTime = { enabled: true, quietMinMs: 600_000, quietMaxMs: 1_200_000, gapMs: 3_600_000, perDay: 2 };
  const store = new Store(':memory:', true); const runs: Record<string, unknown>[][] = []; const draws = [0.5, 0];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(observation.events.map(item => item.payload)); store.acknowledge(observation.batchId); },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain, undefined, () => draws.shift() ?? 0);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  const offered = () => runs.filter(events => events.some(payload => payload.freeTime)).length;
  const minute = 60_000;
  try {
    store.schedule('Evening practice', 'life', Date.now() + 48 * 3_600_000);
    event(store, 'Hello'); runtime.start(); await flush(); assert.equal(runs.length, 1);
    // The first stretch drew 15 minutes; a reaction does not break it.
    store.receive({ key: 'reaction', kind: 'notice:group_msg_emoji_like:add', at: Date.now(), groupId: 100, actorId: 8, text: 'group_msg_emoji_like', payload: {} });
    await step(14 * minute); assert.equal(offered(), 0);
    await step(minute); assert.equal(offered(), 1);
    assert.deepEqual(runs.at(-1), [{ wakeKind: 'life', freeTime: true }]);
    // Another comes only a gap away from the last life wake, and no more than perDay.
    await step(59 * minute); assert.equal(offered(), 1);
    await step(minute); assert.equal(offered(), 2);
    await step(3 * 60 * minute); assert.equal(offered(), 2);
    // A day later a new stretch draws anew, here its shortest, and keeps clear of a planned wake coming soon.
    t.mock.timers.tick(21 * 60 * minute); event(store, 'Morning'); await step(0);
    await step(10 * minute); assert.equal(offered(), 3);
    store.schedule('Lunch', 'life', Date.now() + 120 * minute);
    event(store, 'Back'); await step(0); await step(80 * minute);
    assert.equal(offered(), 3);
  } finally { await runtime.stop(); store.close(); }
});

test('rest marked on a planned wake holds free time back until that wake comes or is cancelled', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-30T15:00:00Z') });
  const cfg = config(); cfg.life.freeTime = { enabled: true, quietMinMs: 600_000, quietMaxMs: 600_000, gapMs: 3_600_000, perDay: 8 };
  const store = new Store(':memory:', true); const runs: Record<string, unknown>[][] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(observation.events.map(item => item.payload)); store.acknowledge(observation.batchId); },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain, undefined, () => 0);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  const offered = () => runs.filter(events => events.some(payload => payload.freeTime)).length;
  const hour = 3_600_000;
  try {
    const getUp = store.schedule('Get up', 'life', Date.now() + 8 * hour, [], true);
    assert.equal(store.wakes()[0]?.rest, true);
    runtime.start(); await flush();
    for (let index = 0; index < 7; index++) await step(hour);
    assert.equal(offered(), 0);
    await step(hour); assert.deepEqual(runs.at(-1), [{ wakeId: getUp.id, wakeKind: 'life', dueAt: getUp.dueAt }]);
    store.finishWake(getUp.id, 'done');
    await step(hour); assert.equal(offered(), 1);
    const nap = store.schedule('After the nap', 'life', Date.now() + 5 * hour, [], true);
    await step(2 * hour); assert.equal(offered(), 1);
    store.finishWake(nap.id, 'cancelled');
    await step(60_000); assert.equal(offered(), 2);
  } finally { await runtime.stop(); store.close(); }
});

test('a rest holds group chat not addressed to her until a thought starts, and its end brings only what waited since', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T14:30:00Z') });
  const cfg = config(); cfg.life.freeTime.enabled = false;
  const store = new Store(':memory:', true); store.bindAccount(900);
  const runs: string[][] = []; const notes: Record<string, unknown>[] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => {
      runs.push(observation.events.map(item => item.kind === 'message' ? item.text : item.kind));
      for (const item of observation.events) if (item.kind === 'rest_backlog') notes.push(item.payload);
      store.acknowledge(observation.batchId);
    },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); await runtime.idle(); };
  const hour = 3_600_000;
  try {
    store.schedule('Get up', 'life', Date.now() + 8 * hour, [], true);
    runtime.start(); await flush();
    const since = Date.now();
    await step(60_000);
    const night = Array.from({ length: 15 }, (_, index) => event(store, `Night ${index}`));
    event(store, 'Elsewhere', 200);
    store.receive({ key: crypto.randomUUID(), kind: 'notice:group_msg_emoji_like:add', at: Date.now(), groupId: 100, actorId: 8, text: 'group_msg_emoji_like', payload: { user_id: 8 } });
    store.receive({ key: crypto.randomUUID(), kind: 'notice:notify:input_status', at: Date.now(), actorId: 7, text: 'notify', payload: {} });
    await step(cfg.limits.ambientDelayMs); assert.deepEqual(runs, []);
    store.receive({ key: crypto.randomUUID(), kind: 'message', at: Date.now(), actorId: 7, text: 'Still up?', payload: { message_type: 'private', message: [{ type: 'text', data: { text: 'Still up?' } }] } });
    await step(0); assert.deepEqual(runs, [['notice:notify:input_status', 'Still up?', 'rest_backlog']]);
    assert.deepEqual(notes, [{ since, until: Date.now(), chats: [
      { conversation: 'group:100', from: since + 60_000, messages: 15, notices: 1 },
      { conversation: 'group:200', from: since + 60_000, messages: 1, notices: 0 },
    ] }]);
    await step(1000);
    const later = event(store, 'After going back to sleep');
    await step(8 * hour); await step(0);
    assert.deepEqual(runs.slice(1), [['wake', 'rest_backlog']]);
    assert.deepEqual(notes[1], { since, until: Date.now(), chats: [
      { conversation: 'group:100', from: later.at, messages: 1, notices: 0 },
    ] });
    // What a rest held is perceived through the note, not observed event by event, so it brings no memory review closer.
    assert.equal(store.event(night[0]!.id)?.status, 'processed');
    assert.equal(store.pending(), 0); assert.equal(store.processedCount(), 5);
    assert.equal(store.setting('restingSince'), null);
  } finally { await runtime.stop(); store.close(); }
});

for (const trigger of ['mention', 'reply', 'private', 'poke', 'commitment'] as const) {
  test(`a ${trigger} during rest brings all held chats into the same thought`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T14:30:00Z') });
    const cfg = config(); cfg.life.freeTime.enabled = false; cfg.limits.batchSize = 1;
    const store = new Store(':memory:', true); store.bindAccount(900);
    const runs: Parameters<Brain['run']>[0][] = [];
    const brain: Brain = {
      streaming: true, thought: thought(),
      run: async observation => { runs.push(observation); store.acknowledge(observation.batchId); },
      steer: async () => false, consolidate: async () => {}, abort: () => {},
    };
    const runtime = new LifeRuntime(cfg, store, brain);
    try {
      if (trigger === 'reply') {
        const { action } = store.beginAction('earlier-reply', 'send_group_msg', { group_id: 100, message: 'Hi' }, []);
        store.finishAction(action.id, 'success', { message_id: -42 });
      }
      store.schedule('Get up', 'life', Date.now() + 8 * 3_600_000, [], true);
      runtime.start(); await flush();
      const held = [event(store, 'Earlier context'), event(store, 'In another group', 200)];
      await runtime.tick(); await runtime.idle();
      assert.equal(runs.length, 0);
      t.mock.timers.tick(1000);
      const waking = store.receive({ key: 'waking', at: Date.now(), actorId: 7, text: 'Wake up',
        kind: trigger === 'poke' ? 'notice:notify:poke' : trigger === 'commitment' ? 'wake' : 'message',
        ...(trigger === 'mention' || trigger === 'reply' || trigger === 'poke' ? { groupId: 100 } : {}),
        payload: trigger === 'mention' ? { message: [{ type: 'at', data: { qq: '900' } }] }
          : trigger === 'reply' ? { message: [{ type: 'reply', data: { id: '-42' } }] }
          : trigger === 'poke' ? { target_id: 900 }
          : trigger === 'commitment' ? { wakeKind: 'commitment' } : { message_type: 'private' },
      })!;
      await runtime.tick(); await runtime.idle();
      assert.equal(runs.length, 1);
      assert.ok(runs[0]!.events.some(item => item.id === waking.id));
      const backlog = runs[0]!.events.find(item => item.kind === 'rest_backlog');
      assert.ok(backlog, 'the waking thought must include the held chat record');
      assert.deepEqual((backlog.payload.chats as { conversation: string }[]).map(chat => chat.conversation), ['group:100', 'group:200']);
      assert.ok(held.every(item => store.event(item.id)?.status === 'processed'));
      assert.equal(store.pending(), 0);
      assert.equal(store.resting(), true);
    } finally { await runtime.stop(); store.close(); }
  });
}

test('a failed waking thought keeps its backlog for retry, including after runtime restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T14:30:00Z') });
  const cfg = config(); cfg.life.freeTime.enabled = false; cfg.limits.batchSize = 1;
  const store = new Store(':memory:', true); store.bindAccount(900);
  const runs: Parameters<Brain['run']>[0][] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => {
      runs.push(observation);
      if (runs.length === 1) throw new Error('Model unavailable');
      store.acknowledge(observation.batchId);
    },
    steer: async () => false, consolidate: async () => {}, abort: () => {},
  };
  let runtime = new LifeRuntime(cfg, store, brain);
  try {
    store.schedule('Get up', 'life', Date.now() + 8 * 3_600_000, [], true);
    runtime.start(); await flush();
    event(store, 'Waiting during sleep');
    store.receive({ key: 'waking', kind: 'message', at: Date.now(), actorId: 7, text: 'Wake up', payload: { message_type: 'private' } });
    await runtime.tick(); await runtime.idle();
    const backlog = runs[0]!.events.find(item => item.kind === 'rest_backlog')!;
    assert.ok(backlog); assert.equal(store.event(backlog.id)?.status, 'pending');
    await runtime.stop();
    runtime = new LifeRuntime(cfg, store, brain);
    runtime.start(); await runtime.idle();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs[1]!.events.map(item => item.id), runs[0]!.events.map(item => item.id));
    assert.equal(store.pending(), 0);
  } finally { await runtime.stop(); store.close(); }
});

test('a life wake waiting out a thought during rest does not steer held chat early', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T14:30:00Z') });
  const cfg = config(); cfg.life.freeTime.enabled = false;
  const store = new Store(':memory:', true); const release = deferred();
  const runs: string[][] = []; const steers: string[][] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(observation.events.map(item => item.kind)); if (runs.length === 1) await release.promise; store.acknowledge(observation.batchId); },
    steer: async observation => { steers.push(observation.events.map(item => item.kind)); store.acknowledge(observation.batchId); return true; },
    consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  try {
    store.schedule('Get up', 'life', Date.now() + 8 * 3_600_000, [], true);
    store.schedule('Another planned activity', 'life', Date.now() + 1000);
    runtime.start(); await flush();
    store.receive({ key: 'waking', kind: 'message', at: Date.now(), actorId: 7, text: 'Wake up', payload: { message_type: 'private' } });
    await runtime.tick(); await flush();
    const held = event(store, 'While the thought runs');
    t.mock.timers.tick(1000); await runtime.tick(); await flush();
    assert.deepEqual(runs, [['message']]); assert.deepEqual(steers, []);
    assert.equal(store.event(held.id)?.status, 'pending');
    release.resolve(); await runtime.idle(); await runtime.tick(); await runtime.idle();
    assert.deepEqual(runs, [['message'], ['wake', 'rest_backlog']]);
    assert.equal(store.pending(), 0);
  } finally { release.resolve(); await runtime.stop(); store.close(); }
});

test('a life wake starts a thought of its own: it waits out a running thought and is not claimed with chat', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const cfg = config(); cfg.life.freeTime.enabled = false;
  const store = new Store(':memory:', true); const release = deferred();
  const runs: string[][] = []; const steers: string[][] = [];
  const brain: Brain = {
    streaming: true, thought: thought(),
    run: async observation => { runs.push(observation.events.map(item => item.kind)); if (runs.length === 1) await release.promise; store.acknowledge(observation.batchId); },
    steer: async observation => { steers.push(observation.events.map(item => item.kind)); store.acknowledge(observation.batchId); return true; },
    consolidate: async () => {}, abort: () => {},
  };
  const runtime = new LifeRuntime(cfg, store, brain);
  const step = async (ms: number) => { t.mock.timers.tick(ms); await runtime.tick(); await flush(); };
  try {
    store.schedule('Draw clouds', 'life', Date.now() + 1000);
    runtime.start(); event(store, 'First'); await step(0);
    await step(1000); event(store, 'During'); await step(0);
    assert.deepEqual(steers, [['message']]);
    release.resolve(); await runtime.idle();
    event(store, 'After'); await step(0); await runtime.idle(); await step(0); await runtime.idle();
    assert.deepEqual(runs, [['message'], ['wake'], ['message']]);
  } finally { release.resolve(); await runtime.stop(); store.close(); }
});
