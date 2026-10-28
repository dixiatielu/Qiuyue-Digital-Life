import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentSystemPrompt, getCurrentTools, toToolDeclaration, type Message } from '@earendil-works/pi-ai';
import { fixture, event } from './helpers.js';
import { LifeRuntime } from '../src/runtime.js';
import { normalizeEvent } from '../src/snowluma.js';
import { textTokens, toModelMessages } from '../src/context.js';
import { digest } from '../src/store.js';
import type { ContextCheckpoint } from '../src/context.js';

function updates(messages: Message[]) {
  return messages.flatMap(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')
    ? [JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>')))] : []);
}

test('action summaries stay small with hundreds of provenance IDs, while full records remain readable', async () => {
  const f = fixture();
  try {
    const sources = Array.from({ length: 200 }, () => event(f.store).id);
    const actions = Array.from({ length: 10 }, (_, index) => {
      const { action } = f.store.beginAction(`a${index}`, 'send_group_msg', { group_id: 100, message: `Reply ${index}` }, sources);
      f.store.finishAction(action.id, index === 0 ? 'unknown' : 'success', { message_id: index });
      return action.id;
    });
    f.store.acknowledge(f.store.claim(300)!.batchId);
    event(f.store, 'Continue');
    f.faux.setResponses([
      context => {
        const snapshot = updates(context.messages).at(-1);
        assert.ok(textTokens(JSON.stringify(snapshot.actualActions)) < 1500);
        for (const action of snapshot.actualActions) {
          assert.equal(action.sources, undefined); assert.equal(action.fingerprint, undefined); assert.equal(action.key, undefined);
        }
        assert.ok(snapshot.actualActions.some((action: any) => action.status === 'unknown'));
        return answer(call('inspect_actions', {}));
      },
      context => {
        const result = context.messages.at(-1)!;
        assert.ok(textTokens(JSON.stringify(result.content)) < 2000);
        assert.doesNotMatch(JSON.stringify(result.content), /"sources"|"fingerprint"/);
        return answer('Continue');
      },
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.deepEqual(f.store.actionById(actions[0]!)?.sources, sources);
  } finally { f.store.close(); }
});

test('new observations and restart append only changed runtime fields and action records', async () => {
  const f = fixture(); let prefix: Message[] = [];
  try {
    const source = event(f.store, 'First message');
    const first = f.store.beginAction('first', 'send_group_msg', { group_id: 100, message: 'Received' }, [source.id]).action;
    f.store.finishAction(first.id, 'success', { message_id: 1 });
    f.store.setActivity('Continue researching lunar maria', [source.id]);
    f.faux.setResponses([context => { assert.equal(updates(context.messages).at(-1).format, 'snapshot'); return answer('Remember this topic'); }]);
    await f.brain.run(f.store.claim(20)!);
    prefix = structuredClone(toModelMessages(f.brain.agent.state.messages));
    f.restart();
    event(f.store, 'Second message');
    const second = f.store.beginAction('second', 'send_group_msg', { group_id: 100, message: 'Second reply' }, [source.id]).action;
    f.store.finishAction(second.id, 'unknown', { reason: 'Unconfirmed' });
    f.faux.setResponses([context => {
      assert.deepEqual(context.messages.slice(0, prefix.length), prefix);
      const delta = updates(context.messages).at(-1);
      assert.equal(delta.format, 'delta'); assert.equal(delta.settings, undefined);
      assert.equal(delta.snowlumaPermissions, undefined);
      assert.deepEqual(delta.actualActions.upsert.map((action: any) => action.id), [second.id]);
      assert.ok(textTokens(JSON.stringify(delta)) < 1000);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('unchanged runtime does not append another snapshot even in a new run', async () => {
  const f = fixture();
  try {
    f.cfg.memory.recentEvents = 0; f.cfg.memory.recallLimit = 0;
    event(f.store); f.faux.setResponses([answer('Continue')]); await f.brain.run(f.store.claim(20)!);
    event(f.store, 'New message');
    f.faux.setResponses([context => { assert.equal(updates(context.messages).length, 1); return answer('Continue'); }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('commitment updates include additions and removals without repeating unchanged state', async () => {
  const f = fixture();
  try {
    event(f.store, 'Return tomorrow'); let wakeId = '';
    f.faux.setResponses([
      () => answer(call('schedule_activity', { title: 'Return tomorrow', kind: 'commitment', at: new Date(Date.now() + 86400000).toISOString() })),
      context => {
        const delta = updates(context.messages).at(-1);
        assert.equal(delta.format, 'delta');
        const wake = delta.activeCommitmentsAndPlans.upsert[0];
        assert.equal(wake.title, 'Return tomorrow'); wakeId = wake.id;
        return answer(call('finish_activity', { id: wake.id, status: 'cancelled' }));
      },
      context => {
        const delta = updates(context.messages).at(-1);
        assert.deepEqual(delta.activeCommitmentsAndPlans.removedIds, [wakeId]);
        assert.deepEqual(delta.activeCommitmentsAndPlans.upsert, []);
        assert.equal(delta.settings, undefined);
        return answer('Done');
      },
    ]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('legacy checkpoints upgrade bulky snapshots without losing conversation or full provenance', async () => {
  const f = fixture();
  try {
    const source = event(f.store, 'Conversation before restart');
    const provenance = Array.from({ length: 200 }, () => `e:${crypto.randomUUID()}`);
    const action = f.store.beginAction('legacy', 'send_group_msg', { group_id: 100, message: 'Original reply' }, provenance).action;
    f.store.finishAction(action.id, 'unknown', { reason: 'Unknown' });
    f.faux.setResponses([answer(call('load_snowluma_tools', { names: ['get_group_member_info'] })), answer('Remember the lunar maria topic after restart')]);
    await f.brain.run(f.store.claim(20)!);
    const messages = structuredClone(f.brain.agent.state.messages);
    const legacyInstructions = getCurrentSystemPrompt(toModelMessages(messages)).split('\nruntime_data format=')[0]!;
    const initialTools = f.tools.current().map(toToolDeclaration);
    const identity = digest({ instructions: legacyInstructions, model: f.cfg.model, selfId: f.cfg.snowluma.selfId, tools: initialTools });
    const snapshot = updates(toModelMessages(messages))[0]; delete snapshot.format;
    snapshot.actualActions = f.store.actions(10);
    for (const message of messages) {
      if (message.role === 'system' && message.content) message.content = legacyInstructions;
      if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')) message.content = `<runtime_data>\n${JSON.stringify(snapshot)}\n</runtime_data>`;
    }
    messages.push({ role: 'user', content: `<runtime_data>\n${JSON.stringify(snapshot)}\n</runtime_data>`, timestamp: Date.now() });
    const checkpoint: ContextCheckpoint = { identity, generation: f.store.settings().generation, messages, sources: [source.id], anchor: { header: 'old', prefix: [], tokens: 999999 } };
    f.store.saveContext(checkpoint);
    f.restart(); event(f.store, 'Continue the previous topic');
    f.faux.setResponses([context => {
      assert.match(JSON.stringify(context.messages), /Remember the lunar maria topic after restart/);
      assert.ok(getCurrentTools(context.messages).some(tool => tool.name === 'get_group_member_info'));
      assert.doesNotMatch(JSON.stringify(updates(context.messages)), new RegExp(provenance[0]!));
      assert.equal(updates(context.messages).filter(update => update.format === 'snapshot').length, 1);
      assert.ok(!f.store.logs().some(log => log.kind === 'context_summary_completed'));
      return answer('Resume the previous topic');
    }]);
    await f.brain.run(f.store.claim(20)!);
    assert.deepEqual(f.store.actionById(action.id)?.sources, provenance);
  } finally { f.store.close(); }
});

test('heartbeats are persisted but never wake, steer, recall or trigger memory maintenance', async () => {
  const f = fixture(); f.cfg.memory.reflectionEveryEvents = 1;
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain);
  try {
    runtime.start();
    for (let index = 0; index < 5; index++) {
      const input = normalizeEvent({ self_id: 900, post_type: 'meta_event', meta_event_type: 'heartbeat', time: 100 + index, status: { online: true } }, f.cfg.snowluma)!;
      const saved = f.store.receive(input)!;
      assert.equal(saved.status, 'processed'); assert.equal(f.store.event(saved.id)?.payload.status != null, true);
      await runtime.tick(); await runtime.idle();
    }
    assert.equal(f.faux.state.callCount, 0); assert.equal(f.store.pending(), 0);
    assert.equal(f.store.processedCount(), 0); assert.equal(f.store.recent(30).length, 0);
    // Simulate a heartbeat queued by the previous version, then recover it.
    f.store.db.prepare("UPDATE events SET status='processing',batch_id='legacy'").run();
    f.store.recover(); assert.equal(f.store.pending(), 0);
    event(f.store, 'An actual new message');
    f.faux.setResponses([answer('Received')]);
    await runtime.tick(); await runtime.idle();
    assert.equal(f.faux.state.callCount, 1); assert.equal(f.store.processedCount(), 1);
  } finally { await runtime.stop(); f.store.close(); }
});
