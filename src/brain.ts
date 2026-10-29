import { Agent, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModelBackend } from './model.js';
import { createInitialSystemMessage, normalizeContext, toToolDeclaration, type ImageContent, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { Monitor } from './monitor.js';
import type { Action, EnvironmentEvent, Memory, MemoryKind, Observation } from './domain.js';
import { developmentKinds, errorText } from './domain.js';
import { Store, digest } from './store.js';
import { publicFetch } from './web.js';
import { ensureCurrent, type ThoughtContext, type ToolSet } from './tools.js';
import { compactionSplit, contextRecordId, estimatedContextTokens, estimateTokens, fitLines, foldToolResults, IMAGE_TOKENS, pruneToolResults, SUMMARY_PREFIX, textTokens, TokenMeter, toModelMessages, type ContextCheckpoint, type TokenMeasurement } from './context.js';
import { actionSummary, applyRuntimeUpdate, runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';
import { recordTime } from './record.js';

/** Actual online activities offered at life wakes; nothing pushes them, so they only happen when chosen. */
const onlineActivities: { activity: string; tools: string[]; memoryKind?: MemoryKind }[] = [
  { activity: "Browse friends' Qzone feeds", tools: ['get_qzone_feeds'] },
  { activity: "Like or comment on someone's Qzone post", tools: ['like_qzone', 'comment_qzone'] },
  { activity: 'Check comments on your own Qzone posts', tools: ['get_qzone_msg_list', 'get_qzone_msg_detail'] },
  { activity: 'Post to your Qzone', tools: ['send_qzone_msg'] },
  { activity: 'Browse and like recommended Qzone posts', tools: ['get_qzone_public_feeds', 'get_qzone_public_feed_detail', 'get_qzone_public_comments', 'get_qzone_public_replies', 'set_qzone_public_like', 'set_qzone_public_comment_like'] },
  { activity: 'Browse, like, comment on, or add to group albums', tools: ['get_group_album_list', 'get_group_album_media_list', 'set_group_album_media_like', 'do_group_album_comment', 'upload_image_to_qun_album'] },
  { activity: 'Check in to a group', tools: ['set_group_sign', 'get_group_signed_list'] },
  { activity: "Like a friend's QQ profile", tools: ['send_like'] },
  { activity: 'Start a private chat with or poke someone you know', tools: ['send_private_msg', 'friend_poke', 'send_poke'] },
  { activity: 'Change your QQ signature', tools: ['set_self_longnick'] },
  { activity: 'Set a custom online status', tools: ['set_diy_online_status'] },
  { activity: 'Change your avatar, nickname, Qzone name or description, or group card', tools: ['set_qq_avatar', 'set_qq_profile', 'set_qzone_profile', 'set_group_card'] },
  { activity: 'Collect or organize saved stickers', tools: ['add_custom_face', 'modify_custom_face', 'delete_custom_face'] },
  { activity: 'Write or reread your diary', tools: ['remember', 'recall'], memoryKind: 'note' },
  { activity: 'Search or read something online', tools: ['search_web', 'read_webpage'] },
];
/** The summarized text of a continuity summary, without its framing line and record references. */
function summaryBody(message: AgentMessage) {
  if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(SUMMARY_PREFIX)) return;
  const body = message.content.slice(message.content.indexOf('\n') + 1);
  const end = body.lastIndexOf('\nOriginal record IDs: ');
  return end < 0 ? body : body.slice(0, end);
}
const reviewing = (observation: Observation) => observation.events.some(event => event.kind === 'memory_maintenance');
const experienceKind = (tool: string) => tool === 'search_web' ? 'search' : tool === 'read_webpage' ? 'reading' : `snowluma:${tool}`;
// Self-presentation the agent sets and later sees as current state.
const currentValue: Record<string, (args: Record<string, unknown>) => unknown> = { set_self_longnick: args => args.longNick ?? args.long_nick, set_diy_online_status: args => args.wording };

interface ObservationMessage { role: 'observation'; batchId: string; content: (TextContent | ImageContent)[]; eventIds: string[]; lifeOnly: boolean; timestamp: number }
declare module '@earendil-works/pi-agent-core' { interface CustomAgentMessages { observation: ObservationMessage } }
export interface Brain {
  readonly streaming: boolean;
  readonly thought: ThoughtContext;
  run(observation: Observation): Promise<void>;
  steer(observation: Observation): Promise<boolean>;
  consolidate(): Promise<void>;
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
  private readonly stream: StreamFn;
  constructor(private config: Config, private store: Store, private tools: ToolSet, backend?: { model: Model<any>; stream: StreamFn }, private monitor?: Monitor) {
    const { model, stream } = backend ?? createModelBackend(config.model);
    this.stream = stream;
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
        const first = this.turns === 0;
        ensureCurrent(store, this.thought, signal);
        const runtime = this.runtimeContext();
        let messages = [...context.messages];
        const update = runtimeUpdate(runtime, this.runtimeSnapshot);
        if (update) messages.push(this.runtimeMessage(update));
        this.runtimeSnapshot = runtime;
        const { window, budget } = this.budget(currentModel);
        const route = this.route(currentModel);
        let measured: TokenMeasurement;
        // The first request leaves room for the observations steered in after it; later ones may fill the budget.
        const limit = first ? Math.floor(budget * config.compaction.idleRatio) : budget;
        ({ messages, measured } = await this.shrink(messages, limit, budget, window, currentModel, runtime, signal));
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
        store.log('observation_entered', { runId: this.runId, batchId: event.message.batchId });
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
    return legacy ? base : base + `\nruntime_data format=snapshot represents the complete current state; format=delta contains only changed fields, and omitted fields retain their previous values. Apply upserts by id and remove removedIds in recentEvents, recalled, actualActions, activeCommitmentsAndPlans, myHabits, practices, and impressions. Replace other fields directly. Action summaries omit internal provenance; use inspect_actions with an id for full evidence. Heartbeats are saved as connection records.
Your development is yours to keep alongside the operator's persona. Habits are your own ways of acting and expressing yourself, including your own expression style. Practices are what people in a group do in which situations: how long and how often they write, slang, stickers and reactions, joining chains, or anything else you notice. An impression is your current understanding of one person and your relationship with them. runtime_data supplies myHabits, practices, and impressions for the current settings and people. Knowing a practice does not mean adopting it, and the persona above takes precedence over your habits where they disagree. Each scope has a size limit: merge with supersedes or retire with retire_memory instead of piling entries up. A habit or impression cannot rest only on your own messages. When a memory_maintenance event lists unreviewed chats, read them with read_chat_record and revise your development from what you see.`;
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
  private budget(model: Model<any>) {
    const window = Math.min(this.config.limits.contextTokens, model.contextWindow);
    const budget = window - this.config.limits.outputReserveTokens - this.config.limits.contextSafetyTokens;
    if (budget <= 0) throw new Error('The model window is too small for the output reserve and safety margin.');
    return { window, budget };
  }
  /** Bring the context under limit: prune old tool results first, and summarize older exchanges only if that is not enough. */
  private async shrink(messages: AgentMessage[], limit: number, budget: number, window: number, model: Model<any>, runtime: RuntimeSnapshot, signal?: AbortSignal) {
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
      try { messages = await this.compact(messages, budget, window, model, this.stream, signal); }
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
  private async compact(messages: AgentMessage[], budget: number, window: number, model: Model<any>, stream: StreamFn, signal?: AbortSignal): Promise<AgentMessage[]> {
    const summaryLimit = this.config.compaction.summaryMaxTokens;
    const { system, removed, kept } = compactionSplit(messages, Math.min(this.config.compaction.keepRecentTokens, budget), budget, summaryLimit + 100);
    if (!removed.length) throw new Error('No older exchanges can be safely compacted; reduce the latest input or increase the context budget.');
    const ids = this.store.archiveContext(removed, [...this.thought.sources]);
    const framing = `${SUMMARY_PREFIX} (historical material; use read_context to retrieve originals):\n`;
    const references = `\nOriginal record IDs: ${ids.slice(-8).join(', ')}`;
    const outputLimit = summaryLimit - textTokens(framing + references) - 16;
    if (outputLimit < 64) throw new Error('The summary token limit is too small to retain the required source references.');
    // Models cannot count their own tokens; aiming well below the cut-off leaves room to finish.
    const target = Math.floor(outputLimit * 0.6);
    const instructions = `Internal working context consolidation: Produce a brief continuity summary for the same digital life, aiming for about ${target} tokens (Chinese runs about one token per character); output stops at ${outputLimit}. Summarize only the first ${removed.length} older messages after the system message. An existing summary among them is material to condense, not a prefix to keep: the limit covers it too, so merge it in and shorten it, dropping what is settled, superseded, or already saved with remember. Put the most important first; if output stops early, only the end is lost. If recent exchanges follow, use them only to correct outdated judgments; their originals are retained separately. Do not call tools or take external action. Preserve people, times, group or private settings, changes in relationship impressions and their evidence, current topics, unfinished matters, and actual action outcomes. Distinguish reported claims, inferences, fiction, success, failure, and unknown outcomes. Old state may be outdated; follow later runtime_data. Update outdated judgments in existing summaries. Use read_context to retrieve originals when needed; older records include ${ids.slice(-12).join(', ')}. Retain relevant source IDs and necessary ctx: record IDs in the summary.`;
    const directive: Message = { role: 'user', content: instructions, timestamp: Date.now() };
    // Reuse the complete warm prefix when it fits; the old prefix remains a fallback for oversized new input.
    let request: AgentMessage[] = [system, ...removed, ...kept, directive];
    const fits = (candidate: AgentMessage[]) => this.meter.measure(candidate, this.route(model)).tokens + summaryLimit + this.config.limits.contextSafetyTokens <= window;
    const includedRecentContext = fits(request);
    if (!includedRecentContext) request = [system, ...removed, directive];
    const sized = includedRecentContext || fits(request);
    const replacement = (text: string) => {
      const summary: Message = { role: 'user', content: framing + text + references, timestamp: Date.now() };
      const compacted = [system, summary, ...kept];
      const before = estimatedContextTokens(messages); const after = estimatedContextTokens(compacted);
      return after < before && after <= budget ? { summary, compacted, before, after } : undefined;
    };
    let result: ReturnType<typeof replacement>; let truncated = false; let transient = false;
    let failure = 'The history to consolidate exceeds the context budget; a continuity summary cannot be generated safely.';
    for (let attempt = 0; sized && !result && attempt <= this.config.compaction.retries; attempt++) {
      ensureCurrent(this.store, this.thought, signal);
      this.chargeCall();
      const response = await (await stream(model, normalizeContext({ messages: toModelMessages(request) }), { apiKey: process.env[this.config.model.apiKeyEnv], signal, maxTokens: Math.min(outputLimit, model.maxTokens) })).result();
      ensureCurrent(this.store, this.thought, signal);
      this.store.log('context_summary_completed', { runId: this.runId, attempt, usage: response.usage, stopReason: response.stopReason });
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
    this.compactions.push({ runId: this.runId, beforeTokens: result.before, afterTokens: result.after, removedMessages: removed.length, includedRecentContext, ...(truncated ? { truncated } : {}), ...(failure ? { setAside: failure } : {}), firstKeptRecordId: kept[0] ? contextRecordId(kept[0]) : undefined, summaryRecordId: contextRecordId(result.summary) });
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
    // Development is supplied by scope below, so recall leaves it out.
    const recalled = this.store.search(query, this.config.memory.recallLimit, subjects, groups, false, developmentKinds);
    for (const source of [...recent, ...recalled]) this.thought.sources.add(source.id);
    const people = [...new Set(this.observations.map(event => event.actorId).filter((id): id is number => id !== undefined && id !== this.config.snowluma.selfId).reverse())].slice(0, this.config.development.people);
    const development = this.store.development(['global', ...new Set(groups.map(id => `group:${id}`)), ...people.map(id => `person:${id}`)]);
    const entries = (kind: MemoryKind) => development.filter(memory => memory.kind === kind).map((memory: Memory) => ({ id: memory.id, scope: memory.scope, title: memory.title, content: memory.content }));
    const runtime = { now: new Date().toISOString(), timeZone: 'Asia/Shanghai', selfId: this.config.snowluma.selfId, settings: this.store.settings(), allowFiction: this.config.life.allowFiction, historyGroups: this.config.snowluma.groups, snowlumaPermissions: this.config.snowluma.tools, activeCommitmentsAndPlans: this.store.wakes(), recentEvents: recent.map(event => ({ id: event.id, kind: event.kind, at: event.at, groupId: event.groupId, actorId: event.actorId, text: event.text.slice(0, 400), truncated: event.text.length > 400 })), recalled: recalled.map(memory => ({ ...memory, content: memory.content.slice(0, 2000), truncated: memory.content.length > 2000 })), actualActions: this.store.actions(10).map(action => actionSummary(action)), myHabits: entries('habit'), practices: entries('practice'), impressions: entries('impression') };
    // Commitments, current activity, and development are never selected by probabilistic recall.
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recentEvents.length) runtime.recentEvents.shift();
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recalled.length) runtime.recalled.pop();
    return runtime;
  }
  private async message(observation: Observation): Promise<ObservationMessage> {
    const preview = Math.max(80, Math.min(2000, Math.floor(this.config.limits.contextTokens / (observation.events.length * 8))));
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `New environment observations (use read_event to read truncated content):\n${JSON.stringify(observation.events.map(event => displayEvent(event, preview)))}` }];
    const online = observation.events.some(event => event.kind === 'wake' && event.payload.wakeKind === 'life') && this.onlineLife();
    if (online) content.push({ type: 'text', text: online });
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
  /** When each available online activity was last done, so a life wake knows what it can actually do. */
  private onlineLife() {
    const available = new Set(this.tools.current().map(tool => tool.name));
    const activities = onlineActivities.map(item => ({ ...item, tools: item.tools.filter(name => available.has(name)) })).filter(item => item.tools.length);
    if (!activities.length) return;
    const last = this.store.lastExperienced(activities.flatMap(item => item.tools.map(experienceKind)));
    const status = activities.map(({ activity, tools, memoryKind }) => {
      const at = memoryKind ? this.store.lastMemoryAt(memoryKind) ?? 0 : Math.max(0, ...tools.map(name => last[experienceKind(name)] ?? 0));
      const setter = tools.find(name => currentValue[name]);
      const args = setter && this.store.lastSuccessfulAction(setter)?.args;
      const current = args ? currentValue[setter!]!(args) : undefined;
      return { activity, tools, lastDone: at ? new Date(at).toISOString() : `not in the last ${this.config.memory.retentionDays} days`, ...(current !== undefined ? { lastSetTo: current } : {}) };
    });
    return `Online activities available for your own life, with when you last did each; a record, not a to-do list. Life activities can be actual online activities like these, not only fictional daily life. Qzone posts, likes, and comments are never pushed to you; you only see them by checking. Use load_snowluma_tools for the parameters of unfamiliar tools.\n${JSON.stringify(status)}`;
  }
  /** Load the persisted working context unless this process already holds it for the current management state. */
  private prepare(generation: number) {
    if (this.contextGeneration !== generation) {
      this.resetContext();
      const saved = this.store.loadContext(this.identity) ?? this.store.loadContext(this.legacyIdentity);
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
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: true, reviewing: reviewing(observation) };
    this.display(monitor => monitor.startRun(this.runId, observation));
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      ensureCurrent(this.store, this.thought);
      this.fold();
      this.store.saveContext(this.checkpoint(), [...this.seen], this.compactions);
      this.seen.clear();
    }
    catch (error) { this.revert(rollback, generation); throw error; }
    finally { this.agent.clearAllQueues(); this.display(monitor => monitor.endRun()); }
  }
  /** Chat records read in a thought leave working context when it ends. They sit at its tail, so the cached prefix before them stays valid. */
  private fold() {
    const folded = foldToolResults(this.agent.state.messages, 'read_chat_record');
    if (!folded.changed) return;
    this.store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
    this.agent.state.messages = folded.messages;
    this.store.log('context_folded', { runId: this.runId, results: folded.changed });
  }
  /** Between runs, compact a context above compaction.idleRatio of its budget; the first request of a run does the same, later ones compact at the full budget. */
  async consolidate() {
    const generation = this.store.settings().generation;
    this.prepare(generation);
    const model = this.agent.state.model;
    const { window, budget } = this.budget(model);
    const limit = Math.floor(budget * this.config.compaction.idleRatio);
    if (this.meter.measure(this.agent.state.messages, this.route(model)).tokens <= limit) return;
    const rollback = this.checkpoint(); this.compactions = [];
    this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [];
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: false };
    try {
      const { messages } = await this.shrink(this.agent.state.messages.slice(), limit, budget, window, model, this.runtimeContext(), this.controller.signal);
      this.agent.state.messages = messages;
      this.store.saveContext(this.checkpoint(), [], this.compactions);
    } catch (error) { this.revert(rollback, generation); throw error; }
  }
  async steer(observation: Observation): Promise<boolean> {
    const runId = this.runId;
    const message = await this.message(observation);
    // The run may have ended, or another begun, while images were downloading.
    if (!this.streaming || this.runId !== runId) return false;
    this.observations.push(...observation.events);
    this.thought.reviewing ||= reviewing(observation);
    this.display(monitor => monitor.observation(observation));
    this.agent.steer(message); return true;
  }
}
