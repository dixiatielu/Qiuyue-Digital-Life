import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import type { Config } from './config.js';
import type { EnvironmentEvent, Memory, MemoryKind, Observation } from './domain.js';
import { parseConversationRef } from './identity.js';
import type { Store } from './store.js';
import { prepareModelImage } from './image.js';
import type { ThoughtContext, ToolSet } from './tools.js';
import { estimateTokens, IMAGE_TOKENS } from './context.js';
import { actionSummary, type RuntimeSnapshot } from './runtime-context.js';
import { ChatRecord, observationText, recordTime } from './record.js';
import { memoriesInView, type SemanticRecall } from './recall.js';
import type { OnlineActivity } from './plugins.js';
import { requiresThoughtSignatures, type ModelOwner } from './model-config.js';

export interface ObservationMessage {
  role: 'observation';
  batchId: string;
  content: (TextContent | ImageContent)[];
  eventIds: string[];
  lifeOnly: boolean;
  timestamp: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    observation: ObservationMessage;
  }
}

/** Built-in online activities; plugins contribute their own activities through the host. */
export const onlineActivities: OnlineActivity[] = [
  { activity: 'Write or reread your diary', tools: ['remember', 'recall'], memoryKind: 'note' },
];

/** Canonical JSON for matching repeated tool calls regardless of key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** Local date, weekday, and time; models often misjudge the weekday when left to work it out from an ISO timestamp. */
export function localParts(at: number) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(part => [part.type, part.value]));
}

export function localTime(at: number) {
  const parts = localParts(at);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.weekday} ${parts.hour}:${parts.minute}`;
}

/** A day of life runs from 05:00 local time, so staying up past midnight does not start the next one. */
export const lifeDay = (at: number) => localTime(at - 5 * 3_600_000).slice(0, 10);

export function formatQuiet(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return 'just active';
  if (minutes < 60) return `quiet ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `quiet ${hours}h${minutes % 60}m` : `quiet ${hours}h`;
  return `quiet ${Math.floor(hours / 24)}d`;
}

export function runtimeMessage(data: RuntimeSnapshot): Message {
  return { role: 'user', content: `<runtime_data>\n${JSON.stringify(data)}\n</runtime_data>`, timestamp: Date.now() };
}

/** What the working context already shows of runtime state: what runtime_data has said, and the actions whose results came back to it as tool results. */
export function shownRuntimeSnapshot(previous: RuntimeSnapshot | undefined, messages: AgentMessage[], runtime: RuntimeSnapshot): RuntimeSnapshot | undefined {
  if (!previous) return;
  const known = new Set(((previous.actualActions ?? []) as { id: string }[]).map(action => action.id));
  const fresh = (runtime.actualActions as { id: string }[]).filter(action => !known.has(action.id));
  if (!fresh.length) return previous;
  const results = messages.flatMap(message => message.role === 'toolResult' ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []);
  const seen = fresh.filter(action => results.some(text => text.includes(action.id)));
  return seen.length ? { ...previous, actualActions: [...((previous.actualActions ?? []) as unknown[]), ...seen] } : previous;
}

/** The runtime state for a model call; thinking is set for a call of the thought under way, whose recollections are then counted. */
export function buildRuntimeSnapshot(params: {
  config: Config;
  store: Store;
  recall?: SemanticRecall;
  observations: EnvironmentEvent[];
  contextTokens: number;
  thought: ThoughtContext;
  broughtToMind: Set<string>;
  runId: string;
  owner: ModelOwner;
  thinking?: boolean;
}): RuntimeSnapshot {
  const { config, store, recall, observations, contextTokens, thought, broughtToMind, runId, owner, thinking = false } = params;
  const recent = store.recent(config.memory.recentEvents);
  const { recalled, development, listed } = memoriesInView(config, store, recall, observations);
  for (const source of [...recent, ...recalled.map(item => item.memory)]) thought.sources.add(source.id);
  // When each was formed, so a judgment from last night's review reads as that rather than as settled.
  const entries = (kind: MemoryKind) => development.filter(memory => memory.kind === kind).map((memory: Memory) => ({ id: memory.id, scope: memory.scope, title: memory.title, content: memory.content, createdAt: new Date(memory.createdAt).toISOString() }));
  const runtime = {
    platformAccounts: store.setting('platformAccounts', {}),
    now: new Date().toISOString(),
    timeZone: 'Asia/Shanghai',
    adapters: config.adapters.map(({ id, driver, accountId, tools }) => ({ id, driver, accountId, tools })),
    settings: store.settings(),
    allowFiction: config.life.allowFiction,
    activeCommitmentsAndPlans: store.wakes(),
    pursuits: store.pursuits(),
    recentEvents: recent.map(event => ({ id: event.id, kind: event.kind, at: event.at, ...(event.source ? { source: event.source } : {}), text: event.text.slice(0, 400), truncated: event.text.length > 400 })),
    recalled: recalled.map(({ memory, line }) => ({ ...memory, content: memory.content.slice(0, 2000), truncated: memory.content.length > 2000, matchedLine: line })),
    actualActions: store.actions(10).map(action => actionSummary(action)),
    myHabits: entries('habit'),
    practices: entries('practice'),
    impressions: entries('impression'),
    impressionIndex: listed.map(memory => ({ id: memory.id, scope: memory.scope, title: memory.title })),
  };
  // Commitments, current activity, pursuits, and development are never selected by probabilistic recall.
  while (estimateTokens(runtime) > contextTokens / 4 && runtime.recentEvents.length) runtime.recentEvents.shift();
  while (estimateTokens(runtime) > contextTokens / 4 && runtime.recalled.length) runtime.recalled.pop();
  if (thinking) {
    // Counted once a thought, however many calls it makes, and only for what stayed within the budget.
    const fresh = recalled.slice(0, runtime.recalled.length).filter(item => !broughtToMind.has(item.memory.id));
    for (const item of fresh) broughtToMind.add(item.memory.id);
    store.noteRecalled('spontaneous', fresh.map(item => ({ id: item.memory.id, similarity: item.similarity })), { runId, ...(owner === 'review' ? { reviewing: true } : {}) });
  }
  return runtime;
}

/** The group chat a rest held, read as a chat record from where it began. Each group's share of a quarter of the context bounds its record (ADR-0016). */
export function buildRestRecord(params: {
  store: Store;
  tools: ToolSet;
  contextTokens: number;
  payload: Record<string, unknown>;
  faces: Record<string, string>;
}): string {
  const { store, tools, contextTokens, payload, faces } = params;
  const { until, chats } = payload as { until: number; chats: { conversation: string; from: number; messages: number; notices: number }[] };
  const items = chats.reduce((sum, chat) => sum + chat.messages + chat.notices, 0) || 1;
  return chats.map(chat => {
    const share = Math.floor(contextTokens / 4 * (chat.messages + chat.notices) / items);
    const { text, omitted } = new ChatRecord(store, chat.conversation, faces, undefined, action => tools.plugins.actionCaption(action), tools.plugins.recordFormatters()).span(chat.from, until, share);
    return omitted ? `${text}\n[The earliest ${omitted} lines did not fit; read them with read_chat_record from="${recordTime(chat.from)}".]` : text;
  }).join('\n\n');
}

/** How long each tracked group chat has been quiet, so a life wake need not guess which chats are in a lull (ADR-0014). */
export function buildGroupQuietness(store: Store, tools: ToolSet, now: number): string | undefined {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const ref of tools.plugins.trackedConversations(store)) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const parsed = parseConversationRef(ref);
    if (!parsed) continue;
    const latest = store.latestConversationActivity(ref);
    if (!latest) continue;
    const label = latest.name ? `${parsed.id} (${latest.name})` : parsed.id;
    entries.push(`${label}: ${formatQuiet(now - latest.at)}`);
  }
  return entries.length ? `Group chats right now: ${entries.join('; ')}.` : undefined;
}

/** When each available online activity was last done, so a life wake knows what it can actually do. */
export function buildOnlineLife(config: Config, store: Store, tools: ToolSet): string | undefined {
  const available = new Set(tools.current().map(tool => tool.name));
  const activities = tools.plugins.activities(onlineActivities, available);
  if (!activities.length) return;
  const experienceKind = (tool: string) => tools.plugins.experienceKind(tool);
  const last = store.lastExperienced(activities.flatMap(item => item.tools.map(experienceKind)));
  const status = activities.map(({ activity, tools: activityTools, memoryKind, currentValue }) => {
    const at = memoryKind ? store.lastMemoryAt(memoryKind) ?? 0 : Math.max(0, ...activityTools.map(name => last[experienceKind(name)] ?? 0));
    const setter = currentValue && activityTools.includes(currentValue.tool) ? currentValue : undefined;
    const args = setter && store.lastSuccessfulAction(setter.tool)?.args;
    const current = args ? setter!.read(args) : undefined;
    return { activity, tools: activityTools, lastDone: at ? new Date(at).toISOString() : `not in the last ${config.memory.retentionDays} days`, ...(current !== undefined ? { lastSetTo: current } : {}) };
  });
  return `Online activities available for your own life, with when you last did each. Life activities can be actual online activities like these, not only fictional daily life.\n${JSON.stringify(status)}`;
}

/** What a life wake sees of its own days: the local time, how recent plans went, what happens to come to mind, and what it can actually do online. */
export function buildLifeContext(params: { config: Config; store: Store; tools: ToolSet; thought: ThoughtContext; now?: number }): string {
  const { config, store, tools, thought, now = Date.now() } = params;
  const today = lifeDay(now); const hour = Number(localParts(now).hour);
  const parts = [`Local time: ${localTime(now)} (Asia/Shanghai).`];
  const plans = store.pastLifePlans(8);
  if (!plans.some(wake => lifeDay(wake.dueAt) === today)) parts.push('This is your first life wake today. Sketch the day loosely: two or three things of different lengths, with no need to fill every hour or to finish them all.');
  if (plans.length) parts.push(`Your recent life plans, latest first. Vary your days rather than repeating the same few things:\n${JSON.stringify(plans.map(wake => ({ title: wake.title, at: localTime(wake.dueAt), status: wake.status })))}`);
  if (!store.pursuits().length) parts.push('You have no pursuits under way.');
  if (config.life.allowFiction) parts.push('Now and then, fictional daily life brings what you did not plan: the weather turns, a shop is closed, something breaks, something catches your eye. It can change your mood and plans.');
  const diary = store.lastMemoryAt('note');
  if ((hour >= 21 || hour < 5) && (diary === undefined || lifeDay(diary) !== today)) parts.push("You have not written today's diary. If you write one, write about your own day and feelings; chats belong in it only where they truly mattered to you.");
  // Chance recollections keep each wake from starting at the same blank page.
  const surfaced = [store.randomMemory(['experience', 'note', 'fiction'], now - 86_400_000), store.randomMemory(['impression'])].filter((memory): memory is Memory => memory !== undefined);
  for (const memory of surfaced) thought.sources.add(memory.id);
  if (surfaced.length) parts.push(`What happens to come to mind; follow it or let it pass:\n${JSON.stringify(surfaced.map(memory => ({ id: memory.id, kind: memory.kind, ...(memory.scope ? { scope: memory.scope } : {}), title: memory.title, content: memory.content.slice(0, 300), fictional: memory.fictional, createdAt: new Date(memory.createdAt).toISOString() })))}`);
  const groups = buildGroupQuietness(store, tools, now);
  if (groups) parts.push(groups);
  const online = buildOnlineLife(config, store, tools);
  if (online) parts.push(online);
  return parts.join('\n\n');
}

export async function buildObservationMessage(params: {
  config: Config;
  store: Store;
  tools: ToolSet;
  model: Model<any>;
  contextTokens: number;
  thought: ThoughtContext;
  observation: Observation;
  signal: AbortSignal;
}): Promise<ObservationMessage> {
  const { config, store, tools, model, contextTokens, thought, observation, signal } = params;
  const preview = Math.max(80, Math.min(2000, Math.floor(contextTokens / (observation.events.length * 8))));
  const rests = observation.events.filter(event => event.kind === 'rest_backlog');
  const faces = await tools.plugins.emojiNames(observation.events, signal);
  // Lines in the form of the chat record, less than half the size of event objects (ADR-0019).
  const content: (TextContent | ImageContent)[] = [{ type: 'text', text: `New environment observations (times +08:00; a #xxxxxxxx ref is an event ID; read_event shows the whole event):\n${observationText(store, observation.events, faces, preview, tools.plugins.recordFormatters())}` }];
  if (observation.events.some(event => event.kind === 'wake' && event.payload.wakeKind === 'life')) {
    content.push({ type: 'text', text: buildLifeContext({ config, store, tools, thought }) });
  }
  for (const rest of rests) content.push({ type: 'text', text: buildRestRecord({ store, tools, contextTokens, payload: rest.payload, faces }) });
  for (const text of tools.plugins.observation(observation.events, thought)) content.push({ type: 'text', text });
  let count = 0;
  const fits = () => count++ < config.limits.maxImages && estimateTokens(content.filter(item => item.type !== 'image')) + count * IMAGE_TOKENS <= contextTokens * 0.4;
  // Plugin-produced pictures are seen before incoming chat images, within the same context budget.
  const eventImages = observation.events.flatMap(event => tools.plugins.images(event).filter(image => image.autoView));
  const orderedImages = [
    ...eventImages.filter(image => (image.priority ?? 'primary') !== 'message'),
    ...eventImages.filter(image => image.priority === 'message'),
  ];
  for (const image of orderedImages) {
    if (!fits()) { content.push({ type: 'text', text: image.deferred }); continue; }
    let picture;
    try { picture = await image.load(signal); } catch { signal.throwIfAborted(); }
    if (!picture) { count--; content.push({ type: 'text', text: image.unavailable }); continue; }
    const prepared = await prepareModelImage(picture.data, picture.mimeType, model);
    content.push({ type: 'text', text: image.label }, { type: 'image', data: prepared.data.toString('base64'), mimeType: prepared.mimeType });
    image.onShown?.();
  }
  // Supplementary plugin pictures follow the images in the chat and use the same budget.
  for (const image of tools.plugins.supplementalImages(observation.events, thought)) {
    if (!image.autoView) continue;
    if (!fits()) { if (image.deferred) content.push({ type: 'text', text: image.deferred }); continue; }
    let picture;
    try { picture = await image.load(signal); } catch { signal.throwIfAborted(); }
    if (!picture) { count--; if (image.unavailable) content.push({ type: 'text', text: image.unavailable }); continue; }
    const prepared = await prepareModelImage(picture.data, picture.mimeType, model);
    content.push({ type: 'text', text: image.label }, { type: 'image', data: prepared.data.toString('base64'), mimeType: prepared.mimeType });
    image.onShown?.();
  }
  return {
    role: 'observation',
    batchId: observation.batchId,
    eventIds: observation.events.map(event => event.id),
    lifeOnly: observation.events.every(event => event.kind === 'wake' && event.payload.wakeKind === 'life'),
    content,
    timestamp: Date.now(),
  };
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
function isValidThoughtSignature(signature: string | undefined): boolean {
  return Boolean(signature && signature.length % 4 === 0 && base64SignaturePattern.test(signature));
}

/**
 * Build seeded turns for a fresh main working context from recent successful chat actions interleaved with surrounding chat
 * events (ADR-0024). Starting with only consecutive user observations and zero assistant turns leaves thinking models
 * out of distribution and pushes them to invent placeholder tool calls just to close silent turns.
 */
export function buildSeedTurns(params: { config: Config; store: Store; tools: ToolSet; model: Model<any>; budget: number }): AgentMessage[] {
  const { config, store, tools, model, budget } = params;
  if (config.memory.recentEvents <= 0) return [];
  const declared = new Set(tools.declared().map(tool => tool.name));
  const actions = store.actions(40)
    .filter(action => action.status === 'success'
      && action.conversation !== undefined
      && declared.has(action.kind)
      && !(action.result && typeof action.result === 'object' && (action.result as { redacted?: unknown }).redacted === true))
    .slice(0, 6)
    .reverse();
  if (!actions.length) return [];
  const requireSignatures = requiresThoughtSignatures(model);
  const signatures = new Map<string, { id: string; thoughtSignature?: string }>();
  for (const archived of store.recentAssistantMessages(200)) {
    if (archived.role !== 'assistant' || archived.provider !== model.provider || archived.api !== model.api || archived.model !== model.id) continue;
    for (const block of archived.content) {
      if (block.type !== 'toolCall') continue;
      const key = `${block.name}:${stableJson(block.arguments)}`;
      if (!signatures.has(key) || (!signatures.get(key)!.thoughtSignature && block.thoughtSignature)) {
        signatures.set(key, { id: block.id, ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}) });
      }
    }
  }
  const emittedEvents = new Set<string>();
  const usedCallIds = new Set<string>();
  const turns: AgentMessage[][] = [];
  for (const action of actions) {
    const match = signatures.get(`${action.kind}:${stableJson(action.args)}`);
    // Gemini 3+/4+ thinking models on generateContent reject historical functionCall parts without valid signatures.
    if (requireSignatures && !isValidThoughtSignature(match?.thoughtSignature)) continue;
    const candidates = new Map<string, EnvironmentEvent>();
    for (const item of [...store.actionTriggers(action.id), ...store.recentConversationEvents(action.conversation!, action.createdAt, 3)]) {
      candidates.set(item.id, item);
    }
    const surrounding = [...candidates.values()].sort((a, b) => a.at - b.at);
    if (!surrounding.length) continue;
    const freshEvents = surrounding.filter(item => !emittedEvents.has(item.id));
    for (const item of freshEvents) emittedEvents.add(item.id);
    const callId = match && !usedCallIds.has(match.id) ? match.id : `seed_${action.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    usedCallIds.add(callId);
    const callBlock: ToolCall = { type: 'toolCall', id: callId, name: action.kind, arguments: action.args as ToolCall['arguments'], ...(match?.thoughtSignature ? { thoughtSignature: match.thoughtSignature } : {}) };
    const resultMsg: ToolResultMessage = { role: 'toolResult', toolCallId: callId, toolName: action.kind, content: [{ type: 'text', text: JSON.stringify(actionSummary(action)) }], isError: false, timestamp: action.createdAt };
    if (!freshEvents.length && turns.length) {
      // Same-batch action with no intervening incoming events: append to the previous seeded assistant turn.
      const previous = turns.at(-1)!;
      const assistant = previous[1] as AssistantMessage;
      assistant.content = [...assistant.content, callBlock];
      assistant.timestamp = action.createdAt;
      previous.push(resultMsg);
      continue;
    }
    if (!freshEvents.length) continue;
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: `Earlier conversation before this working context began (times +08:00; a #xxxxxxxx ref is an event ID; read_event shows the whole event):\n${observationText(store, freshEvents, {}, 500, tools.plugins.recordFormatters())}` }],
      timestamp: freshEvents.at(-1)!.at,
    };
    const assistantMsg: AssistantMessage = {
      role: 'assistant',
      content: [callBlock],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse',
      timestamp: action.createdAt,
    };
    turns.push([userMsg, assistantMsg, resultMsg]);
  }
  const seedBudget = Math.min(4000, Math.floor(budget * 0.15));
  while (turns.length && estimateTokens(turns.flat()) > seedBudget) turns.shift();
  return turns.flat();
}
