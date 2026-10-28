import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { deferred, event, fixture } from './helpers.js';
import { LifeRuntime } from '../src/runtime.js';

test('real Pi loop can choose silence and never forwards ordinary assistant text', async () => {
  const f = fixture();
  try {
    event(f.store, '@Qiuyue'); f.faux.setResponses([answer('I choose to stay quiet for now.')]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.sent.length, 0); assert.equal(f.store.pending(), 0); assert.equal(f.store.processedCount(), 1);
    assert.equal(f.store.dailyCalls(), 1);
  } finally { f.store.close(); }
});

test('steering enters the same Pi brain after current tools and changes next action to another group', async () => {
  const entered = deferred(); const release = deferred(); const sent: number[] = [];
  const f = fixture({ execute: async (_kind, args) => { sent.push(Number(args.group_id)); if (sent.length === 1) { entered.resolve(); await release.promise; } return { message_id: sent.length }; } });
  try {
    const source = event(f.store, 'Talk about tea', 100);
    f.faux.setResponses([
      answer(call('send_group_msg', { group_id: 100, message: [{ type: 'reply', data: { id: '-12' } }, { type: 'text', data: { text: 'I like tea too' } }] })),
      context => { assert.ok(JSON.stringify(context).includes('New message from another group')); return answer(call('send_group_msg', { group_id: 200, message: 'Heard you' })); },
      answer('Done'),
    ]);
    const work = f.brain.run(f.store.claim(10)!); await entered.promise;
    event(f.store, 'New message from another group', 200);
    assert.equal(await f.brain.steer(f.store.claim(10)!), true);
    assert.equal(f.brain.streaming, true); assert.equal(f.store.event(source.id)?.status, 'processing');
    release.resolve(); await work;
    assert.deepEqual(sent, [100, 200]); assert.equal(f.store.processedCount(), 2);
    assert.equal(f.store.actions().length, 2);
  } finally { release.resolve(); f.store.close(); }
});

test('accepted commitment and activity survive a fresh model context', async () => {
  const f = fixture();
  try {
    event(f.store, 'Let us talk tomorrow');
    f.faux.setResponses([
      answer([call('set_activity', { activity: 'Reading about the Moon' }), call('schedule_activity', { title: 'Discuss the Moon in group 100 tomorrow', kind: 'commitment', at: new Date(Date.now() + 86400000).toISOString() })]), answer('Rest'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    f.store.bumpGeneration(); // Force a fresh working context; durable state must still be provided.
    event(f.store, 'Are you there', 200);
    f.faux.setResponses([context => { const serialized = JSON.stringify(context); assert.ok(serialized.includes('Reading about the Moon')); assert.ok(serialized.includes('Discuss the Moon in group 100 tomorrow')); return answer('Stay silent'); }]);
    await f.brain.run(f.store.claim(10)!); assert.equal(f.store.wakes().length, 1);
  } finally { f.store.close(); }
});

test('uncertain transport outcome cannot be blindly resent through native tools', async () => {
  let attempts = 0;
  const f = fixture({ execute: async () => { attempts++; throw new Error('receipt lost'); } });
  try {
    event(f.store); f.faux.setResponses([
      answer(call('send_group_msg', { group_id: 100, message: 'Hello' })),
      answer(call('send_group_msg', { message: 'Hello', group_id: 100 })), answer('Stop retrying'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(attempts, 1); assert.equal(f.store.actions()[0]?.status, 'unknown');
  } finally { f.store.close(); }
});

test('operator pause aborts current generation but leaves newly received events durable', async () => {
  const entered = deferred(); const release = deferred(); const f = fixture();
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    event(f.store); f.faux.setResponses([async () => { entered.resolve(); await release.promise; return answer(call('group_poke', { group_id: 100, user_id: 7 })); }]);
    runtime.start(); await entered.promise;
    runtime.control('pause'); event(f.store, 'Keep perceiving while paused', 200); release.resolve(); await runtime.idle();
    assert.equal(f.sent.length, 0); assert.equal(f.store.pending(), 2);
    f.faux.setResponses([answer('Read the backlog and stay quiet')]); runtime.control('resume'); await runtime.tick(); await runtime.idle();
    assert.equal(f.store.processedCount(), 2);
  } finally { release.resolve(); await runtime.stop(); f.store.close(); }
});

test('daily budget stops additional model calls while ingestion remains available', async () => {
  const f = fixture(); f.cfg.limits.modelCallsPerDay = 1;
  try {
    event(f.store); f.faux.setResponses([answer(call('set_activity', { activity: 'Reading a book' })), answer('Must not be called')]);
    await assert.rejects(f.brain.run(f.store.claim(10)!), /budget/);
    event(f.store, 'Message after the budget is exhausted'); assert.equal(f.store.pending(), 1);
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.store.settings().activity, 'Reading a book');
  } finally { f.store.close(); }
});

test('default unlimited budgets keep scheduling and acting beyond the former caps while tracking usage', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    assert.equal(f.cfg.limits.modelCallsPerDay, null); assert.equal(f.cfg.limits.actionsPerHour, null);
    for (let index = 0; index < 201; index++) f.store.chargeCall('earlier-run', f.cfg.limits.modelCallsPerDay);
    for (let index = 0; index < 31; index++) {
      const attempt = f.store.beginAction(`earlier-${index}`, 'group_poke', { group_id: 100, user_id: index + 1 }, [], [], f.cfg.limits.actionsPerHour);
      f.store.finishAction(attempt.action.id, 'success', {});
    }
    event(f.store, 'Keep reasoning with unlimited default budgets');
    f.faux.setResponses([answer(call('send_group_msg', { group_id: 100, message: 'Received' })), answer('Done')]);
    runtime.start(); await runtime.idle();
    assert.deepEqual(f.sent.map(item => item.kind), ['send_group_msg']);
    assert.equal(f.store.processedCount(), 1); assert.equal(f.store.pending(), 0);
    assert.equal(f.store.dailyCalls(), 203); assert.equal(f.store.hourlyActions(), 32);
    assert.ok(!f.store.logs().some(log => log.kind === 'thought_error'));
  } finally { await runtime.stop(); f.store.close(); }
});

test('an explicitly configured daily budget still stops dispatch before claiming observations', async () => {
  const f = fixture(); f.cfg.limits.modelCallsPerDay = 1;
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    f.store.chargeCall('earlier-run', 1); event(f.store, 'Wait for tomorrow budget');
    runtime.start(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 0); assert.equal(f.store.pending(), 1);
    assert.equal(f.store.dailyCalls(), 1);
  } finally { await runtime.stop(); f.store.close(); }
});

test('unlimited turns continue beyond twelve model calls until the agent chooses to finish', async () => {
  const f = fixture();
  try {
    assert.equal(f.cfg.limits.maxTurnsPerRun, null);
    event(f.store, 'Continue an activity requiring multiple steps');
    f.faux.setResponses([
      ...Array.from({ length: 14 }, (_, index) => answer(call('set_activity', { activity: `Completed step ${index + 1}` }))),
      answer('Activity completed'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.faux.state.callCount, 15);
    assert.equal(f.store.settings().activity, 'Completed step 14');
    assert.equal(f.store.processedCount(), 1);
  } finally { f.store.close(); }
});

test('explicit turn caps still end a run at the configured call count', async () => {
  const f = fixture(); f.cfg.limits.maxTurnsPerRun = 2;
  try {
    event(f.store);
    f.faux.setResponses([
      answer(call('set_activity', { activity: 'Step one' })),
      answer(call('set_activity', { activity: 'Step two' })),
      answer(call('set_activity', { activity: 'Step three must not run' })),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.faux.state.callCount, 2);
    assert.equal(f.store.settings().activity, 'Step two');
  } finally { f.store.close(); }
});

test('normal output requests allow 32K tokens while respecting a smaller model output cap', async () => {
  const f = fixture();
  try {
    assert.equal(f.cfg.limits.outputReserveTokens, 32768);
    f.brain.agent.state.model = { ...f.brain.agent.state.model!, maxTokens: 65536 };
    event(f.store);
    f.faux.setResponses([(_context, options) => { assert.equal(options?.maxTokens, 32768); return answer('Completed'); }]);
    await f.brain.run(f.store.claim(10)!);
    f.brain.agent.state.model = { ...f.brain.agent.state.model!, maxTokens: 1024 };
    event(f.store, 'When the model has a smaller output limit');
    f.faux.setResponses([(_context, options) => { assert.equal(options?.maxTokens, 1024); return answer('Completed'); }]);
    await f.brain.run(f.store.claim(10)!);
  } finally { f.store.close(); }
});

test('ordinary tool errors return to the model immediately without failing the run', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    event(f.store, 'Inspect a nonexistent experience first');
    f.faux.setResponses([
      answer(call('read_event', { id: 'e:missing' })),
      context => {
        const result = context.messages.filter(message => message.role === 'toolResult').at(-1)!;
        assert.equal(result.isError, true); assert.match(JSON.stringify(result), /experience does not exist/);
        return answer('The source is missing; stop searching');
      },
    ]);
    runtime.start(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 2); assert.equal(f.store.processedCount(), 1);
    assert.ok(!f.store.logs().some(log => log.kind === 'thought_error'));
  } finally { await runtime.stop(); f.store.close(); }
});

test('deletion invalidates in-flight generation before it can save a derived memory', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  try {
    const source = event(f.store, 'Content to forget');
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return answer(call('remember', { kind: 'understanding', title: 'Old content', content: 'Content to forget', importance: 5, sources: [source.id] })); }]);
    const work = f.brain.run(f.store.claim(10)!); const settled = work.catch(() => {});
    await entered.promise; f.store.forget(source.id); release.resolve(); await settled;
    assert.equal(f.store.search('').length, 0); assert.equal(f.store.event(source.id), undefined);
  } finally { release.resolve(); f.store.close(); }
});

test('life mode can plan and wake without new group messages, then complete the initial wake', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    f.store.setSetting('lifeEnabled', true);
    f.faux.setResponses([
      () => answer([
        call('set_activity', { activity: 'Organizing my reading notes about the Moon' }),
        call('schedule_activity', { title: 'Continue reading tomorrow', kind: 'life', at: new Date(Date.now() + 86400000).toISOString() }),
        call('finish_activity', { id: f.store.wakes()[0]!.id, status: 'done' }),
      ]), answer('Rest until the next activity'),
    ]);
    runtime.start(); await runtime.idle();
    assert.equal(f.store.settings().activity, 'Organizing my reading notes about the Moon');
    assert.equal(f.store.wakes().length, 1); assert.equal(f.store.wakes()[0]?.kind, 'life');
    assert.equal(f.sent.length, 0);
  } finally { await runtime.stop(); f.store.close(); }
});

test('memory maintenance continues with life mode disabled and stays in the main brain', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    f.cfg.memory.reflectionEveryEvents = 1;
    const source = event(f.store, 'A group member mentioned reading an interesting book today'); f.store.acknowledge(f.store.claim(1)!.batchId);
    f.faux.setResponses([
      context => { assert.match(JSON.stringify(context), /memory_maintenance/); return answer(call('remember', { kind: 'experience', title: 'Reading discussion', content: 'Heard a group member share thoughts on reading', importance: 6, sources: [source.id] })); }, answer('Consolidation completed'),
    ]);
    runtime.start(); await runtime.idle();
    assert.equal(f.store.settings().lifeEnabled, false); assert.equal(f.store.search('reading').length, 1); assert.equal(f.sent.length, 0);
  } finally { await runtime.stop(); f.store.close(); }
});
