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
