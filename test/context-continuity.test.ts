import test from 'node:test';
import assert from 'node:assert/strict';
import { fauxAssistantMessage as answer, fauxToolCall as call, getCurrentSystemPrompt, getCurrentTools, toToolDeclaration, type Message } from '@earendil-works/pi-ai';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { estimatedContextTokens, textTokens, estimateTokens } from '../src/context.js';
import { deferred, event, fixture } from './helpers.js';

const snapshots = (messages: Message[]) => messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>'));
const isSummary = (messages: Message[]) => messages.at(-1)?.role === 'user' && typeof messages.at(-1)?.content === 'string' && (messages.at(-1)!.content as string).startsWith('Internal working context consolidation:');
function smallWindow(f: ReturnType<typeof fixture>) {
  // The faux provider's usage omits tool schemas. Keep this pressure fixture
  // small and test the complete catalog separately at the actual request seam.
  f.cfg.adapters[0]!.tools = { allow: ['send_group_msg', 'send_private_msg', 'set_group_reaction', 'group_poke', 'get_msg', 'get_group_member_info'], deny: [] };
  // This fixed-size pressure scenario exercises core exchanges, independently of optional gallery tools.
  f.cfg.plugins.gallery = false;
  f.restart();
  // Keep a fixed amount of conversation space above instructions and schemas.
  // Prompt edits must not turn the fixture's idle threshold into permanent pressure.
  f.cfg.limits.outputReserveTokens = 4096;
  const fixed = textTokens(f.brain.agent.state.systemPrompt) + estimateTokens(f.tools.current().map(toToolDeclaration));
  f.cfg.limits.contextTokens = f.cfg.limits.outputReserveTokens + f.cfg.limits.contextSafetyTokens + Math.ceil((fixed + 700) / 0.7);
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
      // The first message came in its own observation, so no delta repeats it as a recent event.
      assert.equal(snapshots(context.messages).length, 1);
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

test('a summary lost to a transport error fails the run and keeps the previous window without acknowledging new observations', async () => {
  const f = fixture();
  try {
    smallWindow(f);
    event(f.store, 'Previous observation');
    f.faux.setResponses([answer(longReply('Judgment not yet saved to long-term memory.'))]);
    await f.brain.run(f.store.claim(20)!);
    const source = event(f.store, 'New observation triggering consolidation');
    f.faux.setResponses([context => {
      assert.ok(isSummary(context.messages));
      return { ...answer('Partial summary'), stopReason: 'error', errorMessage: 'gateway timeout' };
    }]);
    await assert.rejects(f.brain.run(f.store.claim(20)!), /continuity summary was not generated completely: gateway timeout/);
    assert.equal(f.store.event(source.id)?.status, 'processing');
    assert.equal(f.store.processedCount(), 1);
    assert.equal(f.store.dailyCalls(), 2);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Partial summary/);
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
    f.faux.setResponses([answer(call("qq_main__load_snowluma_tools", { names: ['get_group_member_info'] })), answer(longReply('Judgment only in working history'))]);
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
      assert.ok(getCurrentTools(context.messages).some(tool => tool.name === "qq_main__get_group_member_info"));
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
    smallWindow(f); f.cfg.limits.contextTokens += 4000; event(f.store, 'Read a large result');
    f.faux.setResponses([answer(call("qq_main__get_msg", { message_id: 1 })), answer('Finished reading')]);
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

const compactedLog = (f: ReturnType<typeof fixture>) => f.store.logs(100).find(log => log.kind === 'context_compacted')?.data as Record<string, unknown> | undefined;
const references = (messages: unknown) => JSON.stringify(messages).match(/Original record IDs: ([^"\\]+)/)![1]!.split(', ');

test('a summary cut off at the limit keeps its complete lines', async () => {
  const f = fixture();
  try {
    smallWindow(f);
    event(f.store, 'Previous observation'); f.faux.setResponses([answer(longReply('Judgment before the cut.'))]);
    await f.brain.run(f.store.claim(20)!);
    const source = event(f.store, 'Consolidation needed');
    f.faux.setResponses([
      context => { assert.ok(isSummary(context.messages)); return { ...answer('Most important: the judgment before the cut.\nLess important: an unfinished li'), stopReason: 'length' }; },
      answer('Continued'),
    ]);
    await f.brain.run(f.store.claim(20)!);
    const state = JSON.stringify(f.brain.agent.state.messages);
    assert.match(state, /Most important: the judgment before the cut\./);
    assert.doesNotMatch(state, /unfinished li/);
    assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.equal(compactedLog(f)?.truncated, true);
    assert.equal(compactedLog(f)?.setAside, undefined);
  } finally { f.store.close(); }
});

test('a summary that cannot be completed sets older exchanges aside instead of failing the run', async () => {
  const f = fixture();
  try {
    smallWindow(f);
    event(f.store, 'Previous observation');
    f.faux.setResponses([answer(longReply('Judgment not yet saved to long-term memory.'))]);
    await f.brain.run(f.store.claim(20)!);
    const source = event(f.store, 'New observation triggering consolidation');
    f.faux.setResponses([
      context => { assert.ok(isSummary(context.messages)); return { ...answer('Incomplete summary'), stopReason: 'length' }; },
      context => {
        assert.ok(!isSummary(context.messages));
        assert.match(JSON.stringify(context.messages), /No summary was written for \d+ older messages from .+ to .+ \(The continuity summary was not generated completely: length\)/);
        return answer('Continue from the latest observation');
      },
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.equal(f.store.dailyCalls(), 3);
    const state = JSON.stringify(f.brain.agent.state.messages);
    assert.doesNotMatch(state, /Incomplete summary|Judgment not yet saved to long-term memory/);
    assert.match(String(compactedLog(f)?.setAside), /not generated completely: length/);
    // Set aside, not lost: the originals stay readable through the summary's references.
    assert.ok(references(f.brain.agent.state.messages).some(id => JSON.stringify(f.store.contextRecord(id)).includes('Judgment not yet saved to long-term memory')));
  } finally { f.store.close(); }
});

test('setting exchanges aside carries the previous summary forward', async () => {
  const f = fixture(); let summaries = 0;
  try {
    smallWindow(f);
    f.faux.setResponses(Array.from({ length: 40 }, () => context => {
      if (!isSummary(context.messages)) return answer(longReply('Ordinary judgment.'));
      return ++summaries === 1 ? answer('Handoff: keep the lunar topic going.') : { ...answer('Cut off'), stopReason: 'length' };
    }));
    for (let index = 0; index < 8 && summaries < 2; index++) {
      event(f.store, `Observation ${index}`);
      await f.brain.run(f.store.claim(20)!);
    }
    assert.equal(summaries, 2);
    const state = JSON.stringify(f.brain.agent.state.messages);
    assert.match(state, /Handoff: keep the lunar topic going\.\\n\[No summary was written/);
    assert.match(state, /the earlier summary carried forward above is ctx:[0-9a-f]{64} in full/);
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, 2);
  } finally { f.store.close(); }
});

test('a first request below the hard budget does not attempt foreground compaction', async () => {
  const f = fixture();
  try {
    smallWindow(f); f.cfg.compaction.idleRatio = 0.05;
    const source = event(f.store, 'Only observation');
    f.faux.setResponses([context => { assert.ok(!isSummary(context.messages)); return answer('Continue'); }]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.ok(!f.store.logs(100).some(log => log.kind === 'context_compaction_skipped'));
  } finally { f.store.close(); }
});

test('history too large for one summary request is set aside without a summary call', async () => {
  const f = fixture();
  try {
    smallWindow(f); f.cfg.limits.contextTokens = 64000;
    f.faux.setResponses(Array.from({ length: 4 }, () => answer(longReply('Judgment from a roomy window.'))));
    for (let index = 0; index < 4; index++) { event(f.store, `Observation ${index}`); await f.brain.run(f.store.claim(20)!); }
    f.cfg.limits.contextTokens = 15500;
    const source = event(f.store, 'Observation after the window shrank');
    f.faux.setResponses([context => { assert.ok(!isSummary(context.messages)); return answer('Continue'); }]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.ok(!f.store.logs(100).some(log => log.kind === 'context_summary_completed'));
    assert.match(String(compactedLog(f)?.setAside), /exceeds the context budget/);
  } finally { f.store.close(); }
});

test('idleRatio does not block the first or subsequent requests of a thought', async () => {
  const f = fixture();
  try {
    smallWindow(f); f.cfg.compaction.keepRecentTokens = 200;
    for (const text of ['Previous observation', 'Another observation']) {
      event(f.store, text); f.faux.setResponses([answer('Short previous judgment')]);
      await f.brain.run(f.store.claim(20)!);
    }
    // This soft threshold is deliberately below even the fixed prompt size.
    f.cfg.compaction.idleRatio = 0.05;
    event(f.store, 'Next observation');
    f.faux.setResponses([
      context => { assert.ok(!isSummary(context.messages)); return answer(call('set_activity', { activity: 'Chatting' })); },
      context => { assert.ok(!isSummary(context.messages)); return answer('Done'); },
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.store.settings().activity, 'Chatting');
    assert.ok(!f.store.logs(100).some(log => log.kind === 'model_request_started' && (log.data as any).purpose === 'compaction'));
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, 0);
  } finally { f.store.close(); }
});

async function idleFixture() {
  const f = fixture();
  smallWindow(f); f.cfg.compaction.keepRecentTokens = 200;
  event(f.store, 'Previous observation');
  f.faux.setResponses([answer('Judgment from the previous run. ' + 'old working fact '.repeat(300))]);
  await f.brain.run(f.store.claim(20)!);
  event(f.store, 'Second observation', 200);
  f.faux.setResponses([answer('Short reply')]);
  await f.brain.run(f.store.claim(20)!);
  // A run's first request compacts at the same ratio, so lower it only once the runs are done.
  f.cfg.compaction.idleRatio = 0.7;
  return f;
}

test('idle consolidation compacts between runs and persists, so the next run does not compact', async () => {
  const f = await idleFixture();
  try {
    const calls = f.faux.state.callCount;
    f.faux.setResponses([context => { assert.ok(isSummary(context.messages)); return answer('Idle handoff summary of the previous judgment'); }]);
    await f.brain.consolidate();
    assert.equal(f.faux.state.callCount, calls + 1);
    assert.doesNotMatch(JSON.stringify(f.brain.agent.state.messages), /Judgment from the previous run/);
    // Deltas kept after the summary need a complete base.
    assert.match(String(snapshots(f.brain.agent.state.messages as Message[]).at(-1)?.content), /"format":"snapshot"/);
    assert.ok(f.store.logs().some(log => log.kind === 'context_compacted'));
    await f.brain.consolidate(); assert.equal(f.faux.state.callCount, calls + 1);
    f.restart(); event(f.store, 'After restart');
    f.faux.setResponses([context => {
      assert.ok(!isSummary(context.messages));
      assert.match(JSON.stringify(context.messages), /Idle handoff summary of the previous judgment/);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.faux.state.callCount, calls + 2);
  } finally { f.store.close(); }
});

test('background compaction preserves replies and runtime updates made while its snapshot is summarized', async () => {
  const f = await idleFixture(); const entered = deferred(); const release = deferred();
  let background: Promise<void> | undefined;
  try {
    f.faux.setResponses([
      async context => { assert.ok(isSummary(context.messages)); entered.resolve(); await release.promise; return answer('Background handoff of the previous judgment'); },
      context => {
        assert.ok(!isSummary(context.messages));
        assert.match(JSON.stringify(context.messages), /Judgment from the previous run/);
        return answer(call('set_activity', { activity: 'New activity during compaction' }));
      },
      answer(call('qq_main__send_group_msg', { group_id: 100, message: 'Reply while summarizing' })),
    ]);
    background = f.brain.consolidate(); await entered.promise;
    const latest = event(f.store, 'Message arriving during compaction');
    await f.brain.run(f.store.claim(20)!);
    assert.equal(f.sent[0]?.args.message, 'Reply while summarizing');
    assert.equal(f.store.event(latest.id)?.status, 'processed');
    release.resolve(); await background;
    const state = JSON.stringify(f.brain.agent.state.messages);
    assert.match(state, /Background handoff/);
    assert.match(state, /Message arriving during compaction/);
    assert.match(state, /Reply while summarizing/);
    assert.match(String(snapshots(f.brain.agent.state.messages as Message[]).at(-1)?.content), /New activity during compaction/);
    assert.doesNotMatch(state, /Judgment from the previous run/);
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, 1);
    const started = f.store.logs(100).filter(log => log.kind === 'model_request_started');
    const finished = f.store.logs(100).filter(log => log.kind === 'model_request_finished');
    assert.equal(started.length, finished.length);
    assert.deepEqual(started.map(log => (log.data as any).callId).sort(), finished.map(log => (log.data as any).callId).sort());
    f.restart(); event(f.store, 'After background compaction and restart');
    f.faux.setResponses([context => {
      const text = JSON.stringify(context.messages);
      assert.match(text, /Background handoff/); assert.match(text, /Reply while summarizing/);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { release.resolve(); await background?.catch(() => {}); f.store.close(); }
});

test('administrative cancellation discards a background summary without rolling back newer replies', async () => {
  const f = await idleFixture(); const entered = deferred(); const release = deferred();
  try {
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return answer('Summary that must be discarded'); }, answer('Reply before cancellation')]);
    const work = f.brain.consolidate();
    const rejected = assert.rejects(work);
    await entered.promise;
    event(f.store, 'A new observation before cancellation'); await f.brain.run(f.store.claim(20)!);
    f.brain.abort(); release.resolve(); await rejected;
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Judgment from the previous run/);
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Reply before cancellation/);
    assert.ok(!f.store.logs().some(log => log.kind === 'context_compacted'));
    event(f.store, 'Arrived during consolidation');
    // Enough room remains to answer without starting the cancelled work again.
    f.faux.setResponses([context => {
      assert.ok(!isSummary(context.messages));
      assert.match(JSON.stringify(context.messages), /Judgment from the previous run/);
      assert.doesNotMatch(JSON.stringify(context.messages), /Summary that must be discarded/);
      return answer('Continue');
    }]);
    await f.brain.run(f.store.claim(20)!);
  } finally { release.resolve(); f.store.close(); }
});

test('a completed background summary waits for the active model call and keeps its tools paired', async () => {
  const f = await idleFixture(); const summarizing = deferred(); const finishSummary = deferred();
  const thinking = deferred(); const finishThought = deferred(); let background: Promise<void> | undefined; let run: Promise<void> | undefined;
  try {
    f.faux.setResponses([
      async () => { summarizing.resolve(); await finishSummary.promise; return answer('Handoff ready during a model call'); },
      async context => {
        thinking.resolve(); await finishThought.promise;
        assert.doesNotMatch(JSON.stringify(context.messages), /Handoff ready/);
        return answer(call('set_activity', { activity: 'Activity after the summary finished' }));
      },
      context => {
        const text = JSON.stringify(context.messages);
        assert.match(text, /Handoff ready/); assert.match(text, /Activity after the summary finished/);
        const tools = context.messages.filter(message => message.role === 'toolResult');
        assert.equal(tools.length, 1);
        assert.ok(context.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === tools[0]!.toolCallId)));
        return answer('Reply after safe replacement');
      },
    ]);
    background = f.brain.consolidate(); await summarizing.promise;
    event(f.store, 'Message before the summary finishes'); run = f.brain.run(f.store.claim(20)!); await thinking.promise;
    const active = JSON.stringify(f.brain.agent.state.messages);
    finishSummary.resolve(); await background;
    assert.equal(JSON.stringify(f.brain.agent.state.messages), active, 'the active transcript is not replaced mid-call');
    finishThought.resolve(); await run;
    assert.match(JSON.stringify(f.brain.agent.state.messages), /Reply after safe replacement/);
  } finally { finishSummary.resolve(); finishThought.resolve(); await Promise.allSettled([background, run]); f.store.close(); }
});

test('a hard-budget request waits for the existing background summary instead of starting another', async () => {
  const f = await idleFixture(); const entered = deferred(); const release = deferred();
  let background: Promise<void> | undefined; let run: Promise<void> | undefined; let replies = 0;
  try {
    f.faux.setResponses([
      async () => { entered.resolve(); await release.promise; return answer('One reusable summary'); },
      context => { assert.ok(!isSummary(context.messages)); replies++; assert.match(JSON.stringify(context.messages), /One reusable summary/); return answer('Reply after making room'); },
    ]);
    background = f.brain.consolidate(); await entered.promise;
    // Model budget changes are observed at the next request; the old prefix still matches.
    f.cfg.limits.contextTokens = estimatedContextTokens(f.brain.agent.state.messages) + f.cfg.limits.outputReserveTokens + f.cfg.limits.contextSafetyTokens - 200;
    const source = event(f.store, 'Message at the hard budget');
    run = f.brain.run(f.store.claim(20)!);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies, 0, 'thinking waits only after the hard budget is reached');
    release.resolve(); await background; await run;
    assert.equal(replies, 1); assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_summary_completed').length, 1);
  } finally { release.resolve(); await Promise.allSettled([background, run]); f.store.close(); }
});

test('a background summary failure leaves newer context and event acknowledgements intact', async () => {
  const f = await idleFixture(); const entered = deferred(); const release = deferred(); let rejected: Promise<void> | undefined;
  try {
    f.faux.setResponses([
      async () => { entered.resolve(); await release.promise; throw new Error('Summary endpoint unavailable'); },
      answer('New reply survives a summary failure'),
    ]);
    rejected = assert.rejects(f.brain.consolidate()); await entered.promise;
    const source = event(f.store, 'Message during a failing summary'); await f.brain.run(f.store.claim(20)!);
    const current = JSON.stringify(f.brain.agent.state.messages);
    release.resolve(); await rejected;
    assert.equal(JSON.stringify(f.brain.agent.state.messages), current);
    assert.equal(f.store.event(source.id)?.status, 'processed');
    assert.equal(f.store.logs(100).filter(log => log.kind === 'context_compacted').length, 0);
  } finally { release.resolve(); await rejected; f.store.close(); }
});

test('deleting a source while a background summary is running prevents its resurrection', async () => {
  const f = await idleFixture(); const entered = deferred(); const release = deferred(); let rejected: Promise<void> | undefined;
  try {
    const source = f.brain.agent.state.messages.find(message => message.role === 'observation')!;
    assert.equal(source.role, 'observation');
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return answer('Deleted material must never return'); }]);
    rejected = assert.rejects(f.brain.consolidate()); await entered.promise;
    f.store.forget(source.eventIds[0]!); release.resolve(); await rejected;
    event(f.store, 'After deletion');
    f.faux.setResponses([context => {
      assert.doesNotMatch(JSON.stringify(context.messages), /Deleted material must never return|Judgment from the previous run/);
      return answer('Start from valid state');
    }]);
    await f.brain.run(f.store.claim(20)!);
    assert.ok(!f.store.logs(100).some(log => log.kind === 'context_compacted'));
  } finally { release.resolve(); await rejected; f.store.close(); }
});
