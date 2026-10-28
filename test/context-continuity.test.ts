import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentSystemPrompt, getCurrentTools, type Message } from '@earendil-works/pi-ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { estimatedContextTokens } from '../src/context.js';
import { deferred, event, fixture } from './helpers.js';

const snapshots = (messages: Message[]) => messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>'));
const isSummary = (messages: Message[]) => messages.at(-1)?.role === 'user' && typeof messages.at(-1)?.content === 'string' && (messages.at(-1)!.content as string).startsWith('Internal working context consolidation:');
function smallWindow(f: ReturnType<typeof fixture>) {
  // The faux provider's usage omits tool schemas. Keep this pressure fixture
  // small and test the complete catalog separately at the actual request seam.
  f.cfg.snowluma.tools = { allow: ['send_group_msg', 'send_private_msg', 'set_group_reaction', 'group_poke', 'get_msg', 'get_group_member_info'], deny: [] };
  f.restart();
  f.cfg.limits.contextTokens = 12000;
  f.cfg.limits.outputReserveTokens = 4096;
  f.cfg.compaction.keepRecentTokens = 1500;
  f.cfg.compaction.summaryMaxTokens = 512;
  f.cfg.compaction.retries = 0;
}
const longReply = (label: string) => label + 'old working fact '.repeat(1000);


test('new runs preserve the exact preceding request prefix and assistant-only context', async () => {
  const f = fixture(); let prefix: Message[] = [];
  try {
    event(f.store, 'Talk about the Moon first');
    f.faux.setResponses([context => {
      prefix = structuredClone(context.messages);
      assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /<runtime_data>|\d{4}-\d{2}-\d{2}T/);
      return answer('Judgment only in the previous model reply: discuss lunar maria next.');
    }]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Continue the conversation', 200);
    f.faux.setResponses([context => {
      assert.deepEqual(context.messages.slice(0, prefix.length), prefix);
      assert.match(JSON.stringify(context.messages), /Judgment only in the previous model reply/);
      assert.equal(snapshots(context.messages).length, 2);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('tool turns append changed state without rewriting prior snapshots or repeating unchanged state', async () => {
  const f = fixture(); let prefix: Message[] = [];
  try {
    const source = event(f.store, 'Read first, then record the activity');
    f.faux.setResponses([
      context => { prefix = structuredClone(context.messages); return answer(call('read_event', { id: source.id })); },
      context => {
        assert.deepEqual(context.messages.slice(0, prefix.length), prefix);
        assert.equal(snapshots(context.messages).length, 1);
        return answer(call('set_activity', { activity: 'Researching lunar maria' }));
      },
      context => {
        assert.deepEqual(context.messages.slice(0, prefix.length), prefix);
        const states = snapshots(context.messages);
        assert.equal(states.length, 2);
        assert.match(JSON.stringify(states.at(-1)), /Researching lunar maria/);
        assert.equal(context.messages.at(-2)?.role, 'toolResult');
        return answer('Rest');
      },
    ]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('budget pressure produces a handoff summary and retains the latest observation and durable state', async () => {
  const f = fixture(); let summaries = 0; let calls = 0;
  try {
    smallWindow(f);
    const source = event(f.store, 'An earlier source');
    f.store.setActivity('Keep researching lunar maria', [source.id]);
    f.store.schedule('Watch the Moon together tomorrow', 'commitment', Date.now() + 86400000, [source.id]);
    f.faux.setResponses(Array.from({ length: 40 }, () => context => {
      calls++;
      if (isSummary(context.messages)) {
        summaries++;
        assert.match(JSON.stringify(context.messages), /Judgment found only in old exchanges/);
        return answer('Handoff: the judgment found only in old exchanges merits discussion; verify experiences by source ID.');
      }
      assert.ok(estimatedContextTokens(context.messages) < f.cfg.limits.contextTokens);
      assert.match(JSON.stringify(snapshots(context.messages).at(-1)), /Keep researching lunar maria/);
      assert.match(JSON.stringify(snapshots(context.messages).at(-1)), /Watch the Moon together tomorrow/);
      return answer(longReply('Judgment found only in old exchanges.'));
    }));
    for (let index = 0; index < 8; index++) {
      const latest = event(f.store, `Latest observation ${index}`);
      await f.brain.run(f.store.claim(20)!);
      assert.match(JSON.stringify(f.brain.agent.state.messages), new RegExp(latest.id));
    }
    assert.ok(summaries > 0);
    assert.equal(f.store.dailyCalls(), calls);
    assert.equal(calls, 8 + summaries);
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, summaries);
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Handoff:/);
    assert.equal(f.store.event(source.id)?.status, 'processed');
  } finally { f.store.close(); }
});

test('forgetting between runs clears old exchanges and handoff summaries', async () => {
  const f = fixture();
  try {
    const source = event(f.store, 'Original text to forget later');
    f.faux.setResponses([answer('Related judgment only in model exchanges')]);
    await f.brain.run(f.store.claim(20)!);
    f.store.forget(source.id);
    event(f.store, 'An unrelated new topic');
    f.faux.setResponses([context => {
      assert.doesNotMatch(JSON.stringify(context.messages), /Original text to forget later|Related judgment only in model exchanges/);
      assert.equal(snapshots(context.messages).length, 1);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('deletion during summarization invalidates its result before any further model call', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  try {
    smallWindow(f);
    const source = event(f.store, 'Source in the summary pending deletion');
    f.faux.setResponses([answer(longReply('Judgment that must be forgotten with its source.'))]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Trigger consolidation');
    let furtherCalls = 0;
    f.faux.setResponses([
      async context => {
        assert.ok(isSummary(context.messages)); entered.resolve(); await release.promise;
        return answer('Old summary that must not be retained');
      },
      () => { furtherCalls++; return answer('Must not be called'); },
    ]);
    const work = f.brain.run(f.store.claim(20)!);
    const rejected = assert.rejects(work, /state changed/);
    await entered.promise; f.store.forget(source.id); release.resolve(); await rejected;
    assert.equal(furtherCalls, 0);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Old summary that must not be retained|Judgment that must be forgotten with its source/);
    f.store.releaseClaims();
    f.faux.setResponses([answer('Recover from the current state')]);
    await f.brain.run(f.store.claim(20)!);
  } finally { release.resolve(); f.store.close(); }
});

test('an incomplete summary preserves the previous window without acknowledging new observations', async () => {
  const f = fixture();
  try {
    smallWindow(f);
    event(f.store, 'Previous observation');
    f.faux.setResponses([answer(longReply('Judgment not yet saved to long-term memory.'))]);
    await f.brain.run(f.store.claim(20)!);
    const source = event(f.store, 'New observation triggering consolidation');
    f.faux.setResponses([context => {
      assert.ok(isSummary(context.messages));
      return { ...answer('Incomplete summary'), stopReason: 'length' };
    }]);
    await assert.rejects(f.brain.run(f.store.claim(20)!), /continuity summary was not generated completely/);
    assert.equal(f.store.event(source.id)?.status, 'processing');
    assert.equal(f.store.processedCount(), 1);
    assert.equal(f.store.dailyCalls(), 2);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Incomplete summary/);
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Judgment not yet saved to long-term memory/);
    f.store.releaseClaims();
    f.faux.setResponses([answer('Complete replacement summary preserving the earlier judgment'), answer('Read again')]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); }
});

test('observations arriving during summarization are steered into the same run and acknowledged after consumption', async () => {
  const f = fixture(); const entered = deferred(); const release = deferred();
  try {
    smallWindow(f);
    event(f.store, 'Previous observation');
    f.faux.setResponses([answer(longReply('Previous working record.'))]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Start the next run');
    f.faux.setResponses([
      async context => {
        assert.ok(isSummary(context.messages)); entered.resolve(); await release.promise;
        return answer('Handoff summary of the previous working record');
      },
      answer('Ready to continue'),
      context => {
        assert.match(JSON.stringify(context.messages), /New observation arriving during summarization/);
        return answer('Considered together');
      },
    ]);
    const work = f.brain.run(f.store.claim(20)!);
    await entered.promise;
    const latest = event(f.store, 'New observation arriving during summarization', 200);
    assert.equal(await f.brain.steer(f.store.claim(20)!), true);
    assert.equal(f.store.event(latest.id)?.status, 'processing');
    release.resolve(); await work;
    assert.equal(f.store.event(latest.id)?.status, 'processed');
    assert.equal(f.store.processedCount(), 3);
  } finally { release.resolve(); f.store.close(); }
});

test('summary requests reuse the original system, tools and verbatim history prefix with bounded output', async () => {
  const f = fixture(); let prefix: Message[] = [];
  try {
    smallWindow(f); event(f.store, 'Previous observation');
    f.faux.setResponses([ (context, options) => {
      prefix = structuredClone(context.messages);
      assert.equal(options?.maxTokens, f.cfg.limits.outputReserveTokens);
      return answer(longReply('Previous judgment'));
    } ]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Continue');
    f.faux.setResponses([
      (context, options) => {
        assert.ok(isSummary(context.messages));
        assert.equal(getCurrentSystemPrompt(context.messages), getCurrentSystemPrompt(prefix));
        assert.deepEqual(getCurrentTools(context.messages), getCurrentTools(prefix));
        assert.deepEqual(context.messages.slice(1, prefix.length), prefix.slice(1));
        assert.ok(options!.maxTokens! < f.cfg.compaction.summaryMaxTokens);
        return answer('The earlier judgment is still verifiable; continue the current topic.');
      }, answer('Continue'),
    ]);
    await f.brain.run(f.store.claim(20)!);
    const summary = JSON.stringify(f.brain.agent.state.messages);
    assert.match(summary, /Original record IDs: ctx:/);
  } finally { f.store.close(); }
});

test('SQLite checkpoints restore the compacted window, source records and tools after reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-context-')); const path = join(dir, 'life.sqlite');
  let f = fixture(undefined, new Store(path));
  try {
    smallWindow(f); event(f.store, 'Observation before restart');
    f.faux.setResponses([answer(call('load_snowluma_tools', { names: ['get_group_member_info'] })), answer(longReply('Judgment only in working history'))]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Trigger compaction');
    f.faux.setResponses([answer('Handoff summary that must survive restart.'), answer('Run completed')]);
    await f.brain.run(f.store.claim(20)!);
    const recordId = JSON.stringify(f.brain.agent.state.messages).match(/ctx:[0-9a-f]{64}/)![0];
    assert.ok(f.store.contextRecord(recordId));
    f.store.close(); f = fixture(undefined, new Store(path)); smallWindow(f); f.store.recover();
    event(f.store, 'Observation after restart');
    f.faux.setResponses([context => {
      assert.match(JSON.stringify(context.messages), /Handoff summary that must survive restart/);
      assert.ok(getCurrentTools(context.messages).some(tool => tool.name === 'get_group_member_info'));
      return answer(call('read_context', { id: recordId }));
    }, context => {
      assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolName === 'read_context' && !message.isError));
      return answer('Recovery completed');
    }]);
    await f.brain.run(f.store.claim(20)!);
    const source = f.store.recent(10).find(item => item.text === 'Observation before restart')!;
    f.store.forget(source.id); assert.equal(f.store.contextRecord(recordId), undefined);
    f.restart(); event(f.store, 'Recover after forgetting');
    f.faux.setResponses([context => {
      assert.doesNotMatch(JSON.stringify(context.messages), /Handoff summary that must survive restart|Judgment only in working history/);
      return answer('Forgotten');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('checkpoint write failure keeps the prior window and observation acknowledgement atomic', async () => {
  const f = fixture();
  try {
    event(f.store, 'Acknowledged observation'); f.faux.setResponses([answer('Previous complete window')]);
    await f.brain.run(f.store.claim(20)!);
    const previous = f.store.db.prepare('SELECT data FROM working_context').get()!.data;
    f.store.db.exec("CREATE TRIGGER reject_checkpoint BEFORE INSERT ON working_context BEGIN SELECT RAISE(ABORT,'checkpoint write failure'); END;");
    const next = event(f.store, 'Unacknowledged observation'); f.faux.setResponses([answer('Window that must not be committed')]);
    await assert.rejects(f.brain.run(f.store.claim(20)!), /checkpoint write failure/);
    assert.equal(f.store.processedCount(), 1); assert.equal(f.store.event(next.id)?.status, 'processing');
    assert.equal(f.store.db.prepare('SELECT data FROM working_context').get()!.data, previous);
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Previous complete window/);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Window that must not be committed/);
    f.store.db.exec('DROP TRIGGER reject_checkpoint'); f.store.releaseClaims();
    f.faux.setResponses([answer('Committed after reprocessing')]); await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.processedCount(), 2);
  } finally { f.store.close(); }
});

test('pressure can be resolved by pruning old tool output without a summary call', async () => {
  const f = fixture({ execute: async () => ({ content: 'raw original '.repeat(1000) }) });
  try {
    smallWindow(f); f.cfg.limits.contextTokens = 15000; event(f.store, 'Read a large result');
    f.faux.setResponses([answer(call('get_msg', { message_id: 1 })), answer('Finished reading')]);
    await f.brain.run(f.store.claim(20)!);
    const originalResult = f.brain.agent.state.messages.find(message => message.role === 'toolResult')!;
    const originalId = (await import('../src/context.js')).contextRecordId(originalResult);
    // Set pressure explicitly; smaller runtime deltas no longer fill the old fixed window in two runs.
    const latest = f.brain.agent.state.messages.findLast(message => message.role === 'assistant')!;
    assert.equal(latest.role, 'assistant');
    const usage = latest.usage;
    f.cfg.limits.contextTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output + f.cfg.limits.outputReserveTokens + f.cfg.limits.contextSafetyTokens + 100;
    for (let index = 0; index < 2; index++) {
      event(f.store, `New observation ${index}`); f.faux.setResponses([context => {
        assert.ok(!isSummary(context.messages)); return answer('Continue');
      }]);
      await f.brain.run(f.store.claim(20)!);
    }
    assert.ok(f.store.logs(100).some(log => log.kind === 'context_pruned'));
    assert.ok(!f.store.logs(100).some(log => log.kind === 'context_summary_completed'));
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Old tool result pruned/);
    assert.match(JSON.stringify(f.store.contextRecord(originalId)), /raw original raw original/);
    assert.equal(f.store.dailyCalls(), 4);
  } finally { f.store.close(); }
});

test('summary retries are bounded and charged, and only the valid replacement is committed', async () => {
  const f = fixture();
  try {
    smallWindow(f); f.cfg.compaction.retries = 1;
    event(f.store, 'Previous observation'); f.faux.setResponses([answer(longReply('Preserve the original judgment'))]);
    await f.brain.run(f.store.claim(20)!);
    event(f.store, 'Consolidation needed');
    f.faux.setResponses([
      { ...answer('Incomplete candidate summary'), stopReason: 'length' },
      answer('Complete candidate summary; preserve sources and continue.'), answer('Completed'),
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_summary_completed').length, 2);
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, 1);
    assert.equal(f.store.dailyCalls(), 4);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Incomplete candidate summary/);
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Complete candidate summary/);
  } finally { f.store.close(); }
});
