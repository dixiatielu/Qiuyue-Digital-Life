import { environmentCredential, type CredentialReader } from './credentials.js';
import { Agent, type AgentMessage, type BeforeToolCallResult, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModelBackend, initialThinkingLevel, modelBudget, modelRoute, modelUse, shouldMergeConsecutiveUsers, withToolLoader, type ModelOwner } from './model.js';
import { createInitialSystemMessage, getCurrentTools, toToolDeclaration, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import { systemInstructions } from './prompts.js';
import type { Monitor } from './monitor.js';
import type { EnvironmentEvent, Observation } from './domain.js';
import { eventChat, ambientEvent, ownEvent } from './domain.js';
import { Store, digest } from './store.js';
import { normalizeImageBlocks } from './image.js';
import { ensureCurrent, FIND_TOOLS, type ThoughtContext, type ToolSet } from './tools.js';
import { foldNoopCalls, foldReplies, portableMessages, TokenMeter, toModelMessages, type ContextCheckpoint } from './context.js';
import { applyRuntimeUpdate, carry, runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';
import type { SemanticRecall } from './recall.js';
import {
  buildObservationMessage,
  buildRuntimeSnapshot,
  buildSeedTurns,
  runtimeMessage,
  shownRuntimeSnapshot,
  stableJson,
} from './brain-observation.js';
import { ContextCompactor, foldThoughtMessages, type ModelRequest } from './brain-compaction.js';

/** Tools whose own execution checks live state for no-op updates (so A -> B -> A remains allowed in one thought). */
const stateCheckedTools = new Set(['set_activity', 'update_pursuit']);

export interface Brain {
  readonly streaming: boolean;
  readonly thought: ThoughtContext;
  run(observation: Observation): Promise<void>;
  review(observation: Observation): Promise<void>;
  steer(observation: Observation): Promise<boolean>;
  consolidate(): Promise<void>;
  abort(): void;
}

/**
 * What a persisted working context belongs to: when instructions, accounts, tools, or plugin contracts change, the
 * next start begins a fresh working context. Changing the model or its parameters hands off the working context
 * seamlessly, stripping foreign signatures and resetting the token meter on restore.
 */
export function contextIdentity(config: Config, tools: ToolSet) {
  const contracts = tools.plugins.installed().filter(plugin => plugin.contextVersion !== undefined && (plugin.enabled?.() ?? true)).map(plugin => [plugin.id, plugin.contextVersion]);
  const current = tools.current();
  const instructions = systemInstructions(config, tools.plugins.activityPrompts(new Set(current.map(tool => tool.name))), tools.deferred());
  return digest({ instructions, accounts: config.adapters.map(({ id, driver, accountId }) => ({ id, driver, accountId })), tools: current.map(toToolDeclaration), ...(contracts.length ? { plugins: contracts } : {}) });
}

export class PiBrain implements Brain {
  readonly agent: Agent;
  thought: ThoughtContext = { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: true };
  private controller = new AbortController();
  private seen = new Set<string>();
  /** The tools the reply being carried out calls. */
  private batch: string[] = [];
  /** Tool calls already completed since the latest observation in this thought, to stop in-thought repeat loops. */
  private repeatedCalls = new Set<string>();
  /** Tool call IDs in this thought that were no-ops or blocked repeats, folded out when the thought ends (ADR-0024). */
  private noopCalls = new Set<string>();
  /** Memories this thought has already been counted as calling to mind. */
  private broughtToMind = new Set<string>();
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
  private readonly compactor: ContextCompactor;
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
  private activeRequest?: ModelRequest;
  /** The thought as it stood after its last completed turn, which a later failed call does not undo (ADR-0024). */
  private completed?: { messages: AgentMessage[]; seen: string[]; sources: string[]; compactions: number; anchor: ContextCheckpoint['anchor']; turns: number };
  private lastCallId?: string;
  private sessionId: string = crypto.randomUUID();
  private lastAssistant?: AssistantMessage;
  private readonly summaryBackend?: { model: Model<any>; stream: StreamFn };

  constructor(
    private config: Config,
    private store: Store,
    private tools: ToolSet,
    backend?: { model: Model<any>; stream: StreamFn },
    private monitor?: Monitor,
    private recall?: SemanticRecall,
    private credential: CredentialReader = environmentCredential,
    private owner: ModelOwner = 'main',
    compactionBackend?: { model: Model<any>; stream: StreamFn },
  ) {
    const use = modelUse(config, owner);
    const { model, stream: transport } = backend ?? createModelBackend(use.thinking, credential);
    // Transports that load tools dynamically are told which tool loads the others (ADR-0023).
    const loading = (send: StreamFn): StreamFn => tools.loading.enabled ? withToolLoader(send, FIND_TOOLS) : send;
    const stream = loading(transport);
    this.stream = stream;
    const summary = compactionBackend ?? (config.compaction.model ? createModelBackend(use.compaction, credential, { requireVision: false }) : undefined);
    this.summaryBackend = summary && { model: summary.model, stream: loading(summary.stream) };
    if (!model.input.includes('image')) throw new Error('Select a model that supports image input.');
    this.identity = contextIdentity(config, tools);
    this.compactor = new ContextCompactor({
      config, store, owner, credential, meter: this.meter, stream: this.stream, summaryBackend: this.summaryBackend,
      getIdentity: () => this.identity,
      getSessionId: () => this.sessionId,
      getThought: () => this.thought,
      getRunId: () => this.runId,
      getCompactions: () => this.compactions,
      setRuntimeSnapshot: snapshot => { this.runtimeSnapshot = snapshot; },
      startRequest: (target, purpose, attempt) => this.startRequest(target, purpose, attempt),
      finishRequest: (response, aborted) => this.finishRequest(response, aborted),
      recordRequestFinished: (request, response, aborted) => this.recordRequestFinished(request, response, aborted),
      notifyCompacting: () => this.display(monitor => monitor.requestStarted('compacting')),
      runtimeContext: thinking => this.runtimeContext(thinking),
    });
    const initialThinking = initialThinkingLevel(model, use.thinking.thinkingLevel ?? 'off');
    const mergeUsers = shouldMergeConsecutiveUsers(use.thinking, model);
    this.agent = new Agent({
      initialState: { model, systemPrompt: this.instructions(), tools: tools.declared(), thinkingLevel: initialThinking },
      sessionId: this.sessionId,
      thinkingBudgets: use.thinking.thinkingBudgets,
      maxRetryDelayMs: use.thinking.maxRetryDelayMs ?? 60_000,
      streamFn: (target, context, options) => stream(target, context, {
        ...options,
        sessionId: options?.sessionId ?? this.sessionId,
        cacheRetention: options?.cacheRetention ?? use.thinking.cacheRetention ?? 'short',
        maxTokens: Math.min(modelUse(config, owner).limits.outputReserveTokens, target.maxTokens),
      }),
      getApiKey: () => credential(use.thinking.apiKeyEnv), toolExecution: 'sequential', steeringMode: 'all',
      convertToLlm: messages => toModelMessages(messages, { mergeUsers }),
      // What a thought has loaded is declared from its next turn on; Pi writes the change into the transcript.
      prepareNextTurnWithContext: ({ context }) => ({ context: { ...context, tools: tools.declared() } }),
      beforeToolCall: async ({ toolCall, args }) => (await this.skipStale(toolCall.name, args)) ?? this.skipRepeated(toolCall.id, toolCall.name, args),
      // A batch ends the thought when every call in it does. Something remembered beside a message sent is part of that reply, not a reason to decide again (ADR-0028).
      afterToolCall: async ({ toolCall, args, isError, result }) => {
        if (isError) return;
        const normalized = await normalizeImageBlocks(result.content, this.agent.state.model);
        const contentPatch = normalized.changed ? { content: normalized.content } : undefined;
        if ((result.details as { noop?: unknown } | undefined)?.noop === true) {
          this.noopCalls.add(toolCall.id);
          return { ...contentPatch, terminate: true };
        }
        if (!stateCheckedTools.has(toolCall.name) && !this.tools.plugins.endsThought(toolCall.name, result.details) && !(toolCall.name === 'read_chat_record' && this.thought.reviewing && !(args as { from?: unknown } | undefined)?.from)) {
          this.repeatedCalls.add(`${toolCall.name}:${stableJson(args)}`);
        }
        if (this.tools.plugins.endsThought(toolCall.name, result.details) || (toolCall.name === 'remember' && this.batch.some(name => this.tools.plugins.endsThought(name, undefined)))) {
          return { ...contentPatch, terminate: true };
        }
        return contentPatch;
      },
      prepareRequest: async ({ context, model: currentModel }, signal) => {
        const first = this.turns === 0;
        // Observations steered in for stale chats have entered by now.
        this.phase = 'preparing'; this.stale.clear(); this.skipped = false;
        this.display(monitor => monitor.preparingRequest());
        ensureCurrent(store, this.thought, signal);
        const runtime = this.runtimeContext(true);
        let messages = [...context.messages];
        // Replies before the newest observation belong to turns already answered; only their actions stay (ADR-0024).
        const latest = messages.findLastIndex(message => message.role === 'observation');
        const foldEarlier = (list: AgentMessage[]) => {
          const dropped = foldNoopCalls(list, this.noopCalls);
          const folded = foldReplies(dropped.messages);
          return { messages: folded.messages, changed: dropped.changed + folded.changed };
        };
        const earlier = foldEarlier(messages.slice(0, Math.max(latest, 0)));
        if (earlier.changed) {
          this.meter.rebase(messages, before => { const at = before.indexOf(messages[latest]!); const cut = at < 0 ? before.length : at; return [...foldEarlier(before.slice(0, cut)).messages, ...before.slice(cut)]; }, modelRoute(currentModel));
          messages = [...earlier.messages, ...messages.slice(latest)];
        }
        const shown = shownRuntimeSnapshot(this.runtimeSnapshot, messages, runtime);
        const view = shown ? carry(runtime, shown, ids => store.activeMemories(ids)) : runtime;
        const update = runtimeUpdate(view, shown);
        if (update) messages.push(runtimeMessage(update));
        this.runtimeSnapshot = view;
        const { budget } = this.budget(currentModel);
        const route = modelRoute(currentModel);
        // Main thoughts use the full budget while idle compaction runs separately.
        // Reviews have no idle period, so still make room on their first request.
        const limit = owner === 'review' && first ? Math.floor(budget * config.compaction.idleRatio) : budget;
        const shrunk = await this.compactor.shrink(messages, limit, budget, currentModel, runtime, signal);
        messages = shrunk.messages;
        if (shrunk.measured.tokens > budget) throw new Error('Required state or the latest observation exceeds the context budget; reduce the batch size or organize pending items.');
        store.log('context_budget', { runId: this.runId, owner, ...shrunk.measured, inputBudget: budget, outputReserveTokens: modelUse(config, owner).limits.outputReserveTokens, safetyTokens: config.limits.contextSafetyTokens });
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
        this.repeatedCalls.clear();
        this.seen.add(event.message.batchId);
        for (const source of event.message.eventIds) this.thought.sources.add(source);
        this.thought.triggers = new Set(event.message.eventIds);
        this.thought.lifeOnly &&= event.message.lifeOnly;
        store.log('observation_entered', { runId: this.runId, batchId: event.message.batchId });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') { this.lastAssistant = event.message; this.finishRequest(event.message); this.phase = 'acting'; this.batch = event.message.content.flatMap(block => block.type === 'toolCall' ? [block.name] : []); }
      if (event.type === 'tool_execution_start') {
        const chat = this.tools.plugins.chatTarget(event.toolName, event.args); if (chat) this.engaged.add(chat);
        // A call to a tool not yet loaded fails as not found; loading it now lets the next turn make the call.
        this.tools.loading.add(event.toolName);
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant' && !['error', 'aborted'].includes(event.message.stopReason)) {
        if (!this.skipped) this.preemptions = 0;
        ensureCurrent(store, this.thought);
        this.meter.observe(this.pendingRequest, event.message, this.pendingRoute);
        store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
        this.completed = { messages: this.agent.state.messages.slice(), seen: [...this.seen], sources: [...this.thought.sources], compactions: this.compactions.length, anchor: this.meter.anchor, turns: (this.completed?.turns ?? 0) + 1 };
        store.log('thought_turn_completed', { runId: this.runId, callId: this.lastCallId, owner, toolCalls: event.toolResults.length, usage: event.message.usage });
      }
    });
  }

  /** A preempted thought takes no more steering while it winds down. */
  get streaming() { return this.agent.state.isStreaming && !this.preempted; }
  private display(update: (monitor: Monitor) => void) { if (this.monitor) { try { update(this.monitor); } catch {} } }
  abort() { this.compactor.cancelBackground(); this.controller.abort(); this.agent.abort(); }
  private instructions() { return systemInstructions(this.config, this.activityPrompts(), this.tools.deferred()); }
  /** Read-only management preview, using this brain's actual tool permissions. */
  activityPrompts() { return this.tools.plugins.activityPrompts(new Set(this.tools.current().map(tool => tool.name))); }

  private chargeCall() {
    this.turns++;
    if (this.config.limits.maxTurnsPerRun !== null && this.turns > this.config.limits.maxTurnsPerRun) throw new Error('The turn limit for this reasoning run has been reached.');
    return this.store.chargeCall(this.runId, this.config.limits.modelCallsPerDay);
  }
  private startRequest(model: Model<any>, purpose: 'thought' | 'review' | 'compaction', attempt?: number): ModelRequest {
    this.activeRequest = { callId: this.chargeCall(), runId: this.runId, owner: this.owner, purpose, provider: model.provider, model: model.id, api: model.api, startedAt: Date.now(), ...(attempt === undefined ? {} : { attempt }) };
    this.store.log('model_request_started', this.activeRequest);
    return this.activeRequest;
  }
  private finishRequest(response?: AssistantMessage, aborted = this.controller.signal.aborted) {
    const request = this.activeRequest;
    if (!request) return;
    this.activeRequest = undefined; this.lastCallId = request.callId;
    this.recordRequestFinished(request, response, aborted);
  }
  private recordRequestFinished(request: ModelRequest, response?: AssistantMessage, aborted = false) {
    const status = response ? response.stopReason === 'aborted' ? 'aborted' : response.stopReason === 'error' ? 'error' : 'success' : aborted ? 'aborted' : 'error';
    const usage = response?.usage;
    const known = usage && (status === 'success' || [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].some(value => value > 0));
    this.store.log('model_request_finished', { ...request, finishedAt: Date.now(), status, stopReason: response?.stopReason, usage: known ? usage : null });
  }
  private budget(model: Model<any>) {
    const { limits } = modelUse(this.config, this.owner);
    const { window, budget } = modelBudget(model, limits.contextTokens, limits.outputReserveTokens, limits.contextSafetyTokens);
    if (budget <= 0) throw new Error('The model window is too small for the output reserve and safety margin.');
    return { window, budget };
  }
  private get contextTokens() { return this.budget(this.agent.state.model).window; }

  private runtimeContext(thinking = false): RuntimeSnapshot {
    return buildRuntimeSnapshot({
      config: this.config, store: this.store, recall: this.recall, observations: this.observations,
      contextTokens: this.contextTokens, thought: this.thought, broughtToMind: this.broughtToMind,
      runId: this.runId, owner: this.owner, thinking,
    });
  }
  private message(observation: Observation) {
    return buildObservationMessage({
      config: this.config, store: this.store, tools: this.tools, model: this.agent.state.model,
      contextTokens: this.contextTokens, thought: this.thought, observation, signal: this.controller.signal,
    });
  }

  private resetContext() {
    this.compactor.cancelBackground();
    this.sessionId = crypto.randomUUID();
    this.agent.sessionId = this.sessionId;
    this.tools.loading.restore([]);
    this.agent.reset(); this.agent.state.tools = this.tools.declared();
    this.agent.state.messages = [createInitialSystemMessage(this.instructions(), this.tools.declared().map(toToolDeclaration))!];
    this.meter.reset(); this.thought.sources.clear(); this.runtimeSnapshot = undefined;
  }
  /** Called only while the runtime has stopped dispatch and drained both brains. */
  refreshTools(): boolean {
    if (this.phase !== 'idle') throw new Error('Cannot replace tools during a thought.');
    const identity = contextIdentity(this.config, this.tools);
    const changed = identity !== this.identity;
    this.identity = identity;
    this.agent.state.tools = this.tools.declared();
    if (changed) { this.resetContext(); this.contextGeneration = -1; }
    return changed;
  }
  private checkpoint(): ContextCheckpoint {
    return {
      identity: this.identity,
      generation: this.contextGeneration,
      messages: this.agent.state.messages.slice(),
      sources: [...this.thought.sources],
      anchor: this.meter.anchor,
      sessionId: this.sessionId,
      route: modelRoute(this.agent.state.model),
    };
  }
  private restore(checkpoint: ContextCheckpoint) {
    const currentRoute = modelRoute(this.agent.state.model);
    const handoff = Boolean(checkpoint.route && checkpoint.route !== currentRoute);
    const restoredMessages = handoff ? portableMessages(checkpoint.messages) : checkpoint.messages;
    this.tools.loading.restore(getCurrentTools(toModelMessages(restoredMessages)).map(tool => tool.name));
    this.agent.reset(); this.agent.state.tools = this.tools.declared();
    this.runtimeSnapshot = undefined;
    this.agent.state.messages = restoredMessages;
    for (const message of restoredMessages) {
      if (message.role === 'user' && typeof message.content === 'string' && message.content.startsWith('<runtime_data>')) {
        const data = JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>'))) as RuntimeSnapshot;
        this.runtimeSnapshot = applyRuntimeUpdate(this.runtimeSnapshot, data);
      }
    }
    if (handoff) {
      this.meter.reset();
      this.sessionId = crypto.randomUUID();
      this.agent.sessionId = this.sessionId;
      this.store.log('context_model_handoff', { owner: this.owner, from: checkpoint.route, to: currentRoute, messages: restoredMessages.length });
    } else {
      this.meter.anchor = checkpoint.anchor;
      if (checkpoint.sessionId) {
        this.sessionId = checkpoint.sessionId;
        this.agent.sessionId = this.sessionId;
      }
    }
    this.contextGeneration = checkpoint.generation;
    this.thought.sources = new Set(checkpoint.sources);
  }
  /** Load the persisted working context unless this process already holds it for the current management state. */
  private prepare(generation: number) {
    if (this.contextGeneration !== generation) {
      this.resetContext();
      const saved = this.store.loadContext(this.identity);
      let restored = false;
      if (saved) { try { this.restore(saved); restored = true; } catch { this.resetContext(); } }
      if (!restored && this.owner === 'main') {
        const seeded = buildSeedTurns({ config: this.config, store: this.store, tools: this.tools, model: this.agent.state.model, budget: this.budget(this.agent.state.model).budget });
        if (seeded.length) this.agent.state.messages = [...this.agent.state.messages, ...seeded];
      }
    }
    this.agent.state.tools = this.tools.declared();
    this.contextGeneration = generation;
  }
  private revert(checkpoint: ContextCheckpoint, generation: number) {
    if (this.store.settings().generation === generation) this.restore(checkpoint);
    else { this.resetContext(); this.thought.sources.clear(); this.contextGeneration = -1; }
  }
  private recoverOverflow() {
    const model = this.agent.state.model;
    return this.compactor.recoverOverflow({
      last: this.lastAssistant,
      preempted: this.preempted,
      signal: this.controller.signal,
      model,
      budget: this.budget(model),
      messages: this.agent.state.messages,
      applyShrunk: shrunk => { this.agent.state.messages = shrunk; this.lastAssistant = undefined; },
      continueRun: () => this.agent.continue(),
    });
  }

  async run(observation: Observation) {
    const generation = this.store.settings().generation;
    this.prepare(generation);
    const rollback = this.checkpoint(); this.compactions = []; this.completed = undefined; this.lastAssistant = undefined;
    this.seen.clear(); this.broughtToMind.clear(); this.repeatedCalls.clear(); this.noopCalls.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    this.engaged = new Set(observation.events.filter(event => !ownEvent(event) && !ambientEvent(event)).map(eventChat).filter((chat): chat is string => chat !== undefined));
    this.stale.clear(); this.preempted = false;
    this.controller = new AbortController();
    // A thought cites what it had in view, not everything the working context has held since it began (ADR-0017).
    this.thought = { generation, sources: new Set(), triggers: new Set(), lifeOnly: true };
    this.display(monitor => monitor.startRun(this.runId, observation));
    let outcome: 'done' | 'error' | 'interrupted' = 'done';
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      await this.recoverOverflow();
      // A preempted thought ends without its unfinished call and is saved like any other (ADR-0002).
      if (this.preempted) this.agent.state.messages = this.agent.state.messages.filter(item => !(item.role === 'assistant' && item.stopReason === 'aborted'));
      else if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      ensureCurrent(this.store, this.thought);
      // The next thought decides again, so a preempted one leaves what it was looking at for it to fold.
      this.fold(!this.preempted);
      if (this.compactor.hasReadySummary) this.agent.state.messages = this.compactor.applyBackground(this.agent.state.messages, this.runtimeContext());
      this.store.saveContext(this.checkpoint(), [...this.seen], this.compactions);
      this.seen.clear();
    }
    catch (error) {
      outcome = this.controller.signal.aborted ? 'interrupted' : 'error';
      // An operator's stop discards the thought (ADR-0002); a failed call undoes nothing the thought already did (ADR-0024).
      if (outcome === 'interrupted' || !this.keepCompleted(generation)) this.revert(rollback, generation);
      throw error;
    }
    finally { this.finishRequest(undefined, this.preempted || this.controller.signal.aborted); this.display(monitor => monitor.endRun(this.preempted ? 'interrupted' : outcome)); this.agent.clearAllQueues(); this.phase = 'idle'; this.preempted = false; }
  }

  /** A memory review runs apart from the conversations, in a working context of its own that starts from runtime state and ends with it; nothing steers into it (ADR-0012). */
  async review(observation: Observation) {
    const generation = this.store.settings().generation;
    this.resetContext(); this.compactions = []; this.lastAssistant = undefined;
    this.seen.clear(); this.broughtToMind.clear(); this.repeatedCalls.clear(); this.noopCalls.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    this.engaged = new Set(); this.stale.clear(); this.preempted = false;
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(), triggers: new Set(), lifeOnly: false, reviewing: true, ...(observation.events.some(event => Array.isArray(event.payload.revisit)) ? { revisiting: true } : {}) };
    this.store.log('review_started', { runId: this.runId, eventIds: observation.events.map(event => event.id) });
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      await this.recoverOverflow();
      if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      this.store.log('review_finished', { runId: this.runId, calls: this.turns });
    }
    finally {
      this.finishRequest();
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
  private preempt(event: EnvironmentEvent, counted = false): boolean {
    if (this.phase !== 'preparing' && this.phase !== 'calling') return false;
    if (!counted) { if (this.preemptions >= this.config.limits.maxPreemptions) return false; this.preemptions++; }
    this.preempted = true;
    this.store.log('thought_preempted', { runId: this.runId, phase: this.phase, eventId: event.id, ...(this.phase === 'calling' ? { callMs: Date.now() - this.callStartedAt } : {}) });
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
  /** Block an identical repeated call within the same thought and observation window so no tool can loop or snowball (ADR-0024). */
  private skipRepeated(callId: string, tool: string, args: unknown): BeforeToolCallResult | undefined {
    if (stateCheckedTools.has(tool) || this.tools.plugins.endsThought(tool, undefined)) return;
    if (tool === 'read_chat_record' && this.thought.reviewing && !(args as { from?: unknown } | undefined)?.from) return;
    const key = `${tool}:${stableJson(args)}`;
    if (!this.repeatedCalls.has(key)) return;
    this.noopCalls.add(callId);
    return { block: true, reason: 'Already called with the same arguments in this thought; end your thought without a tool call if nothing else to do.', terminate: true };
  }
  private fold(everything = true) {
    const options = { everything, noopCalls: this.noopCalls, imageViewer: (label: string) => this.tools.plugins.imageViewer(label) };
    const result = foldThoughtMessages(this.agent.state.messages, options);
    if (!result.changed) return;
    this.store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
    this.meter.rebase(this.agent.state.messages, list => foldThoughtMessages(list, options).messages, modelRoute(this.agent.state.model));
    this.agent.state.messages = result.messages;
    this.store.log('context_folded', { runId: this.runId, ...result.counts });
  }
  /** Save a failed thought as it stood after its last completed turn (ADR-0024). */
  private keepCompleted(generation: number): boolean {
    const completed = this.completed;
    if (!completed || this.store.settings().generation !== generation) return false;
    try {
      this.restore({ identity: this.identity, generation, messages: completed.messages, sources: completed.sources, anchor: completed.anchor });
      ensureCurrent(this.store, this.thought);
      this.fold();
      this.store.saveContext(this.checkpoint(), completed.seen, this.compactions.slice(0, completed.compactions));
      this.store.log('thought_turns_kept', { runId: this.runId, turns: completed.turns, batches: completed.seen.length });
      this.seen.clear();
      return true;
    } catch { return false; }
  }
  /** Persist an idle replacement without acknowledging events or changing an active thought's bookkeeping. */
  private saveIdleContext(messages: AgentMessage[], records: Record<string, unknown>[]) {
    const rollback = this.checkpoint();
    try {
      this.agent.state.messages = messages;
      this.store.saveContext(this.checkpoint(), [], records);
    } catch (error) { this.revert(rollback, rollback.generation); throw error; }
  }
  /** Start one summary of an idle snapshot. It keeps running while new thoughts append to the live context. */
  consolidate(): Promise<void> {
    return this.compactor.consolidate({
      isBusy: () => this.phase !== 'idle' || this.agent.state.isStreaming,
      prepare: generation => this.prepare(generation),
      getModel: () => this.agent.state.model,
      getMessages: () => this.agent.state.messages,
      budget: model => this.budget(model),
      saveIdleContext: (messages, records) => this.saveIdleContext(messages, records),
    });
  }
  async steer(observation: Observation): Promise<boolean> {
    const runId = this.runId;
    if (!this.streaming) return false;
    const addressed = observation.events.filter(event => this.addressed(event));
    // Declined here, the observation returns to pending and starts the next thought.
    if (addressed.length && this.preempt(addressed[0]!)) return false;
    const before = this.preemptions;
    const stale = () => { if (this.preemptions < this.config.limits.maxPreemptions) for (const event of addressed) this.stale.add(eventChat(event)!); };
    stale();
    const message = await this.message(observation);
    // The run may have ended, or another begun, while images were downloading.
    if (!this.streaming || this.runId !== runId) return false;
    // The tools may also have finished meanwhile and the model begun deciding again without this message, which is not yet in its view.
    if (addressed.length && this.preempt(addressed[0]!, this.preemptions > before)) return false;
    stale();
    this.observations.push(...observation.events);
    this.display(monitor => monitor.observation(observation));
    this.agent.steer(message); return true;
  }
}
