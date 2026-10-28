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
      run: async () => { await release.promise; }, steer: async () => false, abort: () => { aborts++; },
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
    steer: async () => false, abort: () => {},
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
