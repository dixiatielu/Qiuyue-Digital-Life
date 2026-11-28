import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import { isContextOverflow, isRecoverableLength, normalizeContext, type AssistantMessage, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { CredentialReader } from './credentials.js';
import { errorText } from './domain.js';
import type { Store } from './store.js';
import { ensureCurrent, type ThoughtContext } from './tools.js';
import {
  compactionSplit,
  contextRecordId,
  estimatedContextTokens,
  fitLines,
  foldImages,
  foldNoopCalls,
  foldReplies,
  foldToolResults,
  portableMessages,
  pruneToolResults,
  summaryEnvelope,
  SUMMARY_PREFIX,
  textTokens,
  TokenMeter,
  toModelMessages,
  type TokenMeasurement,
} from './context.js';
import { runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';
import { recordTime } from './record.js';
import { waitFor } from './async.js';
import { initialThinkingLevel, modelBudget, modelRoute, modelUse, requiresThoughtSignatures, shouldMergeConsecutiveUsers, type ModelOwner } from './model-config.js';
import { runtimeMessage } from './brain-observation.js';

export interface ModelRequest {
  callId: string;
  runId: string;
  owner: ModelOwner;
  purpose: 'thought' | 'review' | 'compaction';
  provider: string;
  model: string;
  api: string;
  startedAt: number;
  attempt?: number;
}

interface BackgroundCompaction {
  identity: string;
  thought: ThoughtContext;
  runId: string;
  controller: AbortController;
  meter: TokenMeter;
  original: AgentMessage[];
  prefix: string[];
  promise: Promise<void>;
  summary?: Message;
  record?: Record<string, unknown>;
}

/** The summarized text of a continuity summary, without its framing line and record references. */
export function summaryBody(message: AgentMessage): string | undefined {
  if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(SUMMARY_PREFIX)) return;
  const body = message.content.slice(message.content.indexOf('\n') + 1);
  const end = body.lastIndexOf('\nOriginal record IDs: ');
  return end < 0 ? body : body.slice(0, end);
}

/** Without a summary, older messages leave under a note; their originals stay archived and their events recallable. */
export function setAsideSummary(removed: AgentMessage[], ids: string[], limit: number, reason: string): string {
  const index = removed.findIndex(message => summaryBody(message) !== undefined);
  const times = removed.map(message => message.timestamp);
  const span = times.length ? ` from ${recordTime(Math.min(...times))} to ${recordTime(Math.max(...times))}` : '';
  const note = `[No summary was written for ${removed.length} older messages${span} (${reason}). Use recall, read_event, or read_chat_record for that period, or read_context for the originals${index >= 0 ? `; the earlier summary carried forward above is ${ids[index]} in full` : ''}.]`;
  const previous = index >= 0 ? fitLines(summaryBody(removed[index]!)!, limit - textTokens(note) - 1) : '';
  return previous ? `${previous}\n${note}` : note;
}

/**
 * Fold chat records, viewed images, calls that did nothing, and replies out of a completed thought (ADR-0024).
 * `lookupCalls` are the lookups of a thought that did nothing else and then ended: they leave with their results.
 */
export function foldThoughtMessages(
  messages: AgentMessage[],
  options: { everything: boolean; noopCalls: ReadonlySet<string>; lookupCalls?: ReadonlySet<string>; imageViewer: (label: string) => string | undefined },
): { messages: AgentMessage[]; counts: { results: number; images: number; replies: number; noops?: number; lookups?: number; media?: number }; changed: boolean } {
  let results = 0; let images = 0; let replies = 0; let noops = 0; let lookups = 0; let media = 0;
  let folded = messages;
  if (options.everything) {
    const records = foldToolResults(folded, 'read_chat_record'); folded = records.messages; results += records.changed;
    const seen = foldImages(folded, options.imageViewer); folded = seen.messages; images += seen.changed; media += seen.media;
  }
  const dropped = foldNoopCalls(folded, options.noopCalls); folded = dropped.messages; noops += dropped.changed;
  if (options.lookupCalls?.size) { const looked = foldNoopCalls(folded, options.lookupCalls); folded = looked.messages; lookups += looked.changed; }
  const said = foldReplies(folded); replies += said.changed;
  return {
    messages: said.messages,
    counts: { results, images, replies, ...(noops ? { noops } : {}), ...(lookups ? { lookups } : {}), ...(media ? { media } : {}) },
    changed: Boolean(results || images || replies || noops || lookups || media),
  };
}

export interface CompactionHost {
  readonly config: Config;
  readonly store: Store;
  readonly owner: ModelOwner;
  readonly credential: CredentialReader;
  readonly meter: TokenMeter;
  readonly stream: StreamFn;
  readonly summaryBackend?: { model: Model<any>; stream: StreamFn };
  getIdentity(): string;
  getSessionId(): string;
  getThought(): ThoughtContext;
  getRunId(): string;
  getCompactions(): Record<string, unknown>[];
  setRuntimeSnapshot(snapshot: RuntimeSnapshot): void;
  startRequest(model: Model<any>, purpose: 'compaction', attempt: number): ModelRequest;
  finishRequest(response?: AssistantMessage, aborted?: boolean): void;
  recordRequestFinished(request: ModelRequest, response?: AssistantMessage, aborted?: boolean): void;
  notifyCompacting(): void;
  runtimeContext(thinking?: boolean): RuntimeSnapshot;
}

/** Working-context shrinking, continuity summarization, background idle consolidation, and overflow recovery. */
export class ContextCompactor {
  private background?: BackgroundCompaction;
  constructor(private readonly host: CompactionHost) {}

  get hasReadySummary(): boolean { return Boolean(this.background?.summary); }

  cancelBackground() {
    this.background?.controller.abort();
    this.background = undefined;
  }

  private matchesBackground(job: BackgroundCompaction, messages: AgentMessage[]): boolean {
    return !job.controller.signal.aborted
      && job.identity === this.host.getIdentity()
      && job.thought.generation === this.host.store.settings().generation
      && job.prefix.length > 0
      && job.prefix.every((id, index) => messages[index] && contextRecordId(messages[index]!) === id);
  }

  /** Replace only the snapshotted prefix. The current tail may have grown or had images folded since then. */
  applyBackground(messages: AgentMessage[], runtime: RuntimeSnapshot, records = this.host.getCompactions()): AgentMessage[] {
    const job = this.background;
    if (!job?.summary) return messages;
    this.background = undefined;
    if (!this.matchesBackground(job, messages)) return messages;
    ensureCurrent(this.host.store, job.thought, job.controller.signal);
    // Retained deltas may have lost their base. End with today's complete state, never the job's old snapshot.
    const next = [messages[0]!, job.summary, ...messages.slice(job.prefix.length), runtimeMessage(runtimeUpdate(runtime)!)];
    const beforeTokens = estimatedContextTokens(messages); const afterTokens = estimatedContextTokens(next);
    if (afterTokens >= beforeTokens) return messages;
    this.host.meter.reset();
    this.host.setRuntimeSnapshot(runtime);
    records.push({ ...job.record, beforeTokens, afterTokens, background: true });
    return next;
  }

  /** Bring the context under limit: prune old tool results first, and summarize older exchanges only if that is not enough. */
  async shrink(messages: AgentMessage[], limit: number, budget: number, model: Model<any>, runtime: RuntimeSnapshot, signal?: AbortSignal): Promise<{ messages: AgentMessage[]; measured: TokenMeasurement }> {
    const route = modelRoute(model);
    const background = this.background;
    if (background) {
      if (!this.matchesBackground(background, messages)) this.cancelBackground();
      else {
        // Only a full context waits. Ordinary messages keep using the uncompressed history.
        if (!background.summary && this.host.meter.measure(messages, route).tokens > budget) {
          try { await (signal ? waitFor(background.promise, signal) : background.promise); }
          catch { ensureCurrent(this.host.store, this.host.getThought(), signal); }
        }
        ensureCurrent(this.host.store, this.host.getThought(), signal);
        messages = this.applyBackground(messages, runtime);
      }
    }
    let measured = this.host.meter.measure(messages, route);
    const before = measured.tokens;
    if (measured.tokens <= limit) return { messages, measured };
    this.host.store.archiveContext(messages, [...this.host.getThought().sources]);
    const pruned = pruneToolResults(messages, Math.min(this.host.config.compaction.keepRecentTokens, budget));
    messages = pruned.messages;
    measured = this.host.meter.measure(messages, route);
    if (pruned.changed) this.host.store.log('context_pruned', { runId: this.host.getRunId(), results: pruned.changed, beforeTokens: before, afterTokens: measured.tokens });
    if (measured.tokens > limit) {
      // A delta may depend on a base that compaction removes. Keep a complete current state for the compacted result.
      const snapshot = runtimeMessage(runtimeUpdate(runtime)!);
      const latest = messages.at(-1);
      const candidate = latest?.role === 'user' && latest.content === snapshot.content ? messages : [...messages, snapshot];
      try {
        messages = await this.compact(candidate, budget, model, signal);
        this.host.setRuntimeSnapshot(runtime);
      } catch (error) {
        // Below the full budget, compaction only makes room ahead of time; the request can go on without it.
        if (measured.tokens > budget || signal?.aborted) throw error;
        ensureCurrent(this.host.store, this.host.getThought(), signal);
        this.host.store.log('context_compaction_skipped', { runId: this.host.getRunId(), message: errorText(error) });
      }
      measured = this.host.meter.measure(messages, route);
    }
    return { messages, measured };
  }

  async compact(messages: AgentMessage[], budget: number, ownerModel: Model<any>, signal?: AbortSignal, background?: BackgroundCompaction, keepRecentTokens?: number): Promise<AgentMessage[]> {
    const thought = background?.thought ?? this.host.getThought();
    const meter = background?.meter ?? this.host.meter;
    const runId = background?.runId ?? this.host.getRunId();
    const { config, store, owner } = this.host;
    const use = modelUse(config, owner);
    const { model, stream } = this.host.summaryBackend ?? { model: ownerModel, stream: this.host.stream };
    const { window } = modelBudget(model, use.compactionContextTokens, config.compaction.summaryMaxTokens, config.limits.contextSafetyTokens);
    const summaryLimit = config.compaction.summaryMaxTokens;
    const { system, pinned, removed, kept } = compactionSplit(messages, Math.min(keepRecentTokens ?? config.compaction.keepRecentTokens, budget), budget, summaryLimit + 100, owner === 'review');
    if (!removed.length) throw new Error('No older exchanges can be safely compacted; reduce the latest input or increase the context budget.');
    const ids = store.archiveContext(removed, [...thought.sources]);
    if (background) background.prefix = background.original.slice(0, 1 + removed.length).map(contextRecordId);
    const { framing, references, reserve } = summaryEnvelope(ids);
    const outputLimit = summaryLimit - reserve;
    if (outputLimit < 64) throw new Error('The summary token limit is too small to retain the required source references.');
    const target = Math.floor(outputLimit * 0.6);
    const instructions = `Internal working context consolidation: Produce a brief continuity summary for the same digital life, aiming for about ${target} tokens (Chinese runs about one token per character); output stops at ${outputLimit}. Summarize only the first ${removed.length} older messages after the system message${pinned.length ? ' and the retained review prompt' : ''}. An existing summary among them is material to condense, not a prefix to keep: the limit covers it too, so merge it in and shorten it, dropping what is settled, superseded, or already saved with remember. Put the most important first; if output stops early, only the end is lost. If recent exchanges follow, use them only to correct outdated judgments; their originals are retained separately. Do not call tools or take external action. Preserve people, times, group or private settings, changes in relationship impressions and their evidence, current topics, unfinished matters, and actual action outcomes. Distinguish reported claims, inferences, fiction, success, failure, and unknown outcomes. Old state may be outdated; follow later runtime_data. Update outdated judgments in existing summaries. Use read_context to retrieve originals when needed; older records include ${ids.slice(-12).join(', ')}. Retain relevant source IDs and necessary ctx: record IDs in the summary.`;
    const directive: Message = { role: 'user', content: instructions, timestamp: Date.now() };
    // Reuse the complete warm prefix when it fits; the old prefix remains a fallback for oversized new input.
    let request: AgentMessage[] = [system, ...pinned, ...removed, ...kept, directive];
    const fits = (candidate: AgentMessage[]) => meter.measure(candidate, modelRoute(model)).tokens + summaryLimit + config.limits.contextSafetyTokens <= window;
    const includedRecentContext = fits(request);
    if (!includedRecentContext) request = [system, ...pinned, ...removed, directive];
    const sized = includedRecentContext || fits(request);
    const requestTokens = sized ? meter.measure(request, modelRoute(model)).tokens : 0;
    const availableOutput = Math.max(outputLimit, window - requestTokens - config.limits.contextSafetyTokens);
    const requestMaxTokens = Math.min(
      model.maxTokens,
      model.reasoning ? Math.max(outputLimit, Math.min(Math.max(use.limits.outputReserveTokens, outputLimit * 2), availableOutput)) : outputLimit,
    );
    const sameRoute = modelRoute(model) === modelRoute(ownerModel);
    const compactionMergeUsers = shouldMergeConsecutiveUsers(use.compaction, model);
    const effectiveCompactionLevel = initialThinkingLevel(model, use.compactionThinkingLevel);
    const replacement = (text: string) => {
      const summary: Message = { role: 'user', content: framing + text + references, timestamp: Date.now() };
      const compacted = [system, ...pinned, summary, ...kept];
      const before = estimatedContextTokens(messages); const after = estimatedContextTokens(compacted);
      return after < before && after <= budget ? { summary, compacted, before, after } : undefined;
    };
    let result: ReturnType<typeof replacement>; let truncated = false; let transient = false;
    let failure = 'The history to consolidate exceeds the context budget; a continuity summary cannot be generated safely.';
    for (let attempt = 0; sized && !result && attempt <= config.compaction.retries; attempt++) {
      ensureCurrent(store, thought, signal);
      let requestInfo: ModelRequest;
      if (background) {
        if (config.limits.maxTurnsPerRun !== null && attempt >= config.limits.maxTurnsPerRun) throw new Error('The compaction call limit has been reached.');
        requestInfo = { callId: store.chargeCall(runId, config.limits.modelCallsPerDay), runId, owner, purpose: 'compaction', provider: model.provider, model: model.id, api: model.api, startedAt: Date.now(), attempt };
        store.log('model_request_started', requestInfo);
      } else {
        requestInfo = this.host.startRequest(model, 'compaction', attempt);
        this.host.notifyCompacting();
      }
      const finish = (response?: AssistantMessage) => background ? this.host.recordRequestFinished(requestInfo, response, signal?.aborted) : this.host.finishRequest(response, signal?.aborted);
      let response: AssistantMessage;
      try {
        const portable = sameRoute
          ? request
          : portableMessages(request, { flattenToolCalls: requiresThoughtSignatures(model) });
        // Force toolChoice="none" on independent summary models or retries to prevent stray tool calls
        // without busting the same-route prompt cache on the first attempt.
        const toolChoice = !sameRoute || attempt > 0 ? 'none' as const : undefined;
        const responseWork = (async () => (await stream(model, normalizeContext({ messages: toModelMessages(portable, { mergeUsers: compactionMergeUsers }) }), {
          apiKey: this.host.credential(use.compaction.apiKeyEnv),
          reasoning: effectiveCompactionLevel === 'off' ? undefined : effectiveCompactionLevel,
          sessionId: sameRoute ? this.host.getSessionId() : undefined,
          cacheRetention: use.compaction.cacheRetention ?? 'short',
          ...(toolChoice ? { toolChoice } : {}),
          signal,
          maxTokens: requestMaxTokens,
        })).result())();
        response = await (background && signal ? waitFor(responseWork, signal) : responseWork);
        finish(response);
      } catch (error) { finish(); throw error; }
      ensureCurrent(store, thought, signal);
      store.log('context_summary_completed', { runId, callId: requestInfo.callId, owner, attempt, usage: response.usage, stopReason: response.stopReason });
      transient = response.stopReason === 'error' || response.stopReason === 'aborted';
      const written = transient || response.content.some(item => item.type === 'toolCall') ? '' : response.content.filter((item): item is TextContent => item.type === 'text').map(item => item.text).join('\n').trim();
      const text = fitLines(written, outputLimit, response.stopReason === 'stop');
      result = text ? replacement(text) : undefined;
      truncated = text !== written;
      failure = result ? '' : text ? 'The continuity summary did not reduce the context or still exceeds the budget.' : `The continuity summary was not generated completely: ${response.errorMessage ?? response.stopReason}`;
    }
    if (!result && !transient) { result = replacement(setAsideSummary(removed, ids, outputLimit, failure)); truncated = false; }
    if (!result) throw new Error(failure);
    ensureCurrent(store, thought, signal);
    const record = { runId, owner, provider: model.provider, model: model.id, beforeTokens: result.before, afterTokens: result.after, removedMessages: removed.length, includedRecentContext, ...(truncated ? { truncated } : {}), ...(failure ? { setAside: failure } : {}), firstKeptRecordId: kept[0] ? contextRecordId(kept[0]) : undefined, summaryRecordId: contextRecordId(result.summary) };
    if (background) { background.summary = result.summary; background.record = record; }
    else {
      store.archiveContext([result.summary], [...thought.sources]);
      this.host.meter.reset();
      this.host.getCompactions().push(record);
    }
    return result.compacted;
  }

  /**
   * Recover once from provider context-window overflow or truncated output before any tool call was dispatched.
   * Silent overflows only reset the meter; error/length overflows drop the failed reply, aggressively prune and
   * compact older history, and continue once if the context actually shrank (ADR-0008).
   */
  async recoverOverflow(params: {
    last: AssistantMessage | undefined;
    preempted: boolean;
    signal: AbortSignal;
    model: Model<any>;
    budget: { window: number; budget: number };
    messages: AgentMessage[];
    applyShrunk: (shrunk: AgentMessage[]) => void;
    continueRun: () => Promise<void>;
  }): Promise<boolean> {
    const { last, preempted, signal, model, budget: { window, budget }, messages: current, applyShrunk, continueRun } = params;
    if (!last || preempted || signal.aborted) return false;
    const { config, store, owner } = this.host;
    const desiredMaxOutput = Math.min(modelUse(config, owner).limits.outputReserveTokens, model.maxTokens);
    const overflow = isContextOverflow(last, window);
    const recoverableLength = !overflow && isRecoverableLength(last, desiredMaxOutput);
    if (!overflow && !recoverableLength) return false;
    if (overflow && last.stopReason === 'stop') {
      this.host.meter.reset();
      store.log('context_overflow_silent', { runId: this.host.getRunId(), owner, provider: model.provider, model: model.id, inputTokens: last.usage.input + last.usage.cacheRead, contextWindow: window });
      return false;
    }
    // Never discard or retry a turn that emitted tool calls whose outcomes may already exist (ADR-0008).
    if (last.content.some(block => block.type === 'toolCall')) return false;
    const base = current.at(-1) === last ? current.slice(0, -1) : current.slice();
    if (!base.length || base.at(-1)?.role === 'assistant' || base.every(item => item.role === 'system')) return false;
    const before = estimatedContextTokens(base);
    this.host.meter.reset();
    store.archiveContext(base, [...this.host.getThought().sources]);
    const pruned = pruneToolResults(base, Math.min(2000, Math.floor(config.compaction.keepRecentTokens / 2)));
    let shrunk = pruned.messages;
    const runtime = this.host.runtimeContext(false);
    const snapshot = runtimeMessage(runtimeUpdate(runtime)!);
    const candidate = shrunk.slice();
    const tail = candidate.at(-1);
    if (!(tail?.role === 'user' && tail.content === snapshot.content)) candidate.push(snapshot);
    try {
      shrunk = await this.compact(candidate, budget, model, signal, undefined, 0);
      this.host.setRuntimeSnapshot(runtime);
    } catch (error) {
      if (signal.aborted) throw error;
      ensureCurrent(store, this.host.getThought(), signal);
    }
    const after = estimatedContextTokens(shrunk);
    if (after >= before) return false;
    store.log('context_overflow_recovered', { runId: this.host.getRunId(), owner, reason: overflow ? 'overflow' : 'length', errorMessage: last.errorMessage, beforeTokens: before, afterTokens: after });
    applyShrunk(shrunk);
    await continueRun();
    return true;
  }

  /** Start one summary of an idle snapshot. It keeps running while new thoughts append to the live context. */
  async consolidate(params: {
    isBusy: () => boolean;
    prepare: (generation: number) => void;
    getModel: () => Model<any>;
    getMessages: () => AgentMessage[];
    budget: (model: Model<any>) => { budget: number };
    saveIdleContext: (messages: AgentMessage[], records: Record<string, unknown>[]) => void;
  }): Promise<void> {
    if (this.background) return this.background.promise;
    if (params.isBusy()) return Promise.resolve();
    const { config, store, meter } = this.host;
    const generation = store.settings().generation;
    params.prepare(generation);
    const model = params.getModel();
    const { budget } = params.budget(model);
    const limit = Math.floor(budget * config.compaction.idleRatio);
    const currentMessages = params.getMessages();
    if (meter.measure(currentMessages, modelRoute(model)).tokens <= limit) return Promise.resolve();
    const original = structuredClone(currentMessages);
    const runtime = this.host.runtimeContext();
    const job: BackgroundCompaction = {
      identity: this.host.getIdentity(),
      thought: { generation, sources: new Set(this.host.getThought().sources), triggers: new Set(), lifeOnly: false },
      runId: crypto.randomUUID(),
      controller: new AbortController(),
      meter: new TokenMeter(structuredClone(meter.anchor)),
      original,
      prefix: [],
      promise: Promise.resolve(),
    };
    this.background = job;
    job.promise = (async () => {
      ensureCurrent(store, job.thought, job.controller.signal);
      store.archiveContext(original, [...job.thought.sources]);
      const pruned = pruneToolResults(original, Math.min(config.compaction.keepRecentTokens, budget));
      if (job.meter.measure(pruned.messages, modelRoute(model)).tokens <= limit) {
        this.background = undefined;
        meter.reset();
        params.saveIdleContext(pruned.messages, []);
        return;
      }
      await this.compact([...pruned.messages, runtimeMessage(runtimeUpdate(runtime)!)], budget, model, job.controller.signal, job);
      // A running request owns its transcript until its next boundary. Idle completion can commit now.
      if (this.background === job && !params.isBusy()) {
        const records: Record<string, unknown>[] = [];
        const messages = this.applyBackground(params.getMessages(), this.host.runtimeContext(), records);
        if (records.length) params.saveIdleContext(messages, records);
      }
    })().catch(error => { if (this.background === job) this.background = undefined; throw error; });
    return job.promise;
  }
}
