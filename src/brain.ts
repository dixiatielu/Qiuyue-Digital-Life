import { environmentCredential, type CredentialReader } from './credentials.js';
import { Agent, type AgentMessage, type BeforeToolCallResult, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModelBackend, modelBudget, modelRoute, modelUse, type ModelOwner } from './model.js';
import { createInitialSystemMessage, normalizeContext, toToolDeclaration, type AssistantMessage, type ImageContent, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import { systemInstructions } from './prompts.js';
import type { Monitor } from './monitor.js';
import type { EnvironmentEvent, Memory, MemoryKind, Observation } from './domain.js';
import { errorText, eventChat, ambientEvent, ownEvent } from './domain.js';
import { Store, digest, eventRef } from './store.js';
import { fetchImage } from './web.js';
import { ensureCurrent, type ThoughtContext, type ToolSet } from './tools.js';
import { compactionSplit, contextRecordId, estimatedContextTokens, estimateTokens, fitLines, foldImages, foldToolResults, IMAGE_TOKENS, portableSummaryMessages, pruneToolResults, summaryEnvelope, SUMMARY_PREFIX, textTokens, TokenMeter, toModelMessages, type ContextCheckpoint, type TokenMeasurement } from './context.js';
import { actionSummary, applyRuntimeUpdate, carry, runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';
import { ChatRecord, observationText, recordTime } from './record.js';
import type { SemanticRecall } from './recall.js';
import type { OnlineActivity } from './plugins.js';

/** Built-in online activities; plugins contribute their own activities through the host. */
const onlineActivities: OnlineActivity[] = [
  { activity: 'Write or reread your diary', tools: ['remember', 'recall'], memoryKind: 'note' },
];
/** The summarized text of a continuity summary, without its framing line and record references. */
function summaryBody(message: AgentMessage) {
  if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(SUMMARY_PREFIX)) return;
  const body = message.content.slice(message.content.indexOf('\n') + 1);
  const end = body.lastIndexOf('\nOriginal record IDs: ');
  return end < 0 ? body : body.slice(0, end);
}
/** Local date, weekday, and time; models often misjudge the weekday when left to work it out from an ISO timestamp. */
function localParts(at: number) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
}
function localTime(at: number) {
  const parts = localParts(at);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}
/** A day of life runs from 05:00 local time, so staying up past midnight does not start the next one. */
const lifeDay = (at: number) => localTime(at - 5 * 3_600_000).slice(0, 10);
interface ObservationMessage { role: 'observation'; batchId: string; content: (TextContent | ImageContent)[]; eventIds: string[]; lifeOnly: boolean; timestamp: number }
declare module '@earendil-works/pi-agent-core' { interface CustomAgentMessages { observation: ObservationMessage } }
export interface Brain {
  readonly streaming: boolean;
  readonly thought: ThoughtContext;
  run(observation: Observation): Promise<void>;
  review(observation: Observation): Promise<void>;
  steer(observation: Observation): Promise<boolean>;
  consolidate(): Promise<void>;
  abort(): void;
}

/** What a persisted working context belongs to: when any of it changes, the next start begins a fresh one. */
export function contextIdentity(config: Config, tools: ToolSet) {
  const contracts = tools.plugins.installed().filter(plugin => plugin.contextVersion !== undefined && (plugin.enabled?.() ?? true)).map(plugin => [plugin.id, plugin.contextVersion]);
  const current = tools.current();
  const instructions = systemInstructions(config, tools.plugins.activityPrompts(new Set(current.map(tool => tool.name))));
  return digest({ instructions, model: config.model, accounts: config.adapters.map(({ id, driver, accountId }) => ({ id, driver, accountId })), tools: current.map(toToolDeclaration), ...(contracts.length ? { plugins: contracts } : {}) });
}

export class PiBrain implements Brain {
  readonly agent: Agent;
  thought: ThoughtContext = { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: true };
  private controller = new AbortController();
  private seen = new Set<string>();
  private turns = 0;
  private runId = '';
  private observations: EnvironmentEvent[] = [];
  private contextGeneration = -1;
  private runtimeSnapshot?: RuntimeSnapshot;
  private readonly meter = new TokenMeter();
  private identity: string;
  private pendingRequest: AgentMessage[] = [];
  private pendingRoute = '';
  private compactions: Record<string, unknown>[] = [];
  private readonly stream: StreamFn;
  /** Where the thought is: preparing a model request, waiting on the model, or acting on its answer. */
  private phase: 'idle' | 'preparing' | 'calling' | 'acting' = 'idle';
  /** Chats this thought has acted in or was started from (ADR-0002). */
  private engaged = new Set<string>();
  /** Chats where an addressed message arrived while tools ran; actions there not yet started are stale. */
  private stale = new Set<string>();
  private preempted = false;
  private skipped = false;
  /** Preemptions since a decision was last carried out as made. */
  private preemptions = 0;
  private callStartedAt = 0;
  private activeRequest?: { callId: string; runId: string; owner: ModelOwner; purpose: 'thought' | 'review' | 'compaction'; provider: string; model: string; api: string; startedAt: number; attempt?: number };
  private lastCallId?: string;
  private readonly summaryBackend?: { model: Model<any>; stream: StreamFn };
  constructor(private config: Config, private store: Store, private tools: ToolSet, backend?: { model: Model<any>; stream: StreamFn }, private monitor?: Monitor, private recall?: SemanticRecall, private credential: CredentialReader = environmentCredential, private owner: ModelOwner = 'main', compactionBackend?: { model: Model<any>; stream: StreamFn }) {
    const use = modelUse(config, owner);
    const { model, stream } = backend ?? createModelBackend(use.thinking, credential);
    this.stream = stream;
    this.summaryBackend = compactionBackend ?? (config.compaction.model ? createModelBackend(use.compaction, credential) : undefined);
    if (!model.input.includes('image')) throw new Error('Select a model that supports image input.');
    this.identity = contextIdentity(config, tools);
    this.agent = new Agent({
      initialState: { model, systemPrompt: this.instructions(), tools: tools.current(), thinkingLevel: use.thinking.thinkingLevel ?? 'off' },
      streamFn: (target, context, options) => stream(target, context, { ...options, maxTokens: Math.min(modelUse(config, owner).limits.outputReserveTokens, target.maxTokens) }),
      getApiKey: () => credential(use.thinking.apiKeyEnv), toolExecution: 'sequential', steeringMode: 'all',
      convertToLlm: toModelMessages,
      prepareNextTurnWithContext: ({ context }) => ({ context: { ...context, tools: tools.current() } }),
      beforeToolCall: async ({ toolCall, args }) => this.skipStale(toolCall.name, args),
      afterToolCall: async ({ toolCall, isError, result }) => !isError && this.tools.plugins.endsThought(toolCall.name, result.details) ? { terminate: true } : undefined,
      prepareRequest: async ({ context, model: currentModel }, signal) => {
        const first = this.turns === 0;
        // Observations steered in for stale chats have entered by now.
        this.phase = 'preparing'; this.stale.clear(); this.skipped = false;
        this.display(monitor => monitor.preparingRequest());
        ensureCurrent(store, this.thought, signal);
        const runtime = this.runtimeContext();
        let messages = [...context.messages];
        const shown = this.shown(messages, runtime);
        const view = shown ? carry(runtime, shown, ids => store.activeMemories(ids)) : runtime;
        const update = runtimeUpdate(view, shown);
        if (update) messages.push(this.runtimeMessage(update));
        this.runtimeSnapshot = view;
        const { budget } = this.budget(currentModel);
        const route = this.route(currentModel);
        let measured: TokenMeasurement;
        // The first request leaves room for the observations steered in after it; later ones may fill the budget.
        const limit = first ? Math.floor(budget * config.compaction.idleRatio) : budget;
        ({ messages, measured } = await this.shrink(messages, limit, budget, currentModel, runtime, signal));
        if (measured.tokens > budget) throw new Error('Required state or the latest observation exceeds the context budget; reduce the batch size or organize pending items.');
        store.log('context_budget', { runId: this.runId, owner, ...measured, inputBudget: budget, outputReserveTokens: modelUse(config, owner).limits.outputReserveTokens, safetyTokens: config.limits.contextSafetyTokens });
        ensureCurrent(store, this.thought, signal);
        // A preemption that came during preparation ends the thought before its call; what preparation did is kept.
        if (this.preempted) this.agent.abort(); else this.startRequest(currentModel, owner === 'main' ? 'thought' : 'review');
        // Pi keeps its event transcript separately from the prepared request context.
        this.pendingRequest = messages.slice(); this.pendingRoute = route;
        this.agent.state.messages = messages.slice();
        this.phase = 'calling'; this.callStartedAt = Date.now();
        if (!this.preempted) this.display(monitor => monitor.requestStarted());
        return { context: { ...context, messages } };
      },
      finishTurn: () => config.limits.maxTurnsPerRun !== null && this.turns >= config.limits.maxTurnsPerRun ? { action: 'end' } : undefined,
    });
    this.agent.subscribe(event => {
      this.display(monitor => monitor.agentEvent(event));
      if (event.type === 'message_start' && event.message.role === 'observation') {
        this.seen.add(event.message.batchId);
        for (const source of event.message.eventIds) this.thought.sources.add(source);
        this.thought.triggers = new Set(event.message.eventIds);
        this.thought.lifeOnly &&= event.message.lifeOnly;
        store.log('observation_entered', { runId: this.runId, batchId: event.message.batchId });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') { this.finishRequest(event.message); this.phase = 'acting'; }
      if (event.type === 'tool_execution_start') {
        const chat = this.tools.plugins.chatTarget(event.toolName, event.args); if (chat) this.engaged.add(chat);
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant' && !['error', 'aborted'].includes(event.message.stopReason)) {
        if (!this.skipped) this.preemptions = 0;
        ensureCurrent(store, this.thought);
        this.meter.observe(this.pendingRequest, event.message, this.pendingRoute);
        store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
        store.log('thought_turn_completed', { runId: this.runId, callId: this.lastCallId, owner, toolCalls: event.toolResults.length, usage: event.message.usage });
      }
    });
  }
  /** A preempted thought takes no more steering while it winds down. */
  get streaming() { return this.agent.state.isStreaming && !this.preempted; }
  private display(update: (monitor: Monitor) => void) { if (this.monitor) { try { update(this.monitor); } catch {} } }
  abort() { this.controller.abort(); this.agent.abort(); }
  private instructions() {
    return systemInstructions(this.config, this.activityPrompts());
  }
  /** Read-only management preview, using this brain's actual tool permissions. */
  activityPrompts() { return this.tools.plugins.activityPrompts(new Set(this.tools.current().map(tool => tool.name))); }
  /** What the working context already shows of runtime state: what runtime_data has said, and the actions whose results came back to it as tool results. */
  private shown(messages: AgentMessage[], runtime: RuntimeSnapshot): RuntimeSnapshot | undefined {
    const previous = this.runtimeSnapshot;
    if (!previous) return;
    const known = new Set(((previous.actualActions ?? []) as { id: string }[]).map(action => action.id));
    const fresh = (runtime.actualActions as { id: string }[]).filter(action => !known.has(action.id));
    if (!fresh.length) return previous;
    const results = messages.flatMap(message => message.role === 'toolResult' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []);
    const seen = fresh.filter(action => results.some(text => text.includes(action.id)));
    return seen.length ? { ...previous, actualActions: [...((previous.actualActions ?? []) as unknown[]), ...seen] } : previous;
  }
  private runtimeMessage(data: RuntimeSnapshot): Message {
    return { role: 'user', content: `<runtime_data>\n${JSON.stringify(data)}\n</runtime_data>`, timestamp: Date.now() };
  }
  private chargeCall() {
    this.turns++;
    if (this.config.limits.maxTurnsPerRun !== null && this.turns > this.config.limits.maxTurnsPerRun) throw new Error('The turn limit for this reasoning run has been reached.');
    return this.store.chargeCall(this.runId, this.config.limits.modelCallsPerDay);
  }
  private startRequest(model: Model<any>, purpose: 'thought' | 'review' | 'compaction', attempt?: number) {
    this.activeRequest = { callId: this.chargeCall(), runId: this.runId, owner: this.owner, purpose, provider: model.provider, model: model.id, api: model.api, startedAt: Date.now(), ...(attempt === undefined ? {} : { attempt }) };
    this.store.log('model_request_started', this.activeRequest);
  }
  private finishRequest(response?: AssistantMessage, aborted = this.controller.signal.aborted) {
    const request = this.activeRequest;
    if (!request) return;
    this.activeRequest = undefined; this.lastCallId = request.callId;
    const status = response ? response.stopReason === 'aborted' ? 'aborted' : response.stopReason === 'error' ? 'error' : 'success' : aborted ? 'aborted' : 'error';
    const usage = response?.usage;
    const known = usage && (status === 'success' || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(value => value > 0));
    this.store.log('model_request_finished', { ...request, finishedAt: Date.now(), status, stopReason: response?.stopReason, usage: known ? usage : null });
  }
  private route(model: Model<any>) { return modelRoute(model); }
  private budget(model: Model<any>) {
    const { limits } = modelUse(this.config, this.owner);
    const { window, budget } = modelBudget(model, limits.contextTokens, limits.outputReserveTokens, limits.contextSafetyTokens);
    if (budget <= 0) throw new Error('The model window is too small for the output reserve and safety margin.');
    return { window, budget };
  }
  private get contextTokens() { return this.budget(this.agent.state.model).window; }
  /** Bring the context under limit: prune old tool results first, and summarize older exchanges only if that is not enough. */
  private async shrink(messages: AgentMessage[], limit: number, budget: number, model: Model<any>, runtime: RuntimeSnapshot, signal?: AbortSignal) {
    const route = this.route(model);
    let measured = this.meter.measure(messages, route);
    const before = measured.tokens;
    if (measured.tokens <= limit) return { messages, measured };
    this.store.archiveContext(messages, [...this.thought.sources]);
    const pruned = pruneToolResults(messages, Math.min(this.config.compaction.keepRecentTokens, budget));
    messages = pruned.messages;
    measured = this.meter.measure(messages, route);
    if (pruned.changed) this.store.log('context_pruned', { runId: this.runId, results: pruned.changed, beforeTokens: before, afterTokens: measured.tokens });
    if (measured.tokens > limit) {
      // A delta may depend on a base that compaction removes. Keep a complete current state.
      const snapshot = this.runtimeMessage(runtimeUpdate(runtime)!);
      const latest = messages.at(-1);
      if (!(latest?.role === 'user' && latest.content === snapshot.content)) messages.push(snapshot);
      this.runtimeSnapshot = runtime;
      try { messages = await this.compact(messages, budget, model, signal); }
      catch (error) {
        // Below the full budget, compaction only makes room ahead of time; the request can go on without it.
        if (measured.tokens > budget || signal?.aborted) throw error;
        ensureCurrent(this.store, this.thought, signal);
        this.store.log('context_compaction_skipped', { runId: this.runId, message: errorText(error) });
      }
      measured = this.meter.measure(messages, route);
    }
    return { messages, measured };
  }
  private async compact(messages: AgentMessage[], budget: number, ownerModel: Model<any>, signal?: AbortSignal): Promise<AgentMessage[]> {
    const use = modelUse(this.config, this.owner);
    const { model, stream } = this.summaryBackend ?? { model: ownerModel, stream: this.stream };
    const { window } = modelBudget(model, use.compactionContextTokens, this.config.compaction.summaryMaxTokens, this.config.limits.contextSafetyTokens);
    const summaryLimit = this.config.compaction.summaryMaxTokens;
    const { system, pinned, removed, kept } = compactionSplit(messages, Math.min(this.config.compaction.keepRecentTokens, budget), budget, summaryLimit + 100, this.owner === 'review');
    if (!removed.length) throw new Error('No older exchanges can be safely compacted; reduce the latest input or increase the context budget.');
    const ids = this.store.archiveContext(removed, [...this.thought.sources]);
    const { framing, references, reserve } = summaryEnvelope(ids);
    const outputLimit = summaryLimit - reserve;
    if (outputLimit < 64) throw new Error('The summary token limit is too small to retain the required source references.');
    // Models cannot count their own tokens; aiming well below the cut-off leaves room to finish.
    const target = Math.floor(outputLimit * 0.6);
    const instructions = `Internal working context consolidation: Produce a brief continuity summary for the same digital life, aiming for about ${target} tokens (Chinese runs about one token per character); output stops at ${outputLimit}. Summarize only the first ${removed.length} older messages after the system message${pinned.length ? ' and the retained review prompt' : ''}. An existing summary among them is material to condense, not a prefix to keep: the limit covers it too, so merge it in and shorten it, dropping what is settled, superseded, or already saved with remember. Put the most important first; if output stops early, only the end is lost. If recent exchanges follow, use them only to correct outdated judgments; their originals are retained separately. Do not call tools or take external action. Preserve people, times, group or private settings, changes in relationship impressions and their evidence, current topics, unfinished matters, and actual action outcomes. Distinguish reported claims, inferences, fiction, success, failure, and unknown outcomes. Old state may be outdated; follow later runtime_data. Update outdated judgments in existing summaries. Use read_context to retrieve originals when needed; older records include ${ids.slice(-12).join(', ')}. Retain relevant source IDs and necessary ctx: record IDs in the summary.`;
    const directive: Message = { role: 'user', content: instructions, timestamp: Date.now() };
    // Reuse the complete warm prefix when it fits; the old prefix remains a fallback for oversized new input.
    let request: AgentMessage[] = [system, ...pinned, ...removed, ...kept, directive];
    const fits = (candidate: AgentMessage[]) => this.meter.measure(candidate, this.route(model)).tokens + summaryLimit + this.config.limits.contextSafetyTokens <= window;
    const includedRecentContext = fits(request);
    if (!includedRecentContext) request = [system, ...pinned, ...removed, directive];
    const sized = includedRecentContext || fits(request);
    const replacement = (text: string) => {
      const summary: Message = { role: 'user', content: framing + text + references, timestamp: Date.now() };
      const compacted = [system, ...pinned, summary, ...kept];
      const before = estimatedContextTokens(messages); const after = estimatedContextTokens(compacted);
      return after < before && after <= budget ? { summary, compacted, before, after } : undefined;
    };
    let result: ReturnType<typeof replacement>; let truncated = false; let transient = false;
    let failure = 'The history to consolidate exceeds the context budget; a continuity summary cannot be generated safely.';
    for (let attempt = 0; sized && !result && attempt <= this.config.compaction.retries; attempt++) {
      ensureCurrent(this.store, this.thought, signal);
      this.startRequest(model, 'compaction', attempt);
      this.display(monitor => monitor.requestStarted('compacting'));
      let response: AssistantMessage;
      try {
        const portable = this.route(model) === this.route(ownerModel) ? request : portableSummaryMessages(request);
        response = await (await stream(model, normalizeContext({ messages: toModelMessages(portable) }), { apiKey: this.credential(use.compaction.apiKeyEnv), reasoning: use.compactionThinkingLevel === 'off' ? undefined : use.compactionThinkingLevel, signal, maxTokens: Math.min(outputLimit, model.maxTokens) })).result();
        this.finishRequest(response);
      } catch (error) { this.finishRequest(undefined, signal?.aborted); throw error; }
      ensureCurrent(this.store, this.thought, signal);
      this.store.log('context_summary_completed', { runId: this.runId, callId: this.lastCallId, owner: this.owner, attempt, usage: response.usage, stopReason: response.stopReason });
      transient = response.stopReason === 'error' || response.stopReason === 'aborted';
      const written = transient || response.content.some(item => item.type === 'toolCall') ? '' : response.content.filter((item): item is TextContent => item.type === 'text').map(item => item.text).join('\n').trim();
      // A summary cut off at the limit keeps its complete lines, which come in order of importance.
      const text = fitLines(written, outputLimit, response.stopReason === 'stop');
      result = text ? replacement(text) : undefined;
      truncated = text !== written;
      failure = result ? '' : text ? 'The continuity summary did not reduce the context or still exceeds the budget.' : `The continuity summary was not generated completely: ${response.errorMessage ?? response.stopReason}`;
    }
    // The same history would fail the same way on every retry, so set it aside rather than fail the run.
    // Only a transport failure, which a later run may not meet, still fails it.
    if (!result && !transient) { result = replacement(this.setAside(removed, ids, outputLimit, failure)); truncated = false; }
    if (!result) throw new Error(failure);
    this.store.archiveContext([result.summary], [...this.thought.sources]);
    this.meter.reset();
    this.compactions.push({ runId: this.runId, owner: this.owner, provider: model.provider, model: model.id, beforeTokens: result.before, afterTokens: result.after, removedMessages: removed.length, includedRecentContext, ...(truncated ? { truncated } : {}), ...(failure ? { setAside: failure } : {}), firstKeptRecordId: kept[0] ? contextRecordId(kept[0]) : undefined, summaryRecordId: contextRecordId(result.summary) });
    return result.compacted;
  }
  /** Without a summary, older messages leave under a note; their originals stay archived and their events recallable. */
  private setAside(removed: AgentMessage[], ids: string[], limit: number, reason: string) {
    const index = removed.findIndex(message => summaryBody(message) !== undefined);
    const times = removed.map(message => message.timestamp);
    const span = times.length ? ` from ${recordTime(Math.min(...times))} to ${recordTime(Math.max(...times))}` : '';
    const note = `[No summary was written for ${removed.length} older messages${span} (${reason}). Use recall, read_event, or read_chat_record for that period, or read_context for the originals${index >= 0 ? `; the earlier summary carried forward above is ${ids[index]} in full` : ''}.]`;
    const previous = index >= 0 ? fitLines(summaryBody(removed[index]!)!, limit - textTokens(note) - 1) : '';
    return previous ? `${previous}\n${note}` : note;
  }
  private resetContext() {
    this.agent.reset(); this.agent.state.tools = this.tools.current();
    this.agent.state.messages = [createInitialSystemMessage(this.instructions(), this.tools.current().map(toToolDeclaration))!];
    this.meter.reset(); this.thought.sources.clear(); this.runtimeSnapshot = undefined;
  }
  /** Called only while the runtime has stopped dispatch and drained both brains. */
  refreshTools(): boolean {
    if (this.phase !== 'idle') throw new Error('Cannot replace tools during a thought.');
    const identity = contextIdentity(this.config, this.tools);
    const changed = identity !== this.identity;
    this.identity = identity;
    this.agent.state.tools = this.tools.current();
    if (changed) { this.resetContext(); this.contextGeneration = -1; }
    return changed;
  }
  private checkpoint(): ContextCheckpoint {
    return { identity: this.identity, generation: this.contextGeneration, messages: this.agent.state.messages.slice(), sources: [...this.thought.sources], anchor: this.meter.anchor };
  }
  private restore(checkpoint: ContextCheckpoint) {
    this.agent.reset(); this.agent.state.tools = this.tools.current();
    this.runtimeSnapshot = undefined;
    this.agent.state.messages = checkpoint.messages;
    for (const message of checkpoint.messages) {
      if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')) {
        const data = JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>'))) as RuntimeSnapshot;
        this.runtimeSnapshot = applyRuntimeUpdate(this.runtimeSnapshot, data);
      }
    }
    this.meter.anchor = checkpoint.anchor;
    this.contextGeneration = checkpoint.generation;
    this.thought.sources = new Set(checkpoint.sources);
  }
  private runtimeContext() {
    const recent = this.store.recent(this.config.memory.recentEvents);
    // What is said calls memories to mind, not merely where it is said (ADR-0009); development is supplied by scope below.
    const recalled = this.recall?.recall(this.observations) ?? [];
    for (const source of [...recent, ...recalled.map(item => item.memory)]) this.thought.sources.add(source.id);
    // A review looks at the chats it lists, so their groups and the people who spoke there count as present.
    const chats = this.observations.filter(event => event.kind === 'memory_maintenance').flatMap(event => (event.payload.backlog ?? []) as { conversation: string; since: number }[]);
    const present = this.observations.filter(event => !ownEvent(event)).flatMap(event => event.source?.actor ? [event.source.actor] : []).reverse();
    const people = [...new Set([...present, ...this.store.impressionsIn(chats, this.config.development.people)])].slice(0, this.config.development.people);
    const conversations = [...new Set([...this.observations.flatMap(event => event.source?.conversation ? [event.source.conversation] : []), ...chats.map(chat => chat.conversation)])];
    const development = this.store.development(['global', ...conversations.map(chat => `conversation:${chat}`), ...people.map(person => `person:${person}`)]);
    // When each was formed, so a judgment from last night's review reads as that rather than as settled.
    const entries = (kind: MemoryKind) => development.filter(memory => memory.kind === kind).map((memory: Memory) => ({ id: memory.id, scope: memory.scope, title: memory.title, content: memory.content, createdAt: new Date(memory.createdAt).toISOString() }));
    const runtime = { platformAccounts: this.store.setting('platformAccounts', {}), now: new Date().toISOString(), timeZone: 'Asia/Shanghai', adapters: this.config.adapters.map(({ id, driver, accountId, tools }) => ({ id, driver, accountId, tools })), settings: this.store.settings(), allowFiction: this.config.life.allowFiction, activeCommitmentsAndPlans: this.store.wakes(), pursuits: this.store.pursuits(), recentEvents: recent.map(event => ({ id: event.id, kind: event.kind, at: event.at, ...(event.source ? { source: event.source } : {}), text: event.text.slice(0, 400), truncated: event.text.length > 400 })), recalled: recalled.map(({ memory, line }) => ({ ...memory, content: memory.content.slice(0, 2000), truncated: memory.content.length > 2000, matchedLine: line })), actualActions: this.store.actions(10).map(action => actionSummary(action)), myHabits: entries('habit'), practices: entries('practice'), impressions: entries('impression') };
    // Commitments, current activity, pursuits, and development are never selected by probabilistic recall.
    while (estimateTokens(runtime) > this.contextTokens / 4 && runtime.recentEvents.length) runtime.recentEvents.shift();
    while (estimateTokens(runtime) > this.contextTokens / 4 && runtime.recalled.length) runtime.recalled.pop();
    return runtime;
  }
  private async message(observation: Observation): Promise<ObservationMessage> {
    const preview = Math.max(80, Math.min(2000, Math.floor(this.contextTokens / (observation.events.length * 8))));
    const rests = observation.events.filter(event => event.kind === 'rest_backlog');
    const faces = await this.tools.plugins.emojiNames(observation.events, this.controller.signal);
    // Lines in the form of the chat record, less than half the size of event objects (ADR-0019).
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `New environment observations (times +08:00; a #xxxxxxxx ref is an event ID; read_event shows the whole event):\n${observationText(this.store, observation.events, faces, preview)}` }];
    if (observation.events.some(event => event.kind === 'wake' && event.payload.wakeKind === 'life')) content.push({ type: 'text', text: this.lifeContext() });
    for (const rest of rests) content.push({ type: 'text', text: this.restRecord(rest.payload, faces) });
    for (const text of this.tools.plugins.observation(observation.events, this.thought)) content.push({ type: 'text', text });
    let count = 0;
    const fits = () => count++ < this.config.limits.maxImages && estimateTokens(content.filter(item => item.type !== 'image')) + count * IMAGE_TOKENS <= this.contextTokens * 0.4;
    // Plugin-produced pictures are seen before incoming chat images, within the same context budget.
    for (const event of observation.events) for (const image of this.tools.plugins.images(event).filter(image => image.autoView)) {
      if (!fits()) { content.push({ type: 'text', text: image.deferred }); continue; }
      let picture;
      try { picture = await image.load(this.controller.signal); } catch { this.controller.signal.throwIfAborted(); }
      if (!picture) { count--; content.push({ type: 'text', text: image.unavailable }); continue; }
      content.push({ type: 'text', text: image.label }, { type: 'image', data: picture.data.toString('base64'), mimeType: picture.mimeType });
      image.onShown?.();
    }
    for (const event of observation.events) for (const [index, segment] of (Array.isArray(event.payload.message) ? event.payload.message : []).filter(segment => segment.type === 'image').entries()) {
      const ref = eventRef(event.id);
      const saved = this.tools.plugins.imageCaption(segment.data ?? {});
      const url = segment.data?.url;
      // A line leaves the URL out, so saving the image as a sticker or sending it on takes it from its label.
      const from = typeof url === 'string' ? `; url: ${url}` : '';
      if (!fits()) {
        content.push({ type: 'text', text: `Image ${index} from ${ref}${saved} was not loaded due to the context limit; use view_event_image to view it${from}` }); continue;
      }
      if (typeof url !== 'string') { content.push({ type: 'text', text: `Image ${index} in ${ref}${saved} has no readable URL; the original event is retained.` }); continue; }
      try {
        const image = await fetchImage(url, this.controller.signal);
        // The label outlives the image, which is folded when the thought ends.
        content.push({ type: 'text', text: `The following is image ${index} from ${ref}${saved}${from}` }, { type: 'image', data: image.data.toString('base64'), mimeType: image.type });
      } catch { content.push({ type: 'text', text: `Image ${index} in ${ref}${saved} could not be read${from}` }); }
    }
    // Supplementary plugin pictures follow the images in the chat and use the same budget.
    for (const image of this.tools.plugins.supplementalImages(observation.events, this.thought)) {
      if (!image.autoView) continue;
      if (!fits()) { if (image.deferred) content.push({ type: 'text', text: image.deferred }); continue; }
      let picture;
      try { picture = await image.load(this.controller.signal); } catch { this.controller.signal.throwIfAborted(); }
      if (!picture) { count--; if (image.unavailable) content.push({ type: 'text', text: image.unavailable }); continue; }
      content.push({ type: 'text', text: image.label }, { type: 'image', data: picture.data.toString('base64'), mimeType: picture.mimeType });
      image.onShown?.();
    }
    return { role: 'observation', batchId: observation.batchId, eventIds: observation.events.map(event => event.id), lifeOnly: observation.events.every(event => event.kind === 'wake' && event.payload.wakeKind === 'life'), content, timestamp: Date.now() };
  }
  /** The group chat a rest held, read as a chat record from where it began. Each group's share of a quarter of the context bounds its record, which beyond that leaves out its earliest lines and says where they begin (ADR-0016). */
  private restRecord(payload: Record<string, unknown>, faces: Record<string, string>) {
    const { until, chats } = payload as { until: number; chats: { conversation: string; from: number; messages: number; notices: number }[] };
    const items = chats.reduce((sum, chat) => sum + chat.messages + chat.notices, 0) || 1;
    return chats.map(chat => {
      const share = Math.floor(this.contextTokens / 4 * (chat.messages + chat.notices) / items);
      const { text, omitted } = new ChatRecord(this.store, chat.conversation, faces, undefined, action => this.tools.plugins.actionCaption(action)).span(chat.from, until, share);
      return omitted ? `${text}\n[The earliest ${omitted} lines did not fit; read them with read_chat_record from="${recordTime(chat.from)}".]` : text;
    }).join('\n\n');
  }
  /** What a life wake sees of its own days: the local time, how recent plans went, what happens to come to mind, and what it can actually do online. */
  private lifeContext() {
    const now = Date.now(); const today = lifeDay(now); const hour = Number(localParts(now).hour);
    const parts = [`Local time: ${localTime(now)} (Asia/Shanghai).`];
    const plans = this.store.pastLifePlans(8);
    if (!plans.some(wake => lifeDay(wake.dueAt) === today)) parts.push('This is your first life wake today. Sketch the day loosely: two or three things of different lengths, with no need to fill every hour or to finish them all.');
    if (plans.length) parts.push(`Your recent life plans, latest first. Vary your days rather than repeating the same few things:\n${JSON.stringify(plans.map(wake => ({ title: wake.title, at: localTime(wake.dueAt), status: wake.status })))}`);
    if (!this.store.pursuits().length) parts.push('You have no pursuits under way.');
    if (this.config.life.allowFiction) parts.push('Now and then, fictional daily life brings what you did not plan: the weather turns, a shop is closed, something breaks, something catches your eye. It can change your mood and plans.');
    const diary = this.store.lastMemoryAt('note');
    if ((hour >= 21 || hour < 5) && (diary === undefined || lifeDay(diary) !== today)) parts.push("You have not written today's diary. If you write one, write about your own day and feelings; chats belong in it only where they truly mattered to you.");
    // Chance recollections keep each wake from starting at the same blank page.
    const surfaced = [this.store.randomMemory(['experience', 'note', 'fiction'], now - 86_400_000), this.store.randomMemory(['impression'])].filter((memory): memory is Memory => memory !== undefined);
    for (const memory of surfaced) this.thought.sources.add(memory.id);
    if (surfaced.length) parts.push(`What happens to come to mind; follow it or let it pass:\n${JSON.stringify(surfaced.map(memory => ({ id: memory.id, kind: memory.kind, ...(memory.scope ? { scope: memory.scope } : {}), title: memory.title, content: memory.content.slice(0, 300), fictional: memory.fictional, createdAt: new Date(memory.createdAt).toISOString() })))}`);
    const online = this.onlineLife();
    if (online) parts.push(online);
    return parts.join('\n\n');
  }
  /** When each available online activity was last done, so a life wake knows what it can actually do. */
  private onlineLife() {
    const available = new Set(this.tools.current().map(tool => tool.name));
    const activities = this.tools.plugins.activities(onlineActivities, available);
    if (!activities.length) return;
    const experienceKind = (tool: string) => this.tools.plugins.experienceKind(tool);
    const last = this.store.lastExperienced(activities.flatMap(item => item.tools.map(experienceKind)));
    const status = activities.map(({ activity, tools, memoryKind, currentValue }) => {
      const at = memoryKind ? this.store.lastMemoryAt(memoryKind) ?? 0 : Math.max(0, ...tools.map(name => last[experienceKind(name)] ?? 0));
      const setter = currentValue && tools.includes(currentValue.tool) ? currentValue : undefined;
      const args = setter && this.store.lastSuccessfulAction(setter.tool)?.args;
      const current = args ? setter!.read(args) : undefined;
      return { activity, tools, lastDone: at ? new Date(at).toISOString() : `not in the last ${this.config.memory.retentionDays} days`, ...(current !== undefined ? { lastSetTo: current } : {}) };
    });
    return `Online activities available for your own life, with when you last did each. Life activities can be actual online activities like these, not only fictional daily life.\n${JSON.stringify(status)}`;
  }
  /** Load the persisted working context unless this process already holds it for the current management state. */
  private prepare(generation: number) {
    if (this.contextGeneration !== generation) {
      this.resetContext();
      const saved = this.store.loadContext(this.identity);
      if (saved) { try { this.restore(saved); } catch { this.resetContext(); } }
    }
    this.agent.state.tools = this.tools.current();
    this.contextGeneration = generation;
  }
  private revert(checkpoint: ContextCheckpoint, generation: number) {
    if (this.store.settings().generation === generation) this.restore(checkpoint);
    else { this.resetContext(); this.thought.sources.clear(); this.contextGeneration = -1; }
  }
  async run(observation: Observation) {
    const generation = this.store.settings().generation;
    this.prepare(generation);
    const rollback = this.checkpoint(); this.compactions = [];
    this.seen.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    this.engaged = new Set(observation.events.filter(event => !ownEvent(event) && !ambientEvent(event)).map(eventChat).filter((chat): chat is string => chat !== undefined));
    this.stale.clear(); this.preempted = false;
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: true };
    this.display(monitor => monitor.startRun(this.runId, observation));
    let outcome: 'done' | 'error' | 'interrupted' = 'done';
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      // A preempted thought ends without its unfinished call and is saved like any other (ADR-0002).
      if (this.preempted) this.agent.state.messages = this.agent.state.messages.filter(item => !(item.role === 'assistant' && item.stopReason === 'aborted'));
      else if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      ensureCurrent(this.store, this.thought);
      // The next thought decides again, so a preempted one leaves what it was looking at for it to fold.
      if (!this.preempted) this.fold();
      this.store.saveContext(this.checkpoint(), [...this.seen], this.compactions);
      this.seen.clear();
    }
    catch (error) { outcome = this.controller.signal.aborted ? 'interrupted' : 'error'; this.revert(rollback, generation); throw error; }
    finally { this.finishRequest(undefined, this.preempted || this.controller.signal.aborted); this.display(monitor => monitor.endRun(this.preempted ? 'interrupted' : outcome)); this.agent.clearAllQueues(); this.phase = 'idle'; this.preempted = false; }
  }
  /** A memory review runs apart from the conversations, in a working context of its own that starts from runtime state and ends with it; nothing steers into it (ADR-0012). */
  async review(observation: Observation) {
    const generation = this.store.settings().generation;
    this.resetContext(); this.compactions = [];
    this.seen.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    this.engaged = new Set(); this.stale.clear(); this.preempted = false;
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(), triggers: new Set(), lifeOnly: false, reviewing: true };
    this.store.log('review_started', { runId: this.runId, eventIds: observation.events.map(event => event.id) });
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      this.store.log('review_finished', { runId: this.runId, calls: this.turns });
    }
    finally {
      this.finishRequest();
      // Its exchanges were archived turn by turn; only the context itself is let go.
      for (const compacted of this.compactions) this.store.log('context_compacted', compacted);
      this.agent.clearAllQueues(); this.phase = 'idle'; this.resetContext();
    }
  }
  /** A message to the digital life in a chat this thought is engaged in: anything in a private chat, or a mention of or reply to it in a group. */
  private addressed(event: EnvironmentEvent): boolean {
    const chat = eventChat(event);
    return event.kind === 'message' && chat !== undefined && this.engaged.has(chat) && event.source?.addressed === true;
  }
  /** Stop a thought whose model is deciding without a newer addressed message; a call already answered is left to its tools. */
  private preempt(event: EnvironmentEvent): boolean {
    if ((this.phase !== 'preparing' && this.phase !== 'calling') || this.preemptions >= this.config.limits.maxPreemptions) return false;
    this.preempted = true; this.preemptions++;
    this.store.log('thought_preempted', { runId: this.runId, phase: this.phase, eventId: event.id, ...(this.phase === 'calling' ? { callMs: Date.now() - this.callStartedAt } : {}) });
    // Preparation, such as compaction, finishes first; prepareRequest then ends the thought.
    if (this.phase === 'calling') this.agent.abort();
    return true;
  }
  /** A message, sticker, reaction, or poke not yet sent when an addressed message arrived in its chat is skipped, so the model decides again. */
  private async skipStale(tool: string, args: unknown): Promise<BeforeToolCallResult | undefined> {
    const chat = this.tools.plugins.chatTarget(tool, args, true);
    if (!chat || !this.stale.has(chat)) return;
    if (!this.skipped) {
      if (this.preemptions >= this.config.limits.maxPreemptions) return;
      this.skipped = true; this.preemptions++;
      this.store.log('thought_preempted', { runId: this.runId, phase: 'acting', chat });
    }
    return { block: true, reason: `Not sent: a new message arrived in ${chat} after you decided this. It follows as a new observation; decide again with it in view.` };
  }
  /** Chat records read and images seen in a thought leave working context when it ends. Both sit within this thought, so the cached prefix before it stays valid. */
  private fold() {
    const records = foldToolResults(this.agent.state.messages, 'read_chat_record');
    const images = foldImages(records.messages, label => this.tools.plugins.imageViewer(label));
    if (!records.changed && !images.changed) return;
    this.store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
    this.agent.state.messages = images.messages;
    this.store.log('context_folded', { runId: this.runId, results: records.changed, images: images.changed });
  }
  /** Between runs, compact a context above compaction.idleRatio of its budget; the first request of a run does the same, later ones compact at the full budget. */
  async consolidate() {
    const generation = this.store.settings().generation;
    this.prepare(generation);
    const model = this.agent.state.model;
    const { budget } = this.budget(model);
    const limit = Math.floor(budget * this.config.compaction.idleRatio);
    if (this.meter.measure(this.agent.state.messages, this.route(model)).tokens <= limit) return;
    const rollback = this.checkpoint(); this.compactions = [];
    this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [];
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: false };
    try {
      const { messages } = await this.shrink(this.agent.state.messages.slice(), limit, budget, model, this.runtimeContext(), this.controller.signal);
      this.agent.state.messages = messages;
      this.store.saveContext(this.checkpoint(), [], this.compactions);
    } catch (error) { this.revert(rollback, generation); throw error; }
  }
  async steer(observation: Observation): Promise<boolean> {
    const runId = this.runId;
    if (!this.streaming) return false;
    const addressed = observation.events.filter(event => this.addressed(event));
    // Declined here, the observation returns to pending and starts the next thought.
    if (addressed.length && this.preempt(addressed[0]!)) return false;
    if (this.preemptions < this.config.limits.maxPreemptions) for (const event of addressed) this.stale.add(eventChat(event)!);
    const message = await this.message(observation);
    // The run may have ended, or another begun, while images were downloading.
    if (!this.streaming || this.runId !== runId) return false;
    this.observations.push(...observation.events);
    this.display(monitor => monitor.observation(observation));
    this.agent.steer(message); return true;
  }
}
