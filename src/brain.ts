import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModelBackend } from './model.js';
import { createInitialSystemMessage, normalizeContext, toToolDeclaration, type ImageContent, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { Monitor } from './monitor.js';
import type { Action, EnvironmentEvent, Observation } from './domain.js';
import { Store, digest } from './store.js';
import { publicFetch } from './web.js';
import { ensureCurrent, type ThoughtContext, type ToolSet } from './tools.js';
import { compactionSplit, contextRecordId, estimatedContextTokens, estimateTokens, IMAGE_TOKENS, pruneToolResults, SUMMARY_PREFIX, textTokens, TokenMeter, toModelMessages, type ContextCheckpoint } from './context.js';
import { actionSummary, applyRuntimeUpdate, runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';

interface ObservationMessage { role: 'observation'; batchId: string; content: (TextContent | ImageContent)[]; eventIds: string[]; lifeOnly: boolean; timestamp: number }
declare module '@earendil-works/pi-agent-core' { interface CustomAgentMessages { observation: ObservationMessage } }
export interface Brain {
  readonly streaming: boolean;
  readonly thought: ThoughtContext;
  run(observation: Observation): Promise<void>;
  steer(observation: Observation): Promise<boolean>;
  abort(): void;
}

export function displayEvent(event: EnvironmentEvent, preview = 2000) {
  const compact = (value: unknown) => { const text = JSON.stringify(value); return text && text.length > preview ? { preview: text.slice(0, preview), truncated: true } : value; };
  return { id: event.id, kind: event.kind, at: new Date(event.at).toISOString(), groupId: event.groupId, actorId: event.actorId, postType: event.payload.post_type, messageType: event.payload.message_type, subType: event.payload.sub_type, targetId: event.payload.target_id, sender: compact(event.payload.sender), text: event.text.slice(0, preview), truncated: event.text.length > preview, messageId: event.payload.message_id, segments: event.kind === 'message' ? compact(event.payload.message) : undefined, notice: event.kind.startsWith('notice:') ? compact(event.payload) : undefined, details: event.payload.post_type && event.kind !== 'message' && !event.kind.startsWith('notice:') ? compact(event.payload) : undefined, wake: event.kind === 'wake' ? event.payload : undefined };
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
  private readonly identity: string;
  private readonly legacyIdentity: string;
  private pendingRequest: AgentMessage[] = [];
  private pendingRoute = '';
  private compactions: Record<string, unknown>[] = [];
  constructor(private config: Config, private store: Store, private tools: ToolSet, backend?: { model: Model<any>; stream: StreamFn }, private monitor?: Monitor) {
    const { model, stream } = backend ?? createModelBackend(config.model);
    if (!model.input.includes('image')) throw new Error('Select a model that supports image input.');
    this.identity = digest({ instructions: this.instructions(), model: config.model, selfId: config.snowluma.selfId, tools: tools.current().map(toToolDeclaration) });
    this.legacyIdentity = digest({ instructions: this.instructions(true), model: config.model, selfId: config.snowluma.selfId, tools: tools.current().map(toToolDeclaration) });
    this.agent = new Agent({
      initialState: { model: config.model.baseUrl ? { ...model, baseUrl: config.model.baseUrl } : model, systemPrompt: this.instructions(), tools: tools.current(), thinkingLevel: 'off' },
      streamFn: (target, context, options) => stream(target, context, { ...options, maxTokens: Math.min(config.limits.outputReserveTokens, target.maxTokens) }),
      getApiKey: () => process.env[config.model.apiKeyEnv], toolExecution: 'sequential', steeringMode: 'all',
      convertToLlm: toModelMessages,
      prepareNextTurnWithContext: ({ context }) => ({ context: { ...context, tools: tools.current() } }),
      prepareRequest: async ({ context, model: currentModel }, signal) => {
        ensureCurrent(store, this.thought, signal);
        const runtime = this.runtimeContext();
        let messages = [...context.messages];
        const update = runtimeUpdate(runtime, this.runtimeSnapshot);
        if (update) messages.push(this.runtimeMessage(update));
        this.runtimeSnapshot = runtime;
        const window = Math.min(config.limits.contextTokens, currentModel.contextWindow);
        const budget = window - config.limits.outputReserveTokens - config.limits.contextSafetyTokens;
        if (budget <= 0) throw new Error('The model window is too small for the output reserve and safety margin.');
        const route = this.route(currentModel);
        let measured = this.meter.measure(messages, route);
        const before = measured.tokens;
        if (measured.tokens > budget) {
          store.archiveContext(messages, [...this.thought.sources]);
          const recentTokens = Math.min(config.compaction.keepRecentTokens, budget);
          const pruned = pruneToolResults(messages, recentTokens);
          messages = pruned.messages;
          measured = this.meter.measure(messages, route);
          if (pruned.changed) store.log('context_pruned', { runId: this.runId, results: pruned.changed, beforeTokens: before, afterTokens: measured.tokens });
          if (measured.tokens > budget) {
            // A delta may depend on a base that compaction removes. Keep a complete current state.
            const snapshot = this.runtimeMessage(runtimeUpdate(runtime)!);
            const latest = messages.at(-1);
            if (!(latest?.role === 'user' && latest.content === snapshot.content)) messages.push(snapshot);
            messages = await this.compact(messages, budget, window, currentModel, stream, signal);
            measured = this.meter.measure(messages, route);
          }
        }
        if (measured.tokens > budget) throw new Error('Required state or the latest observation exceeds the context budget; reduce the batch size or organize pending items.');
        store.log('context_budget', { runId: this.runId, ...measured, inputBudget: budget, outputReserveTokens: config.limits.outputReserveTokens, safetyTokens: config.limits.contextSafetyTokens });
        ensureCurrent(store, this.thought, signal);
        this.chargeCall();
        // Pi keeps its event transcript separately from the prepared request context.
        this.pendingRequest = messages.slice(); this.pendingRoute = route;
        this.agent.state.messages = messages.slice();
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
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant' && !['error', 'aborted'].includes(event.message.stopReason)) {
        ensureCurrent(store, this.thought);
        this.meter.observe(this.pendingRequest, event.message, this.pendingRoute);
        store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
        store.log('thought_turn_completed', { runId: this.runId, toolCalls: event.toolResults.length, usage: event.message.usage });
      }
    });
  }
  get streaming() { return this.agent.state.isStreaming; }
  private display(update: (monitor: Monitor) => void) { if (this.monitor) { try { update(this.monitor); } catch {} } }
  abort() { this.controller.abort(); this.agent.abort(); }
  private instructions(legacy = false) {
    const base = `You are a digital life with a unified identity and continuing experiences. Group chats, private chats, and other QQ interactions are external settings in your life.
The operator defines your core persona:\n${this.config.persona}\n
Decide whether to participate based on observations, persona, relationships, interests, and current activity. Silence is also an option. selfId is your QQ account; your own messages are feedback on your actions.
Native SnowLuma tools perform QQ operations; your ordinary text is not sent to QQ. Do not output chain of thought. You may end briefly or act through tools.
Each send_group_msg or send_private_msg call sends one message. Line breaks or multiple segments in message still form one message. To send two messages, call the corresponding tool twice in order, with only the relevant content in each call. You need not wait for a reply between messages, but each send must respect the pace of the current setting and actual action receipts.
All enabled SnowLuma interfaces can be called directly using their original names and parameters, including private chats, group members, message deletion, files, emoji, and Qzone. Use search_snowluma_tools to find interfaces and load_snowluma_tools for detailed usage; these queries do not change the tool set. Preserve parameters as provided; file paths belong to the SnowLuma server. Streaming interfaces return ordered arrays of data frames. Both read-only queries and external actions are subject to interface permissions; actions are also subject to budgets and deduplication. Large results retain their source; use read_event to continue reading truncated results. A tool's sourceId can be used with remember or read_event.
New observations can change your activity. Consider the target, setting, and information-sharing scope when acting. historyGroups specifies which groups are checked for missed messages after a disconnect; the operator configures interface permissions. Check action receipts and investigate unknown outcomes first; the runtime handles action identifiers and deduplication.
Distinguish actual experiences, reported claims, inferences, fictional daily life, and tool results. runtime_data provides the life-mode switch; when disabled, stop autonomous life activities, but continue social commitments and memory maintenance.
Decide which experiences are important and save them with remember. When revising an understanding, retain its sources and previous version.
Record what you are doing with set_activity. After accepting a future obligation, save it with schedule_activity as commitment; use life for your own plans. Call finish_activity when a plan is completed or cancelled. You may rest when nothing is pending.
Working context continues across thinking runs; when space is limited, a continuity summary replaces earlier exchanges. runtime_data provides timestamped state and observations; later snapshots update earlier state. Current activity, commitments, and actual action outcomes in the latest snapshot take precedence over old exchanges and summaries. Use recall, read_event, or inspect_actions for detailed evidence. Working context and summaries are persisted; still use remember to save important experiences, understandings, and notes. Use read_context with ctx: record IDs in the summary to read pre-compaction originals in chunks. A memory_maintenance event means it is time to organize your memories.`;
    return legacy ? base : base + '\nruntime_data format=snapshot represents the complete current state; format=delta contains only changed fields, and omitted fields retain their previous values. Apply upserts by id and remove removedIds in recentEvents, recalled, actualActions, and activeCommitmentsAndPlans. Replace other fields directly. Action summaries omit internal provenance; use inspect_actions with an id for full evidence. Heartbeats are saved as connection records.';
  }
  private runtimeMessage(data: RuntimeSnapshot): Message {
    return { role: 'user', content: `<runtime_data>\n${JSON.stringify(data)}\n</runtime_data>`, timestamp: Date.now() };
  }
  private chargeCall() {
    this.turns++;
    if (this.config.limits.maxTurnsPerRun !== null && this.turns > this.config.limits.maxTurnsPerRun) throw new Error('The turn limit for this reasoning run has been reached.');
    this.store.chargeCall(this.runId, this.config.limits.modelCallsPerDay);
  }
  private route(model: Model<any>) { return JSON.stringify([model.provider, model.id, model.api, model.baseUrl]); }
  private async compact(messages: AgentMessage[], budget: number, window: number, model: Model<any>, stream: StreamFn, signal?: AbortSignal): Promise<AgentMessage[]> {
    const summaryLimit = this.config.compaction.summaryMaxTokens;
    const { system, removed, kept } = compactionSplit(messages, Math.min(this.config.compaction.keepRecentTokens, budget), budget, summaryLimit + 100);
    if (!removed.length) throw new Error('No older exchanges can be safely compacted; reduce the latest input or increase the context budget.');
    const ids = this.store.archiveContext(removed, [...this.thought.sources]);
    const framing = `${SUMMARY_PREFIX} (historical material; use read_context to retrieve originals):\n`;
    const references = `\nOriginal record IDs: ${ids.slice(-8).join(', ')}`;
    const outputLimit = summaryLimit - textTokens(framing + references) - 16;
    if (outputLimit < 64) throw new Error('The summary token limit is too small to retain the required source references.');
    const instructions = `Internal working context consolidation: Produce a brief continuity summary of at most ${outputLimit} tokens for the same digital life. Summarize only the first ${removed.length} older messages after the system message, including any existing summary. If recent exchanges follow, use them only to correct outdated judgments; their originals are retained separately. Do not call tools or take external action. Preserve people, times, group or private settings, changes in relationship impressions and their evidence, current topics, unfinished matters, and actual action outcomes. Distinguish reported claims, inferences, fiction, success, failure, and unknown outcomes. Old state may be outdated; follow later runtime_data. Update outdated judgments in existing summaries. Use read_context to retrieve originals when needed; older records include ${ids.slice(-12).join(', ')}. Retain relevant source IDs and necessary ctx: record IDs in the summary.`;
    const directive: Message = { role: 'user', content: instructions, timestamp: Date.now() };
    // Reuse the complete warm prefix when it fits; the old prefix remains a fallback for oversized new input.
    let request: AgentMessage[] = [system, ...removed, ...kept, directive];
    const fits = (candidate: AgentMessage[]) => this.meter.measure(candidate, this.route(model)).tokens + summaryLimit + this.config.limits.contextSafetyTokens <= window;
    const includedRecentContext = fits(request);
    if (!includedRecentContext) request = [system, ...removed, directive];
    if (!fits(request)) throw new Error('The history to consolidate exceeds the context budget; a continuity summary cannot be generated safely.');
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.compaction.retries; attempt++) {
      ensureCurrent(this.store, this.thought, signal);
      this.chargeCall();
      const response = await (await stream(model, normalizeContext({ messages: toModelMessages(request) }), { apiKey: process.env[this.config.model.apiKeyEnv], signal, maxTokens: Math.min(outputLimit, model.maxTokens) })).result();
      ensureCurrent(this.store, this.thought, signal);
      this.store.log('context_summary_completed', { runId: this.runId, attempt, usage: response.usage, stopReason: response.stopReason });
      try {
        if (response.stopReason !== 'stop' || response.content.some(item => item.type === 'toolCall')) throw new Error(`The continuity summary was not generated completely: ${response.errorMessage ?? response.stopReason}`);
        const text = response.content.filter((item): item is TextContent => item.type === 'text').map(item => item.text).join('\n').trim();
        if (!text || textTokens(text) > outputLimit) throw new Error('The continuity summary is empty or exceeds the token budget.');
        const summary: Message = { role: 'user', content: framing + text + references, timestamp: Date.now() };
        const compacted = [system, summary, ...kept];
        const before = estimatedContextTokens(messages); const after = estimatedContextTokens(compacted);
        if (after >= before || after > budget) throw new Error('The continuity summary did not reduce the context or still exceeds the budget.');
        this.store.archiveContext([summary], [...this.thought.sources]);
        this.meter.reset();
        this.compactions.push({ runId: this.runId, beforeTokens: before, afterTokens: after, removedMessages: removed.length, includedRecentContext, firstKeptRecordId: kept[0] ? contextRecordId(kept[0]) : undefined, summaryRecordId: contextRecordId(summary) });
        return compacted;
      } catch (error) { lastError = error; }
    }
    throw lastError;
  }
  private resetContext() {
    this.agent.reset(); this.agent.state.tools = this.tools.current();
    this.agent.state.messages = [createInitialSystemMessage(this.instructions(), this.tools.current().map(toToolDeclaration))!];
    this.meter.reset(); this.thought.sources.clear(); this.runtimeSnapshot = undefined;
  }
  private checkpoint(): ContextCheckpoint {
    return { identity: this.identity, generation: this.contextGeneration, messages: this.agent.state.messages.slice(), sources: [...this.thought.sources], anchor: this.meter.anchor };
  }
  private restore(checkpoint: ContextCheckpoint) {
    this.agent.reset(); this.agent.state.tools = this.tools.current();
    this.runtimeSnapshot = undefined;
    let migrated = checkpoint.identity !== this.identity;
    this.agent.state.messages = checkpoint.messages.flatMap((message): AgentMessage[] => {
      if (message.role === 'system' && checkpoint.identity !== this.identity && message.content === this.instructions(true)) return [{ ...message, content: this.instructions() }];
      if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith('<runtime_data>')) return [message];
      const data = JSON.parse(message.content.slice('<runtime_data>'.length, message.content.lastIndexOf('</runtime_data>'))) as RuntimeSnapshot;
      if (!data.format) {
        // Upgrade the previous snapshot format without losing conversation or archived originals.
        const current = { ...data, actualActions: (data.actualActions as Action[]).map(action => actionSummary(action)) };
        const update = runtimeUpdate(current, this.runtimeSnapshot);
        this.runtimeSnapshot = current; migrated = true;
        return update ? [{ ...this.runtimeMessage(update), timestamp: message.timestamp }] : [];
      }
      this.runtimeSnapshot = applyRuntimeUpdate(this.runtimeSnapshot, data);
      return [message];
    });
    this.meter.anchor = migrated ? undefined : checkpoint.anchor;
    this.contextGeneration = checkpoint.generation;
    this.thought.sources = new Set(checkpoint.sources);
  }
  private runtimeContext() {
    const subjects = this.observations.map(event => String(event.actorId ?? '')).filter(Boolean);
    const groups = this.observations.map(event => event.groupId).filter((x): x is number => x !== undefined);
    const query = this.observations.map(event => event.text).join(' ').slice(-1000);
    const recent = this.store.recent(this.config.memory.recentEvents);
    const recalled = this.store.search(query, this.config.memory.recallLimit, subjects, groups);
    for (const source of [...recent, ...recalled]) this.thought.sources.add(source.id);
    const runtime = { now: new Date().toISOString(), timeZone: 'Asia/Shanghai', selfId: this.config.snowluma.selfId, settings: this.store.settings(), allowFiction: this.config.life.allowFiction, historyGroups: this.config.snowluma.groups, snowlumaPermissions: this.config.snowluma.tools, activeCommitmentsAndPlans: this.store.wakes(), recentEvents: recent.map(event => ({ id: event.id, kind: event.kind, at: event.at, groupId: event.groupId, actorId: event.actorId, text: event.text.slice(0, 400), truncated: event.text.length > 400 })), recalled: recalled.map(memory => ({ ...memory, content: memory.content.slice(0, 2000), truncated: memory.content.length > 2000 })), actualActions: this.store.actions(10).map(action => actionSummary(action)) };
    // Commitments and current activity are never selected by probabilistic recall.
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recentEvents.length) runtime.recentEvents.shift();
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recalled.length) runtime.recalled.pop();
    return runtime;
  }
  private async message(observation: Observation): Promise<ObservationMessage> {
    const preview = Math.max(80, Math.min(2000, Math.floor(this.config.limits.contextTokens / (observation.events.length * 8))));
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `New environment observations (use read_event to read truncated content):\n${JSON.stringify(observation.events.map(event => displayEvent(event, preview)))}` }];
    let count = 0;
    for (const event of observation.events) for (const segment of Array.isArray(event.payload.message) ? event.payload.message : []) {
      if (segment.type !== 'image') continue;
      if (count++ >= this.config.limits.maxImages || estimateTokens(content.filter(item => item.type !== 'image')) + count * IMAGE_TOKENS > this.config.limits.contextTokens * 0.4) {
        content.push({ type: 'text', text: `The image from event ${event.id} was not loaded due to the context limit; use view_event_image to view it.` }); continue;
      }
      const url = segment.data?.url;
      if (typeof url !== 'string') { content.push({ type: 'text', text: `The image in event ${event.id} has no readable URL; the original event is retained.` }); continue; }
      try {
        const image = await publicFetch(url, { timeoutMs: 10_000, maxBytes: 5_000_000, signal: this.controller.signal });
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.type)) throw new Error('Unsupported image type');
        content.push({ type: 'text', text: `The following image is from event ${event.id}` }, { type: 'image', data: image.data.toString('base64'), mimeType: image.type });
      } catch { content.push({ type: 'text', text: `The image in event ${event.id} could not be read` }); }
    }
    return { role: 'observation', batchId: observation.batchId, eventIds: observation.events.map(event => event.id), lifeOnly: observation.events.every(event => event.kind === 'wake' && event.payload.wakeKind === 'life'), content, timestamp: Date.now() };
  }
  async run(observation: Observation) {
    const generation = this.store.settings().generation;
    const fresh = this.contextGeneration !== generation;
    if (fresh) {
      this.resetContext();
      const saved = this.store.loadContext(this.identity) ?? this.store.loadContext(this.legacyIdentity);
      if (saved) { try { this.restore(saved); } catch { this.resetContext(); } }
    }
    this.agent.state.tools = this.tools.current();
    this.contextGeneration = generation;
    const rollback = this.checkpoint(); this.compactions = [];
    this.seen.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: true };
    this.display(monitor => monitor.startRun(this.runId, observation));
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      ensureCurrent(this.store, this.thought);
      this.store.saveContext(this.checkpoint(), [...this.seen], this.compactions);
      this.seen.clear();
    }
    catch (error) {
      if (this.store.settings().generation === generation) this.restore(rollback);
      else { this.resetContext(); this.thought.sources.clear(); this.contextGeneration = -1; }
      throw error;
    }
    finally { this.agent.clearAllQueues(); this.display(monitor => monitor.endRun()); }
  }
  async steer(observation: Observation): Promise<boolean> {
    const message = await this.message(observation);
    if (!this.streaming) return false;
    this.observations.push(...observation.events);
    this.display(monitor => monitor.observation(observation));
    this.agent.steer(message); return true;
  }
}
