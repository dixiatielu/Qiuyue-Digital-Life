import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { deferred, event, fixture } from './helpers.js';
import { LifeRuntime } from '../src/runtime.js';
import { ActionNotDispatchedError } from '../src/snowluma.js';
import type { Store } from '../src/store.js';

/** A private message from person 7. */
const say = (store: Store, text: string) => store.receive({ key: crypto.randomUUID(), kind: 'message', at: Date.now(), text, actorId: 7, payload: { message_type: 'private', message: [{ type: 'text', data: { text } }] } })!;
/** A model call that is still deciding when it is cancelled. */
const deciding = (started: { resolve: () => void }, decision: string) => async (_context: unknown, options?: { signal?: AbortSignal }) => {
  started.resolve(); await new Promise(resolve => options?.signal?.addEventListener('abort', resolve));
  return answer(call('send_private_msg', { user_id: 7, message: decision }));
};

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
    f.faux.setResponses([answer(call('send_group_msg', { group_id: 100, message: 'Received' }))]);
    runtime.start(); await runtime.idle();
    assert.deepEqual(f.sent.map(item => item.kind), ['send_group_msg']);
    assert.equal(f.store.processedCount(), 1); assert.equal(f.store.pending(), 0);
    assert.equal(f.store.dailyCalls(), 202); assert.equal(f.store.hourlyActions(), 32);
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

test('life wakes show when available online activities were last done, other observations do not', async () => {
  const f = fixture();
  try {
    f.store.setSetting('lifeEnabled', true);
    const feeds = f.store.receive({ key: 'tool:feeds', kind: 'snowluma:get_qzone_feeds', at: Date.parse('2026-10-27T12:00:00Z'), text: '[]', payload: { result: [] } }, true)!;
    const signature = f.store.beginAction('signature', 'set_self_longnick', { longNick: 'Practicing a new song' }, []);
    f.store.finishAction(signature.action.id, 'success', {});
    const status = f.store.beginAction('status', 'set_diy_online_status', { face_id: 1, wording: 'Humming along' }, []);
    f.store.finishAction(status.action.id, 'success', {});
    const diary = f.store.writeMemory({ kind: 'note', title: 'Today', content: 'A quiet day', importance: 3, sources: [feeds.id] }, false);
    const prompts: string[] = [];
    const observed = (messages: unknown[]) => JSON.stringify(messages.findLast(message => JSON.stringify(message).includes('New environment observations')));
    f.faux.setResponses([context => { prompts.push(observed(context.messages)); return answer('Quiet'); }, context => { prompts.push(observed(context.messages)); return answer('Rest'); }]);
    event(f.store, 'Hello'); await f.brain.run(f.store.claim(10)!);
    f.store.schedule('Free time', 'life', Date.now()); f.store.enqueueDue(); await f.brain.run(f.store.claim(10)!);
    assert.ok(!prompts[0]!.includes('Online activities'));
    assert.ok(prompts[1]!.includes('Online activities'));
    assert.ok(prompts[1]!.includes('2026-10-27T12:00:00.000Z'));
    assert.ok(prompts[1]!.includes('Practicing a new song') && prompts[1]!.includes('Humming along'));
    assert.ok(prompts[1]!.includes(new Date(diary.createdAt).toISOString()));
    assert.ok(prompts[1]!.includes('Post to your Qzone') && !prompts[1]!.includes('Look things up or read online'));
  } finally { f.store.close(); }
});

test('a life wake sees the local weekday, how recent plans went, and something that comes to mind', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T13:30:00Z') }); // Thursday 21:30 in Asia/Shanghai
  const f = fixture();
  try {
    f.cfg.life.allowFiction = true; f.restart();
    f.store.setSetting('lifeEnabled', true);
    const source = event(f.store, 'Morning');
    const past = f.store.schedule('Practiced scales on the balcony', 'life', Date.parse('2026-10-29T04:00:00Z')); f.store.finishWake(past.id, 'done');
    const note = f.store.writeMemory({ kind: 'note', title: 'The day the steamer shop closed', content: 'Walked past and it was shut', importance: 4, sources: [source.id] }, false);
    f.store.db.prepare('UPDATE memories SET created_at=? WHERE id=?').run(Date.now() - 2 * 86_400_000, note.id);
    f.store.writeMemory({ kind: 'impression', title: 'Teases me about buns', content: 'Friendly, jokes a lot', importance: 5, sources: [source.id], scope: 'person:7' }, false);
    f.store.acknowledge(f.store.claim(10)!.batchId);
    let prompt = ''; let request = '';
    f.faux.setResponses([context => { request = JSON.stringify(context); prompt = JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations'))); return answer('Rest'); }]);
    f.store.schedule('Free time', 'life', Date.now()); f.store.enqueueDue(); await f.brain.run(f.store.claim(10)!);
    assert.ok(prompt.includes('2026-10-29 Thursday 21:30'));
    assert.ok(prompt.includes('Practiced scales on the balcony') && !prompt.includes('first life wake today'));
    assert.ok(prompt.includes('The day the steamer shop closed') && prompt.includes('Teases me about buns'));
    assert.ok(prompt.includes('fictional daily life brings what you did not plan') && prompt.includes("today's diary"));
    assert.ok(request.includes('Save fictional daily life with remember as fiction'));
  } finally { f.store.close(); }
});

test('the first life wake of a day sketches the day, which starts at 05:00 rather than midnight', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-29T01:00:00Z') }); // 09:00 in Asia/Shanghai
  const f = fixture();
  try {
    f.store.setSetting('lifeEnabled', true);
    // Drawing until 02:00 still belongs to the day before.
    const late = f.store.schedule('Stayed up drawing', 'life', Date.parse('2026-10-28T18:00:00Z')); f.store.finishWake(late.id, 'done');
    let prompt = ''; let request = '';
    f.faux.setResponses([context => { request = JSON.stringify(context); prompt = JSON.stringify(context.messages.findLast(message => JSON.stringify(message).includes('New environment observations'))); return answer('Rest'); }]);
    f.store.schedule('Free time', 'life', Date.now()); f.store.enqueueDue(); await f.brain.run(f.store.claim(10)!);
    assert.ok(prompt.includes('first life wake today') && prompt.includes('Stayed up drawing'));
    // Fictional daily life is off in this configuration, and it is morning.
    assert.ok(!prompt.includes('did not plan') && !prompt.includes("today's diary"));
    assert.ok(!request.includes('Save fictional daily life'));
  } finally { f.store.close(); }
});

test('pursuits carry across days and fresh contexts, stay fictional once fictional, and need life mode to advance', async () => {
  const f = fixture();
  try {
    f.cfg.life.allowFiction = true;
    event(f.store, 'Hello');
    f.faux.setResponses([answer(call('update_pursuit', { title: 'Learning a hard song', progress: 'Just started', fictional: true })), answer('Rest')]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.store.pursuits().length, 0);
    f.store.setSetting('lifeEnabled', true);
    event(f.store, 'Hello again');
    f.faux.setResponses([answer(call('update_pursuit', { title: 'Learning a hard song', progress: 'The chorus high note still cracks', fictional: true })), answer('Rest')]);
    await f.brain.run(f.store.claim(10)!);
    const [pursuit] = f.store.pursuits();
    assert.equal(pursuit?.fictional, true);
    f.store.bumpGeneration(); // A fresh working context must still be given the pursuit.
    event(f.store, 'How is the song going', 200);
    f.faux.setResponses([
      context => { assert.ok(JSON.stringify(context).includes('The chorus high note still cracks')); return answer(call('update_pursuit', { id: pursuit!.id, title: 'Learning a hard song', progress: 'Finally hit the high note', fictional: false })); },
      answer(call('finish_pursuit', { id: pursuit!.id, status: 'done' })), answer('Done'),
    ]);
    await f.brain.run(f.store.claim(10)!);
    assert.equal(f.store.pursuits().length, 0);
    const row = f.store.db.prepare('SELECT * FROM pursuits WHERE id=?').get(pursuit!.id)!;
    assert.equal(row.status, 'done'); assert.equal(row.progress, 'Finally hit the high note'); assert.equal(row.fictional, 1);
  } finally { f.store.close(); }
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

test('a batch of successful messages, reactions, or pokes ends the thought; another tool or a failure keeps it going', async () => {
  const f = fixture();
  try {
    event(f.store); f.faux.setResponses([answer([call('send_group_msg', { group_id: 100, message: 'Hi' }), call('group_poke', { group_id: 100, user_id: 7 })]), answer('Must not be called')]);
    await f.brain.run(f.store.claim(10)!); assert.equal(f.faux.state.callCount, 1);
    event(f.store); f.faux.setResponses([answer([call('send_group_msg', { group_id: 100, message: 'Noted' }), call('set_activity', { activity: 'Chatting' })]), answer('Rest')]);
    await f.brain.run(f.store.claim(10)!); assert.equal(f.faux.state.callCount, 3);
  } finally { f.store.close(); }
  const failing = fixture({ execute: async () => { throw new ActionNotDispatchedError('SnowLuma is not connected'); } });
  try {
    event(failing.store); failing.faux.setResponses([answer(call('send_group_msg', { group_id: 100, message: 'Hi' })), answer('Try later')]);
    await failing.brain.run(failing.store.claim(10)!); assert.equal(failing.faux.state.callCount, 2);
  } finally { failing.store.close(); }
});

test('a reply from the person being answered cancels the call deciding the reply, keeps finished turns, and starts the next thought', async () => {
  const f = fixture(); const runtime = new LifeRuntime(f.cfg, f.store, f.brain); const calling = deferred();
  try {
    say(f.store, 'What are you having for dinner?');
    f.faux.setResponses([
      answer(call('set_activity', { activity: 'Chatting about dinner' })),
      deciding(calling, 'Stale reply'),
      context => {
        const seen = JSON.stringify(context.messages);
        assert.match(seen, /Did you never eat xiaolongbao/); assert.match(seen, /Chatting about dinner/); assert.doesNotMatch(seen, /Stale reply/);
        return answer(call('send_private_msg', { user_id: 7, message: 'Fresh reply' }));
      },
    ]);
    runtime.start(); await calling.promise;
    say(f.store, 'Did you never eat xiaolongbao?'); await runtime.tick(); await runtime.idle();
    assert.equal(f.sent.length, 0); assert.equal(f.store.pending(), 1); assert.equal(f.store.processedCount(), 1);
    assert.equal((f.store.logs().find(log => log.kind === 'thought_preempted')?.data as { phase: string }).phase, 'calling');
    await runtime.tick(); await runtime.idle();
    assert.deepEqual(f.sent.map(item => item.args.message), ['Fresh reply']); assert.equal(f.store.processedCount(), 2);
    assert.ok(!f.store.logs().some(log => log.kind === 'thought_error'));
  } finally { await runtime.stop(); f.store.close(); }
});

test('in a group only a mention of or reply to the digital life cancels the call; other messages steer at the boundary', async () => {
  const f = fixture(); const groupMessage = (actorId: number, text: string, segments: unknown[]) => f.store.receive({ key: crypto.randomUUID(), kind: 'message', at: Date.now(), text, groupId: 100, actorId, payload: { message: segments } })!;
  try {
    const earlier = f.store.beginAction('earlier-send', 'send_group_msg', { group_id: 100, message: 'Tea is nice' }, []);
    f.store.finishAction(earlier.action.id, 'success', { message_id: -42 });
    for (const addressed of [[{ type: 'at', data: { qq: '900' } }, { type: 'text', data: { text: ' you?' } }], [{ type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: 'Which tea?' } }]]) {
      const calling = deferred();
      event(f.store, 'Anyone like tea?', 100); f.faux.setResponses([deciding(calling, 'unused')]);
      const work = f.brain.run(f.store.claim(10)!); await calling.promise;
      groupMessage(8, 'I prefer coffee', [{ type: 'text', data: { text: 'I prefer coffee' } }]);
      assert.equal(await f.brain.steer(f.store.claim(10)!), true);
      groupMessage(8, 'addressed', addressed);
      const preempting = f.store.claim(10)!;
      assert.equal(await f.brain.steer(preempting), false); f.store.releaseBatch(preempting.batchId);
      await work; f.store.releaseClaims();
      assert.equal(f.store.pending(), 2); f.store.acknowledge(f.store.claim(10)!.batchId);
    }
    assert.equal(f.sent.length, 0); assert.equal(f.store.logs().filter(log => log.kind === 'thought_preempted').length, 2);
  } finally { f.store.close(); }
});

test('a message that arrives while tools run skips sends to that chat not yet made, and the model decides again', async () => {
  const poked = deferred(); const release = deferred(); const sent: string[] = [];
  const f = fixture({ execute: async (kind, args) => { sent.push(String(args.message ?? kind)); if (kind === 'send_poke') { poked.resolve(); await release.promise; } return { message_id: -42 }; } });
  try {
    say(f.store, 'Guess what I had');
    f.faux.setResponses([
      answer([call('send_poke', { user_id: 7 }), call('send_private_msg', { user_id: 7, message: 'Stale guess' })]),
      context => { const seen = JSON.stringify(context.messages); assert.match(seen, /Not sent/); assert.match(seen, /It was hotpot/); return answer(call('send_private_msg', { user_id: 7, message: 'Hotpot, nice' })); },
    ]);
    const work = f.brain.run(f.store.claim(10)!); await poked.promise;
    say(f.store, 'It was hotpot'); assert.equal(await f.brain.steer(f.store.claim(10)!), true);
    release.resolve(); await work;
    assert.deepEqual(sent, ['send_poke', 'Hotpot, nice']);
    assert.equal((f.store.logs().find(log => log.kind === 'thought_preempted')?.data as { phase: string }).phase, 'acting');
  } finally { release.resolve(); f.store.close(); }
});

test('after maxPreemptions in a row the next decision is carried out as made', async () => {
  const f = fixture(); f.cfg.limits.maxPreemptions = 1; const cancelled = deferred(); const calling = deferred(); const release = deferred();
  try {
    say(f.store, 'One');
    f.faux.setResponses([deciding(cancelled, 'unused')]);
    const first = f.brain.run(f.store.claim(10)!); await cancelled.promise;
    say(f.store, 'Two'); const preempting = f.store.claim(10)!;
    assert.equal(await f.brain.steer(preempting), false); f.store.releaseBatch(preempting.batchId); await first;
    f.faux.setResponses([async () => { calling.resolve(); await release.promise; return answer(call('send_private_msg', { user_id: 7, message: 'As decided' })); }, answer('Quiet')]);
    const second = f.brain.run(f.store.claim(10)!); await calling.promise;
    say(f.store, 'Three'); assert.equal(await f.brain.steer(f.store.claim(10)!), true);
    release.resolve(); await second;
    assert.deepEqual(f.sent.map(item => item.args.message), ['As decided']);
    assert.equal(f.store.logs().filter(log => log.kind === 'thought_preempted').length, 1);
  } finally { release.resolve(); f.store.close(); }
});
