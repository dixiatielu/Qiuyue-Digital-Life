import { Agent, type AgentMessage, type BeforeToolCallResult, type StreamFn } from '@earendil-works/pi-agent-core';
import { createModelBackend } from './model.js';
import { createInitialSystemMessage, normalizeContext, toToolDeclaration, type ImageContent, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { Monitor } from './monitor.js';
import type { Action, EnvironmentEvent, Memory, MemoryKind, Observation } from './domain.js';
import { errorText, eventChat, isAmbient } from './domain.js';
import { Store, conversationOf, digest } from './store.js';
import { fetchImage } from './web.js';
import { ensureCurrent, type ThoughtContext, type ToolSet } from './tools.js';
import { compactionSplit, contextRecordId, estimatedContextTokens, estimateTokens, fitLines, foldImages, foldToolResults, IMAGE_TOKENS, pruneToolResults, SUMMARY_PREFIX, textTokens, TokenMeter, toModelMessages, type ContextCheckpoint, type TokenMeasurement } from './context.js';
import { actionSummary, applyRuntimeUpdate, runtimeUpdate, type RuntimeSnapshot } from './runtime-context.js';
import { recordTime } from './record.js';
import { faceCaption, faceIds, nameFaces } from './faces.js';
import type { SemanticRecall } from './recall.js';

/** Actual online activities offered at life wakes; nothing pushes them, so they only happen when chosen. A new platform joins the digital life's days by adding its tools here. */
const onlineActivities: { activity: string; tools: string[]; memoryKind?: MemoryKind }[] = [
  { activity: "Browse friends' Qzone feeds", tools: ['get_qzone_feeds'] },
  { activity: "Like or comment on someone's Qzone post", tools: ['like_qzone', 'comment_qzone'] },
  { activity: 'Check comments on your own Qzone posts', tools: ['get_qzone_msg_list', 'get_qzone_msg_detail'] },
  { activity: 'Post to your Qzone', tools: ['send_qzone_msg'] },
  { activity: 'Browse and like recommended Qzone posts', tools: ['get_qzone_public_feeds', 'get_qzone_public_feed_detail', 'get_qzone_public_comments', 'get_qzone_public_replies', 'set_qzone_public_like', 'set_qzone_public_comment_like'] },
  { activity: 'Share a Qzone post with someone or a group', tools: ['share_qzone_feed'] },
  { activity: 'Browse, like, comment on, or add to group albums', tools: ['get_group_album_list', 'get_group_album_media_list', 'set_group_album_media_like', 'do_group_album_comment', 'upload_image_to_qun_album'] },
  { activity: 'Check in to a group', tools: ['set_group_sign', 'get_group_signed_list'] },
  { activity: "Like a friend's QQ profile", tools: ['send_like'] },
  { activity: 'Start a private chat with or poke someone you know', tools: ['send_private_msg', 'friend_poke', 'send_poke'] },
  { activity: 'Change your QQ signature', tools: ['set_self_longnick'] },
  { activity: 'Set a custom online status', tools: ['set_diy_online_status'] },
  { activity: 'Change your avatar, nickname, Qzone name or description, or group card', tools: ['set_qq_avatar', 'set_qq_profile', 'set_qzone_profile', 'set_group_card'] },
  { activity: 'Collect or organize saved stickers', tools: ['add_custom_face', 'modify_custom_face', 'delete_custom_face'] },
  { activity: 'Write or reread your diary', tools: ['remember', 'recall'], memoryKind: 'note' },
  { activity: 'Look things up or read online: what is new in something you follow, news, weather, whatever you are curious about', tools: ['search_web', 'read_webpage'] },
];
/** The summarized text of a continuity summary, without its framing line and record references. */
function summaryBody(message: AgentMessage) {
  if (message.role !== 'user' || typeof message.content !== 'string' || !message.content.startsWith(SUMMARY_PREFIX)) return;
  const body = message.content.slice(message.content.indexOf('\n') + 1);
  const end = body.lastIndexOf('\nOriginal record IDs: ');
  return end < 0 ? body : body.slice(0, end);
}
const reviewing = (observation: Observation) => observation.events.some(event => event.kind === 'memory_maintenance');
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
const experienceKind = (tool: string) => tool === 'search_web' ? 'search' : tool === 'read_webpage' ? 'reading' : tool === 'share_qzone_feed' ? 'qzone_share' : `snowluma:${tool}`;
// Self-presentation the agent sets and later sees as current state.
const currentValue: Record<string, (args: Record<string, unknown>) => unknown> = { set_self_longnick: args => args.longNick ?? args.long_nick, set_diy_online_status: args => args.wording };
/** Messages, stickers, reactions, and pokes (ADR-0002): their success receipts need no call of their own, and a newer message in their chat makes an unsent one stale. */
const socialActions = new Set(['send_private_msg', 'send_group_msg', 'send_msg', 'send_custom_face', 'send_group_ai_record', 'set_group_reaction', 'set_msg_emoji_like', 'send_poke', 'friend_poke', 'group_poke']);
/** The chat an action is aimed at: group:<id> or private:<qq>. */
function targetChat(args: unknown): string | undefined {
  const { group_id: group, user_id: user, message_type: type } = (args ?? {}) as Record<string, unknown>;
  if (group != null && type !== 'private') return `group:${Number(group)}`;
  return user != null ? `private:${Number(user)}` : undefined;
}

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

/** faces names system faces by ID, so faces and reactions read as what they are. */
export function displayEvent(event: EnvironmentEvent, preview = 2000, faces: Record<string, string> = {}) {
  const compact = (value: unknown) => { const text = JSON.stringify(value); return text && text.length > preview ? { preview: text.slice(0, preview), truncated: true } : value; };
  const payload = nameFaces(event.payload, faces);
  return { id: event.id, kind: event.kind, at: new Date(event.at).toISOString(), groupId: event.groupId, actorId: event.actorId, postType: event.payload.post_type, messageType: event.payload.message_type, subType: event.payload.sub_type, targetId: event.payload.target_id, sender: compact(event.payload.sender), text: event.text.slice(0, preview), truncated: event.text.length > preview, messageId: event.payload.message_id, segments: event.kind === 'message' ? compact(payload.message) : undefined, notice: event.kind.startsWith('notice:') ? compact(payload) : undefined, details: event.payload.post_type && event.kind !== 'message' && !event.kind.startsWith('notice:') ? compact(event.payload) : undefined, wake: event.kind === 'wake' ? event.payload : undefined };
}

export class PiBrain implements Brain {
  readonly agent: Agent;
  thought: ThoughtContext = { generation: 0, sources: new Set(), triggers: new Set(), lifeOnly: true };
  private controller = new AbortController();
  private seen = new Set<string>();
  /** System faces whose picture this thought has seen. */
  private facesSeen = new Set<string>();
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
  constructor(private config: Config, private store: Store, private tools: ToolSet, backend?: { model: Model<any>; stream: StreamFn }, private monitor?: Monitor, private recall?: SemanticRecall) {
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
      beforeToolCall: async ({ toolCall, args }) => this.skipStale(toolCall.name, args),
      afterToolCall: async ({ toolCall, isError }) => socialActions.has(toolCall.name) && !isError ? { terminate: true } : undefined,
      prepareRequest: async ({ context, model: currentModel }, signal) => {
        const first = this.turns === 0;
        // Observations steered in for stale chats have entered by now.
        this.phase = 'preparing'; this.stale.clear(); this.skipped = false;
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
        // A preemption that came during preparation ends the thought before its call; what preparation did is kept.
        if (this.preempted) this.agent.abort(); else this.chargeCall();
        // Pi keeps its event transcript separately from the prepared request context.
        this.pendingRequest = messages.slice(); this.pendingRoute = route;
        this.agent.state.messages = messages.slice();
        this.phase = 'calling'; this.callStartedAt = Date.now();
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
      if (event.type === 'message_end' && event.message.role === 'assistant') this.phase = 'acting';
      if (event.type === 'tool_execution_start' && (socialActions.has(event.toolName) || event.toolName === 'share_qzone_feed')) {
        const chat = targetChat(event.args); if (chat) this.engaged.add(chat);
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant' && !['error', 'aborted'].includes(event.message.stopReason)) {
        if (!this.skipped) this.preemptions = 0;
        ensureCurrent(store, this.thought);
        this.meter.observe(this.pendingRequest, event.message, this.pendingRoute);
        store.archiveContext(this.agent.state.messages, [...this.thought.sources]);
        store.log('thought_turn_completed', { runId: this.runId, toolCalls: event.toolResults.length, usage: event.message.usage });
      }
    });
  }
  /** A preempted thought takes no more steering while it winds down. */
  get streaming() { return this.agent.state.isStreaming && !this.preempted; }
  private display(update: (monitor: Monitor) => void) { if (this.monitor) { try { update(this.monitor); } catch {} } }
  abort() { this.controller.abort(); this.agent.abort(); }
  private instructions(legacy = false) {
    const base = `You are a digital life with a unified identity and continuing experiences. Group chats, private chats, and other QQ interactions are external settings in your life.
The operator defines your core persona:\n${this.config.persona}\n
Decide whether to participate based on observations, persona, relationships, interests, and current activity. Silence is also an option. selfId is your QQ account; your own messages are feedback on your actions.
Native SnowLuma tools perform QQ operations; your ordinary text is not sent to QQ. Do not output chain of thought. You may end briefly or act through tools.
Each send_group_msg or send_private_msg call sends one message. Line breaks or multiple segments in message still form one message. To send two messages, call the corresponding tool twice in order, with only the relevant content in each call. You need not wait for a reply between messages, but each send must respect the pace of the current setting and actual action receipts. A batch made only of messages, stickers, reactions, or pokes ends your thought once all of them succeed, and their receipts come with your next observation, so put whatever else you mean to do now, such as another message, a sticker, or a note, in the same batch.
All enabled SnowLuma interfaces can be called directly using their original names and parameters, including private chats, group members, message deletion, files, emoji, and Qzone. Use search_snowluma_tools to find interfaces and load_snowluma_tools for detailed usage; these queries do not change the tool set. Preserve parameters as provided; file paths belong to the SnowLuma server. Streaming interfaces return ordered arrays of data frames. Both read-only queries and external actions are subject to interface permissions; actions are also subject to budgets and deduplication. Large results retain their source; use read_event to continue reading truncated results. A tool's sourceId can be used with remember or read_event.
New observations can change your activity. Consider the target, setting, and information-sharing scope when acting. historyGroups specifies which groups are checked for missed messages after a disconnect; the operator configures interface permissions. Check action receipts and investigate unknown outcomes first; the runtime handles action identifiers and deduplication.
Distinguish actual experiences, reported claims, inferences, fictional daily life, and tool results. runtime_data provides the life-mode switch; when disabled, stop autonomous life activities, but continue social commitments and memory maintenance.
Decide which experiences are important and save them with remember. When revising an understanding, retain its sources and previous version. Keep what people corrected or contradicted in what you save. Your feelings are yours to record, but how someone took your words is only what their replies show; what the record does not show, such as whether something helped or what they did after their last message, stays unknown.
Record what you are doing with set_activity. After accepting a future obligation, save it with schedule_activity as commitment; use life for your own plans. When your chats have been quiet for a while, a free-time wake may come for your own life; when you go to sleep or want time to yourself, set rest on the activity you will wake for, such as getting up or the end of a nap, and none comes before it. Call finish_activity when a plan is completed or cancelled. What you pursue over days, such as a song you are learning or a series you follow, is kept with update_pursuit and ended with finish_pursuit; runtime_data lists those under way. Progress takes time and may stall; record it when it moves or stalls.${this.config.life.allowFiction ? ' Save fictional daily life with remember as fiction, or set fictional on a diary entry that includes it.' : ''} What you say about your own day must agree with your recorded activity and pursuits, and anything you say you did online, such as posting or sharing, must be an action you actually took; what you say you saw there must be in its result. What you see online comes back to mind later only if you save it with remember, citing the result's sourceId. You may rest when nothing is pending.
Working context continues across thinking runs; when space is limited, a continuity summary replaces earlier exchanges. runtime_data provides timestamped state and observations; later snapshots update earlier state. Current activity, commitments, and actual action outcomes in the latest snapshot take precedence over old exchanges and summaries. Use recall, read_event, or inspect_actions for detailed evidence. recalled holds at most a few memories that what was just said calls to mind, each with the matchedLine that matched; they can be only loosely related, so follow them or let them pass. It is often empty, which does not mean you have no memory of the matter; use recall to look deliberately. Working context and summaries are persisted; still use remember to save important experiences, understandings, and notes. Use read_context with ctx: record IDs in the summary to read pre-compaction originals in chunks. A memory_maintenance event means it is time to organize your memories.`;
    return legacy ? base : base + `\nruntime_data format=snapshot represents the complete current state; format=delta contains only changed fields, and omitted fields retain their previous values. Apply upserts by id and remove removedIds in recentEvents, recalled, actualActions, activeCommitmentsAndPlans, pursuits, myHabits, practices, and impressions. Replace other fields directly. Action summaries omit internal provenance; use inspect_actions with an id for full evidence. Heartbeats are saved as connection records.
Your development is yours to keep alongside the operator's persona. Habits are your own ways of acting and expressing yourself, including your own expression style. Practices are what the people around you do in which situations: how long and how often they write, punctuation and tone words, slang, stickers and reactions, joining chains, or anything else you notice. Habits and practices hold everywhere by default; give one a group:<id> scope only when it clearly belongs to that group alone, such as its rules. An impression is your current understanding of one person and your relationship with them, including what they want from you; a way of talking or answering seen in one person alone belongs there, not in a habit or practice. A habit says when it applies and when it does not. runtime_data supplies myHabits, practices, and impressions for the current settings and people. Knowing a practice does not mean adopting it, and the persona above takes precedence over your habits where they disagree. Each scope has a size limit: merge with supersedes or retire with retire_memory instead of piling entries up. A habit or impression cannot rest only on your own messages, notes, or judgments. When a memory_maintenance event lists unreviewed chats, read them with read_chat_record and revise your development from what you see.`;
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
    const groups = this.observations.map(event => event.groupId).filter((x): x is number => x !== undefined);
    const recent = this.store.recent(this.config.memory.recentEvents);
    // What is said calls memories to mind, not merely where it is said (ADR-0009); development is supplied by scope below.
    const recalled = this.recall?.recall(this.observations) ?? [];
    for (const source of [...recent, ...recalled.map(item => item.memory)]) this.thought.sources.add(source.id);
    // A review looks at the chats it lists, so their groups and the people who spoke there count as present.
    const chats = this.observations.filter(event => event.kind === 'memory_maintenance').flatMap(event => (event.payload.backlog ?? []) as { conversation: string; since: number }[]);
    const reviewed = chats.map(chat => conversationOf(chat.conversation));
    const present = this.observations.map(event => event.actorId).filter((id): id is number => id !== undefined && id !== this.config.snowluma.selfId).reverse();
    const people = [...new Set([...present, ...reviewed.filter(chat => chat.type === 'private').map(chat => chat.id), ...this.store.impressionsIn(chats, this.config.snowluma.selfId, this.config.development.people)])].slice(0, this.config.development.people);
    const settings = new Set([...groups, ...reviewed.filter(chat => chat.type === 'group').map(chat => chat.id)]);
    const development = this.store.development(['global', ...[...settings].map(id => `group:${id}`), ...people.map(id => `person:${id}`)]);
    // When each was formed, so a judgment from last night's review reads as that rather than as settled.
    const entries = (kind: MemoryKind) => development.filter(memory => memory.kind === kind).map((memory: Memory) => ({ id: memory.id, scope: memory.scope, title: memory.title, content: memory.content, createdAt: new Date(memory.createdAt).toISOString() }));
    const runtime = { now: new Date().toISOString(), timeZone: 'Asia/Shanghai', selfId: this.config.snowluma.selfId, settings: this.store.settings(), allowFiction: this.config.life.allowFiction, historyGroups: this.config.snowluma.groups, snowlumaPermissions: this.config.snowluma.tools, activeCommitmentsAndPlans: this.store.wakes(), pursuits: this.store.pursuits(), recentEvents: recent.map(event => ({ id: event.id, kind: event.kind, at: event.at, groupId: event.groupId, actorId: event.actorId, text: event.text.slice(0, 400), truncated: event.text.length > 400 })), recalled: recalled.map(({ memory, line }) => ({ ...memory, content: memory.content.slice(0, 2000), truncated: memory.content.length > 2000, matchedLine: line })), actualActions: this.store.actions(10).map(action => actionSummary(action)), myHabits: entries('habit'), practices: entries('practice'), impressions: entries('impression') };
    // Commitments, current activity, pursuits, and development are never selected by probabilistic recall.
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recentEvents.length) runtime.recentEvents.shift();
    while (estimateTokens(runtime) > this.config.limits.contextTokens / 4 && runtime.recalled.length) runtime.recalled.pop();
    return runtime;
  }
  private async message(observation: Observation): Promise<ObservationMessage> {
    const preview = Math.max(80, Math.min(2000, Math.floor(this.config.limits.contextTokens / (observation.events.length * 8))));
    const ids = [...new Set(observation.events.flatMap(faceIds))];
    const faces = ids.length ? await this.tools.faces.names(this.controller.signal) : {};
    const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `New environment observations (use read_event to read truncated content):\n${JSON.stringify(observation.events.map(event => displayEvent(event, preview, faces)))}` }];
    if (observation.events.some(event => event.kind === 'wake' && event.payload.wakeKind === 'life')) content.push({ type: 'text', text: this.lifeContext() });
    let count = 0;
    for (const event of observation.events) for (const [index, segment] of (Array.isArray(event.payload.message) ? event.payload.message : []).filter(segment => segment.type === 'image').entries()) {
      const sticker = this.store.savedSticker(segment.data ?? {});
      const saved = sticker ? ` (already your saved sticker ${sticker.emojiId}${sticker.desc ? `: ${sticker.desc}` : ''})` : '';
      if (count++ >= this.config.limits.maxImages || estimateTokens(content.filter(item => item.type !== 'image')) + count * IMAGE_TOKENS > this.config.limits.contextTokens * 0.4) {
        content.push({ type: 'text', text: `Image ${index} from event ${event.id}${saved} was not loaded due to the context limit; use view_event_image to view it.` }); continue;
      }
      const url = segment.data?.url;
      if (typeof url !== 'string') { content.push({ type: 'text', text: `Image ${index} in event ${event.id}${saved} has no readable URL; the original event is retained.` }); continue; }
      try {
        const image = await fetchImage(url, this.controller.signal);
        // The label outlives the image, which is folded when the thought ends.
        content.push({ type: 'text', text: `The following is image ${index} from event ${event.id}${saved}` }, { type: 'image', data: image.data.toString('base64'), mimeType: image.type });
      } catch { content.push({ type: 'text', text: `Image ${index} in event ${event.id}${saved} could not be read` }); }
    }
    // A face's name rarely says what it shows, so each face is seen once a thought, after the images people sent.
    const unseen = ids.filter(id => faces[id] && !this.facesSeen.has(id)).slice(0, Math.max(0, this.config.limits.maxImages - count));
    const pictures = await Promise.all(unseen.map(id => this.tools.faces.image(id, this.controller.signal).catch(() => undefined)));
    for (const [index, id] of unseen.entries()) {
      const picture = pictures[index];
      if (!picture || estimateTokens(content.filter(item => item.type !== 'image')) + ++count * IMAGE_TOKENS > this.config.limits.contextTokens * 0.4) continue;
      this.facesSeen.add(id);
      content.push({ type: 'text', text: faceCaption(id, faces) }, { type: 'image', data: picture.toString('base64'), mimeType: 'image/png' });
    }
    return { role: 'observation', batchId: observation.batchId, eventIds: observation.events.map(event => event.id), lifeOnly: observation.events.every(event => event.kind === 'wake' && event.payload.wakeKind === 'life'), content, timestamp: Date.now() };
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
    return `Online activities available for your own life, with when you last did each. Life activities can be actual online activities like these, not only fictional daily life. What happens there, such as new posts or comments, never comes to you by itself; you see it only by checking. Use load_snowluma_tools for the parameters of unfamiliar tools.\n${JSON.stringify(status)}`;
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
    this.seen.clear(); this.facesSeen.clear(); this.turns = 0; this.runId = crypto.randomUUID(); this.observations = [...observation.events];
    const self = this.config.snowluma.selfId;
    this.engaged = new Set(observation.events.filter(event => event.actorId !== self && !isAmbient(event.kind, event.actorId, self)).map(eventChat).filter((chat): chat is string => chat !== undefined));
    this.stale.clear(); this.preempted = false;
    this.controller = new AbortController();
    this.thought = { generation, sources: new Set(this.thought.sources), triggers: new Set(), lifeOnly: true, reviewing: reviewing(observation) };
    this.display(monitor => monitor.startRun(this.runId, observation));
    try {
      const message = await this.message(observation);
      this.controller.signal.throwIfAborted();
      await this.agent.prompt(message);
      // A preempted thought ends without its unfinished call and is saved like any other (ADR-0002).
      if (this.preempted) this.agent.state.messages = this.agent.state.messages.filter(item => !(item.role === 'assistant' && item.stopReason === 'aborted'));
      else if (this.agent.state.errorMessage) throw new Error(this.agent.state.errorMessage);
      this.controller.signal.throwIfAborted();
      ensureCurrent(this.store, this.thought);
      this.fold();
      this.store.saveContext(this.checkpoint(), [...this.seen], this.compactions);
      this.seen.clear();
    }
    catch (error) { this.revert(rollback, generation); throw error; }
    finally { this.agent.clearAllQueues(); this.phase = 'idle'; this.preempted = false; this.display(monitor => monitor.endRun()); }
  }
  /** A message to the digital life in a chat this thought is engaged in: anything in a private chat, or a mention of or reply to it in a group. */
  private addressed(event: EnvironmentEvent): boolean {
    const self = this.config.snowluma.selfId; const chat = eventChat(event);
    if (event.kind !== 'message' || event.actorId === self || !chat || !this.engaged.has(chat)) return false;
    if (chat.startsWith('private:')) return true;
    const segments = (Array.isArray(event.payload.message) ? event.payload.message : []) as { type?: string; data?: Record<string, unknown> }[];
    return segments.some(segment => (segment.type === 'at' && Number(segment.data?.qq) === self) || (segment.type === 'reply' && this.store.sentMessage(Number(segment.data?.id))));
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
    const chat = socialActions.has(tool) ? targetChat(args) : undefined;
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
    const images = foldImages(records.messages);
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
    if (!this.streaming) return false;
    const addressed = observation.events.filter(event => this.addressed(event));
    // Declined here, the observation returns to pending and starts the next thought.
    if (addressed.length && this.preempt(addressed[0]!)) return false;
    if (this.preemptions < this.config.limits.maxPreemptions) for (const event of addressed) this.stale.add(eventChat(event)!);
    const message = await this.message(observation);
    // The run may have ended, or another begun, while images were downloading.
    if (!this.streaming || this.runId !== runId) return false;
    this.observations.push(...observation.events);
    this.thought.reviewing ||= reviewing(observation);
    this.display(monitor => monitor.observation(observation));
    this.agent.steer(message); return true;
  }
}
