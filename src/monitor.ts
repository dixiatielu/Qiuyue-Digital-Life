import { ui } from './ui-language.js';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Config } from './config.js';
import type { Action, EnvironmentEvent, Observation } from './domain.js';
import { Store, type StoreNotice } from './store.js';

export interface DisplayItem {
  id: string; at: number;
  type: 'environment' | 'observation' | 'assistant' | 'tool' | 'action' | 'system';
  title: string; text: string; state?: string; details?: string; source?: string;
  quiet?: boolean; runId?: string;
}
export interface DisplayStatus {
  model: string; connection: string; phase: string; paused: boolean; lifeEnabled: boolean;
  pendingEvents: number; modelCallsToday: number; actionsThisHour: number; activity: string;
  contextTokens?: number; inputBudget?: number; contextLimit: number;
  busy?: DisplayBusy;
}
export type BusyStage = 'preparing' | 'thinking' | 'writing' | 'calling' | 'tool';
/** What the current thinking run is doing; `since` is when the run started. */
export interface DisplayBusy { stage: BusyStage; since: number; tool?: string }
export function busyLabel(busy: DisplayBusy) {
  const tool = busy.tool ?? ui('tool', '工具');
  return { preparing: ui('Preparing observation', '准备观察'), thinking: ui('Thinking', '思考中'), writing: ui('Writing', '输出文字'), calling: ui(`Preparing ${tool}`, `准备调用 ${tool}`), tool: ui(`Running ${tool}`, `执行 ${tool}`) }[busy.stage];
}
export interface DisplayCursor { instanceId: string; seq: number }
export type DisplayChange = { type: 'item'; item: DisplayItem } | { type: 'status'; status: DisplayStatus };
export type DisplayPacket =
  | { type: 'snapshot'; cursor: DisplayCursor; status: DisplayStatus; items: DisplayItem[]; reason?: string }
  | { type: 'ready'; cursor: DisplayCursor }
  | { type: 'event'; cursor: DisplayCursor; change: DisplayChange };

/** Plain external text only: terminal escape sequences are never executable UI markup. */
export function plainText(value: string) {
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
const sensitive = /api[_-]?key|(?:^|[_-])(?:key|token|ticket|skey|pskey|bkn)(?:$|[_-])|access[_-]?token|authorization|password|secret|cookie|credential|session[_-]?key|clientkey|pt4token/i;
const textContent = (message: AgentMessage) => 'content' in message && Array.isArray(message.content)
  ? message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';

/** A bounded projection of existing records and live Pi events. It never drives the Agent. */
export class Monitor {
  readonly instanceId = randomUUID();
  private seq = 0;
  private replayFloor = 0;
  private ring: { packet: Extract<DisplayPacket, { type: 'event' }>; bytes: number }[] = [];
  private ringBytes = 0;
  private items = new Map<string, DisplayItem>();
  private itemBytes = new Map<string, number>();
  private totalItemBytes = 0;
  private listeners = new Set<(packet: DisplayPacket) => void>();
  private pending = new Map<string, DisplayItem>();
  private timer?: ReturnType<typeof setTimeout>;
  private statusDirty = false;
  private disconnect: () => void;
  private connection = ui('Connecting', '连接中');
  private busy?: DisplayBusy;
  private runningTools = new Map<string, string>();
  private runId?: string;
  private generation = 0;
  private assistantId?: string;
  private contextTokens?: number;
  private inputBudget?: number;
  private readonly secrets: string[];
  constructor(private config: Config, private store: Store, private capacity = 2000) {
    this.secrets = [config.model.apiKeyEnv, config.snowluma.tokenEnv, config.web.searchKeyEnv].map(name => process.env[name]).filter((value): value is string => Boolean(value));
    this.loadHistory();
    this.disconnect = store.subscribe(notice => this.onStore(notice));
  }
  private safe(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
      let text = plainText(value);
      for (const secret of this.secrets) text = text.split(secret).join('<REDACTED>');
      if (depth < 8 && /^[\s]*[\[{]/.test(text)) {
        try { text = JSON.stringify(this.safe(JSON.parse(text), depth + 1), null, 2); } catch {}
      }
      return text.length > 32000 ? text.slice(0, 32000) + ui('\n[Content truncated]', '\n[内容已截断]') : text;
    }
    if (depth > 8) return ui('[Nested content truncated]', '[嵌套内容已截断]');
    if (Array.isArray(value)) return value.slice(0, 100).map(item => this.safe(item, depth + 1));
    if (value && typeof value === 'object') {
      if ('type' in value && value.type === 'image') return { type: 'image', text: ui('[Image bytes omitted from display]', '[图片字节不进入展示]') };
      if ('type' in value && value.type === 'thinking') return { type: 'thinking', text: ui('[Internal reasoning omitted from display]', '[内部思考不进入展示]') };
      return Object.fromEntries(Object.entries(value).slice(0, 100).filter(([key]) => !['thinking', 'thinkingSignature', 'signature', 'chunk_data', 'base64'].includes(key)).map(([key, item]) => [plainText(key), sensitive.test(key) ? '<REDACTED>' : this.safe(item, depth + 1)]));
    }
    return value;
  }
  private describe(value: unknown) { return String(this.safe(JSON.stringify(this.safe(value), null, 2))); }
  private status(): DisplayStatus {
    return this.safe({
      model: `${this.config.model.provider}/${this.config.model.id}`, connection: this.connection,
      phase: this.busy ? busyLabel(this.busy) : ui('Idle', '空闲'), busy: this.busy, ...this.store.settings(), pendingEvents: this.store.pending(),
      modelCallsToday: this.store.dailyCalls(), actionsThisHour: this.store.hourlyActions(),
      contextTokens: this.contextTokens, inputBudget: this.inputBudget, contextLimit: this.config.limits.contextTokens,
    }) as DisplayStatus;
  }
  private cursor(): DisplayCursor { return { instanceId: this.instanceId, seq: this.seq }; }
  snapshot(reason?: string): Extract<DisplayPacket, { type: 'snapshot' }> {
    this.flush();
    return { type: 'snapshot', cursor: this.cursor(), status: this.status(), items: [...this.items.values()], ...(reason ? { reason } : {}) };
  }
  subscribe(cursor: DisplayCursor | undefined, listener: (packet: DisplayPacket) => void) {
    this.flush();
    // Synchronous snapshot/replay plus subscription is atomic with respect to event publication.
    this.listeners.add(listener);
    try {
      if (cursor && cursor.instanceId === this.instanceId && cursor.seq >= this.replayFloor && cursor.seq <= this.seq) {
        for (const { packet } of this.ring) if (packet.cursor.seq > cursor.seq) listener(packet);
      } else listener(this.snapshot(cursor ? ui('Live records exceeded the buffer or the daemon restarted; resynchronized.', '实时记录已超出缓冲或进程已重启，已重新同步。') : undefined));
      listener({ type: 'ready', cursor: this.cursor() });
    } catch { this.listeners.delete(listener); }
    return () => { this.listeners.delete(listener); };
  }
  private send(change: DisplayChange) {
    const packet: Extract<DisplayPacket, { type: 'event' }> = { type: 'event', cursor: { instanceId: this.instanceId, seq: ++this.seq }, change };
    const bytes = Buffer.byteLength(JSON.stringify(packet));
    this.ring.push({ packet, bytes }); this.ringBytes += bytes;
    while (this.ring.length > this.capacity || this.ringBytes > 4_000_000) {
      const removed = this.ring.shift()!; this.ringBytes -= removed.bytes; this.replayFloor = removed.packet.cursor.seq;
    }
    this.broadcast(packet);
  }
  private broadcast(packet: DisplayPacket) {
    for (const listener of this.listeners) { try { listener(packet); } catch { this.listeners.delete(listener); } }
  }
  private put(raw: DisplayItem, live = true) {
    const item = this.safe(raw) as DisplayItem;
    const bytes = Buffer.byteLength(JSON.stringify(item));
    this.totalItemBytes += bytes - (this.itemBytes.get(item.id) ?? 0); this.itemBytes.set(item.id, bytes);
    this.items.set(item.id, item);
    while (this.items.size > 200 || this.totalItemBytes > 500_000) {
      const id = this.items.keys().next().value!;
      this.totalItemBytes -= this.itemBytes.get(id) ?? 0; this.itemBytes.delete(id); this.items.delete(id);
    }
    if (live) this.send({ type: 'item', item });
  }
  private queue(item?: DisplayItem) {
    if (item) this.pending.set(item.id, item);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const updates = [...this.pending.values()]; this.pending.clear();
    for (const item of updates) this.put(item);
    if (this.statusDirty) { this.statusDirty = false; this.send({ type: 'status', status: this.status() }); }
  }
  private refresh() { this.statusDirty = true; this.queue(); }
  private environment(event: EnvironmentEvent, live = true) {
    const sender = (event.payload.sender as { card?: string; nickname?: string } | undefined);
    const source = event.groupId ? ui(`Group ${event.groupId}`, `群 ${event.groupId}`) : event.actorId ? ui(`Private chat ${event.actorId}`, `私聊 ${event.actorId}`) : ui('Environment', '环境');
    this.put({ id: event.id, at: event.at, type: 'environment', source,
      title: `${event.status === 'processed' ? ui('Recorded', '已记录') : ui('Received', '收到')} · ${source}${sender?.card || sender?.nickname ? ` · ${sender.card || sender.nickname}` : event.actorId ? ` · ${event.actorId}` : ''}`,
      text: event.text, state: event.status, quiet: event.kind.includes('heartbeat'), details: this.describe({ id: event.id, kind: event.kind, status: event.status }),
    }, live);
  }
  private action(action: Action, live = true) {
    this.put({ id: action.id, at: action.createdAt, type: 'action', title: ui(`Action · ${action.kind}`, `行动 · ${action.kind}`), state: action.status,
      text: this.describe(action.args), details: this.describe({ id: action.id, status: action.status, result: action.result }),
      source: action.args.group_id ? ui(`Group ${action.args.group_id}`, `群 ${action.args.group_id}`) : action.args.user_id ? ui(`Private chat ${action.args.user_id}`, `私聊 ${action.args.user_id}`) : undefined,
    }, live);
  }
  private trace(id: number, at: number, name: string, data: unknown, live = true) {
    const detail = data as Record<string, unknown>;
    if (name === 'context_budget') { this.contextTokens = Number(detail.tokens); this.inputBudget = Number(detail.inputBudget); }
    if (live && name === 'connection_opened') this.connection = ui('Connected', '已连接');
    if (live && (name === 'connection_closed' || name === 'connection_error')) this.connection = ui('Disconnected', '已断开');
    if (!['context_budget', 'action_result', 'thought_turn_completed', 'observation_dispatched', 'observation_entered'].includes(name)) this.put({ id: `trace:${id}`, at, type: 'system', title: name, text: this.describe(data), state: name.includes('error') ? 'error' : undefined }, live);
  }
  private loadHistory() {
    const history = this.store.visibleHistory();
    for (const event of history.events) this.environment(event, false);
    for (const record of history.messages) {
      if (record.message.role === 'assistant' && textContent(record.message)) this.put({ id: record.id, at: record.at, type: 'assistant', title: ui('Model output · not sent to QQ', '模型输出 · 未发送到 QQ'), text: textContent(record.message), state: 'done' }, false);
      if (record.message.role === 'assistant') for (const block of record.message.content) if (block.type === 'toolCall') this.put({ id: `tool:${block.id}`, at: record.at, type: 'tool', title: block.name, text: this.describe(block.arguments), state: 'interrupted' }, false);
      if (record.message.role === 'toolResult') {
        const id = `tool:${record.message.toolCallId}`;
        this.put({ id, at: record.at, type: 'tool', title: record.message.toolName, text: this.items.get(id)?.text ?? ui('Previous tool result', '历史工具结果'), details: textContent(record.message), state: record.message.isError ? 'error' : 'done' }, false);
      }
    }
    for (const action of history.actions) this.action(action, false);
    for (const log of history.logs) this.trace(Number(log.id), Number(log.at), String(log.kind), log.data, false);
    this.items = new Map([...this.items].sort((a, b) => a[1].at - b[1].at));
  }
  private onStore(notice: StoreNotice) {
    if (notice.kind === 'environment') this.environment(notice.event);
    if (notice.kind === 'action') this.action(notice.action);
    if (notice.kind === 'trace') {
      if (notice.name === 'memory_forgotten') {
        // Old deltas must not resurrect explicitly forgotten content after a reconnect.
        if (this.timer) clearTimeout(this.timer); this.timer = undefined;
        this.pending.clear(); this.items.clear(); this.itemBytes.clear(); this.totalItemBytes = 0; this.ring = []; this.ringBytes = 0;
        this.replayFloor = ++this.seq; this.assistantId = undefined; this.busy = undefined; this.runningTools.clear();
        this.loadHistory(); this.broadcast(this.snapshot(ui('Memory forgotten; display cache cleared.', '记忆已遗忘，展示缓存已清除。'))); return;
      }
      this.trace(notice.id, notice.at, notice.name, notice.data);
    }
    this.refresh();
  }
  startRun(runId: string, observation: Observation) {
    this.runId = runId; this.generation = this.store.settings().generation; this.assistantId = undefined;
    this.busy = { stage: 'preparing', since: Date.now() }; this.runningTools.clear();
    this.observation(observation); this.refresh();
  }
  observation(observation: Observation) {
    this.put({ id: observation.batchId, at: Date.now(), type: 'observation', title: ui(`Observation · ${observation.events.length} events`, `观察 · ${observation.events.length} 条事件`), text: ui('Waiting to enter the current reasoning run', '等待纳入当前思考'), state: 'queued', details: this.describe(observation.events.map(event => ({ id: event.id, kind: event.kind, groupId: event.groupId }))), runId: this.runId });
    this.refresh();
  }
  private stage(stage: BusyStage, tool?: string) {
    if (!this.busy || (this.busy.stage === stage && this.busy.tool === tool)) return;
    this.busy = { stage, since: this.busy.since, ...(tool ? { tool } : {}) }; this.refresh();
  }
  agentEvent(event: AgentEvent) {
    if (this.generation !== this.store.settings().generation) return;
    if (event.type === 'message_start' && event.message.role === 'observation') {
      const message = event.message as AgentMessage & { batchId: string; eventIds: string[] };
      const item = this.items.get(message.batchId);
      if (item) this.put({ ...item, state: 'accepted', text: ui('Included in observation', '已纳入观察') });
      for (const id of message.eventIds) { const received = this.items.get(id); if (received) this.put({ ...received, state: 'accepted' }); }
    }
    if (event.type === 'turn_start') this.stage('thinking');
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      const update = event.assistantMessageEvent;
      if (update.type.startsWith('thinking')) this.stage('thinking');
      if (update.type.startsWith('text')) this.stage('writing');
      if (update.type === 'toolcall_start' || update.type === 'toolcall_delta' || update.type === 'toolcall_end') { const block = update.partial.content[update.contentIndex]; this.stage('calling', block?.type === 'toolCall' && block.name ? block.name : undefined); }
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') this.assistantId = `assistant:${randomUUID()}`;
    if ((event.type === 'message_update' || event.type === 'message_end') && event.message.role === 'assistant') {
      const id = this.assistantId ??= `assistant:${randomUUID()}`;
      const text = textContent(event.message);
      if (text) this.queue({ id, at: this.items.get(id)?.at ?? Date.now(), type: 'assistant', title: ui('Model output · not sent to QQ', '模型输出 · 未发送到 QQ'), text, state: event.type === 'message_end' ? event.message.stopReason : 'streaming', runId: this.runId });
      for (const block of event.message.content) if (block.type === 'toolCall') {
        const toolId = `tool:${block.id}`;
        if (!this.items.has(toolId) || this.items.get(toolId)?.state === 'preparing') this.queue({ id: toolId, at: this.items.get(toolId)?.at ?? Date.now(), type: 'tool', title: block.name, text: this.describe(block.arguments), state: 'preparing', runId: this.runId });
      }
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      this.flush();
      if (event.type === 'tool_execution_end') this.runningTools.delete(event.toolCallId); else this.runningTools.set(event.toolCallId, event.toolName);
      const running = [...this.runningTools.values()].at(-1);
      if (running) this.stage('tool', running); else this.stage('thinking');
      const id = `tool:${event.toolCallId}`; const old = this.items.get(id);
      this.put({ id, at: old?.at ?? Date.now(), type: 'tool', title: event.toolName, runId: this.runId,
        text: event.type === 'tool_execution_end' ? old?.text ?? '' : this.describe(event.args),
        state: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running',
        details: event.type === 'tool_execution_end' ? this.describe({ result: event.result.content, durationMs: event.durationMs }) : event.type === 'tool_execution_update' ? this.describe(event.partialResult?.content ?? []) : undefined,
      }); this.refresh();
    }
  }
  endRun() {
    this.flush();
    for (const item of this.items.values()) if (item.runId === this.runId && ['running', 'preparing', 'streaming'].includes(item.state ?? '')) this.put({ ...item, state: 'interrupted' });
    this.busy = undefined; this.runningTools.clear(); this.runId = undefined; this.refresh();
  }
  close() { this.flush(); this.disconnect(); this.listeners.clear(); if (this.timer) clearTimeout(this.timer); }
}
