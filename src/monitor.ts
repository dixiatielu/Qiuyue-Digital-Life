import { credentialNames, environmentCredential, type CredentialReader } from './credentials.js';
import { ui } from './ui-language.js';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Config } from './config.js';
import { ambientEvent, type Action, type EnvironmentEvent, type Observation } from './domain.js';
import { Store, type StoreNotice } from './store.js';

export interface DisplayItem {
  id: string; at: number;
  type: 'environment' | 'observation' | 'assistant' | 'tool' | 'action' | 'system' | 'run';
  title: string; text: string; state?: string; details?: string; source?: string;
  sender?: string; actionKind?: string;
  quiet?: boolean; runId?: string;
  eventKind?: string; eventIds?: string[]; observationId?: string; receivedAt?: number;
  startedAt?: number; durationMs?: number; summary?: string;
}
export interface DisplayStatus {
  model: string; connection: string; phase: string; paused: boolean; lifeEnabled: boolean;
  pendingEvents: number; modelCallsToday: number; actionsThisHour: number; activity: string;
  contextTokens?: number; inputBudget?: number; contextLimit: number;
  busy?: DisplayBusy;
}
export type BusyStage = 'preparing' | 'compacting' | 'waiting' | 'thinking' | 'writing' | 'calling' | 'tool';
/** What the current thinking run is doing; `since` is when the run started. */
export interface DisplayBusy {
  stage: BusyStage; since: number; tool?: string; runId?: string; stageSince?: number;
  requestCount?: number; requestStartedAt?: number; lastOutputAt?: number; outputChunks?: number;
  completedTools?: number; lastCompletedTool?: string;
}
export function busyLabel(busy: DisplayBusy) {
  const tool = busy.tool ?? ui('tool', '工具');
  return { preparing: ui('Preparing context', '准备上下文'), compacting: ui('Compacting context', '整理上下文'), waiting: ui('Waiting for model', '等待模型返回'), thinking: ui('Model generating', '模型正在生成'), writing: ui('Writing', '输出文字'), calling: ui(`Preparing ${tool}`, `准备调用 ${tool}`), tool: ui(`Running ${tool}`, `执行 ${tool}`) }[busy.stage];
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
  private runActions = new Map<string, Action['status']>();
  private generation = 0;
  private assistantId?: string;
  private contextTokens?: number;
  private inputBudget?: number;
  private readonly secrets: string[];
  constructor(private config: Config, private store: Store, private capacity = 2000, credential: CredentialReader = environmentCredential) {
    this.secrets = credentialNames(config).map(credential).filter((value): value is string => Boolean(value));
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
      // Keep the active run's trigger available even when incoming traffic fills the buffer.
      const id = [...this.items.keys()].find(id => id !== `run:${this.runId}`)!;
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
    const previous = this.items.get(event.id);
    const sender = (event.payload.sender as { card?: string; nickname?: string } | undefined);
    const source = event.source?.conversation ?? ui('Environment', '环境');
    this.put({ id: event.id, at: event.at, type: 'environment', source, sender: event.source?.actorName || event.source?.actor || sender?.card || sender?.nickname || (event.source?.actor === undefined ? undefined : String(event.source?.actor)),
      title: `${event.status === 'processed' ? ui('Recorded', '已记录') : ui('Received', '收到')} · ${source}${sender?.card || sender?.nickname ? ` · ${sender.card || sender.nickname}` : event.source?.actor ? ` · ${event.source?.actor}` : ''}`,
      text: event.text, state: event.status === 'processing' && previous?.state === 'accepted' ? 'accepted' : event.status,
      runId: event.status === 'pending' ? undefined : previous?.runId,
      eventKind: event.kind, receivedAt: event.receivedAt ?? event.at,
      quiet: event.kind.includes('heartbeat'), details: this.describe({ id: event.id, kind: event.kind, status: event.status }),
    }, live);
  }
  private action(action: Action, live = true) {
    const runId = this.items.get(action.id)?.runId ?? (this.runningTools.size ? this.runId : undefined);
    if (runId && runId === this.runId) this.runActions.set(action.id, action.status);
    this.put({ id: action.id, at: action.createdAt, type: 'action', title: ui(`Action · ${action.kind}`, `行动 · ${action.kind}`), state: action.status,
      runId, actionKind: action.kind,
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
        this.replayFloor = ++this.seq; this.assistantId = undefined; this.busy = undefined; this.runId = undefined; this.runningTools.clear(); this.runActions.clear();
        this.loadHistory(); this.broadcast(this.snapshot(ui('Memory forgotten; display cache cleared.', '记忆已遗忘，展示缓存已清除。'))); return;
      }
      this.trace(notice.id, notice.at, notice.name, notice.data);
    }
    this.refresh();
  }
  startRun(runId: string, observation: Observation) {
    this.runId = runId; this.generation = this.store.settings().generation; this.assistantId = undefined;
    const now = Date.now();
    this.busy = { stage: 'preparing', since: now, stageSince: now, runId, requestCount: 0, completedTools: 0 };
    this.runningTools.clear(); this.runActions.clear();
    this.put({ id: `run:${runId}`, at: now, type: 'run', title: ui('Thinking run', '本轮思考'), text: this.observationText(observation),
      state: 'running', runId, observationId: observation.batchId, eventIds: observation.events.map(event => event.id),
      details: this.describe(observation.events.map(event => ({ id: event.id, kind: event.kind, source: event.source?.conversation ?? event.source?.actor, text: event.text }))),
    });
    this.observation(observation); this.refresh();
  }
  private observationText(observation: Observation) {
    // Ambient signals accompany the events that wake a thought; lead with those waking events.
    const ambient = (event: EnvironmentEvent) => ambientEvent(event);
    return [...observation.events.filter(event => !ambient(event)), ...observation.events.filter(ambient)].map(event => {
      const source = event.source?.conversation ?? event.kind;
      const sender = event.payload.sender as { card?: string; nickname?: string } | undefined;
      const name = sender?.card || sender?.nickname || (event.kind === 'message' ? event.source?.actor : undefined);
      const text = event.kind === 'perception_gap' ? ui('Perception gap notification', '感知缺口通知') : event.kind.startsWith('meta_event:lifecycle') ? ui('Connection state notification', '连接状态通知') : event.text;
      return `${source}${name ? ` / ${name}` : ''}: ${text.replace(/\s+/g, ' ').slice(0, 180)}`;
    }).join('\n') || ui('No environment events', '无环境事件');
  }
  observation(observation: Observation) {
    this.put({ id: observation.batchId, at: Date.now(), type: 'observation', title: ui(`Observation · ${observation.events.length} events`, `观察 · ${observation.events.length} 条事件`), text: this.observationText(observation), state: 'queued', eventIds: observation.events.map(event => event.id), details: this.describe(observation.events.map(event => ({ id: event.id, kind: event.kind, source: event.source }))), runId: this.runId });
    for (const event of observation.events) {
      const received = this.items.get(event.id);
      if (received) this.put({ ...received, state: 'processing', runId: undefined });
    }
    this.refresh();
  }
  private stage(stage: BusyStage, tool?: string) {
    if (!this.busy || (this.busy.stage === stage && this.busy.tool === tool)) return;
    this.busy = { ...this.busy, stage, stageSince: Date.now(), tool }; this.refresh();
  }
  preparingRequest() { this.stage('preparing'); }
  requestStarted(stage: 'waiting' | 'compacting' = 'waiting') {
    if (!this.busy) return;
    const now = Date.now();
    this.busy = { ...this.busy, stage, stageSince: now, tool: undefined, requestCount: (this.busy.requestCount ?? 0) + 1,
      requestStartedAt: now, lastOutputAt: undefined, outputChunks: stage === 'waiting' ? 0 : undefined };
    this.refresh();
  }
  agentEvent(event: AgentEvent) {
    if (this.generation !== this.store.settings().generation) return;
    if (event.type === 'message_start' && event.message.role === 'observation') {
      const message = event.message as AgentMessage & { batchId: string; eventIds: string[] };
      const item = this.items.get(message.batchId);
      if (item) this.put({ ...item, state: 'accepted' });
      for (const id of message.eventIds) { const received = this.items.get(id); if (received) this.put({ ...received, state: 'accepted', runId: this.runId }); }
    }
    if (event.type === 'turn_start') this.preparingRequest();
    if (event.type === 'message_update' && event.message.role === 'assistant') {
      const update = event.assistantMessageEvent;
      // Only timing and counts enter the display; reasoning text and signatures do not.
      if (this.busy && 'delta' in update && typeof update.delta === 'string' && update.delta.length) {
        this.busy = { ...this.busy, lastOutputAt: Date.now(), outputChunks: (this.busy.outputChunks ?? 0) + 1 }; this.refresh();
      }
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
      if (running) this.stage('tool', running); else this.stage('preparing');
      const id = `tool:${event.toolCallId}`; const old = this.items.get(id);
      const now = Date.now();
      const startedAt = event.type === 'tool_execution_start' ? now : old?.startedAt;
      if (event.type === 'tool_execution_end' && this.busy && !['done', 'error'].includes(old?.state ?? '')) {
        this.busy = { ...this.busy, completedTools: (this.busy.completedTools ?? 0) + 1, lastCompletedTool: event.toolName };
      }
      this.put({ id, at: old?.at ?? Date.now(), type: 'tool', title: event.toolName, runId: this.runId,
        startedAt, durationMs: event.type === 'tool_execution_end' ? event.durationMs ?? (startedAt === undefined ? undefined : Math.max(0, now - startedAt)) : undefined,
        text: event.type === 'tool_execution_end' ? old?.text ?? '' : this.describe(event.args),
        state: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running',
        details: event.type === 'tool_execution_end' ? this.describe({ result: event.result.content, durationMs: event.durationMs }) : event.type === 'tool_execution_update' ? this.describe(event.partialResult?.content ?? []) : undefined,
      }); this.refresh();
    }
  }
  endRun(outcome: 'done' | 'error' | 'interrupted' = 'done') {
    this.flush();
    for (const item of this.items.values()) if (item.runId === this.runId && ['running', 'preparing', 'streaming'].includes(item.state ?? '')) this.put({ ...item, state: 'interrupted' });
    const run = this.items.get(`run:${this.runId}`);
    if (run && this.busy) {
      const actions = [...this.runActions.values()];
      const unknown = actions.filter(state => state === 'unknown' || state === 'pending').length;
      const failed = actions.filter(state => state === 'failed').length;
      const success = actions.filter(state => state === 'success').length;
      const result = actions.length ? ui(`${success} actions succeeded${failed ? ` · ${failed} failed` : ''}${unknown ? ` · ${unknown} unknown` : ''}`, `${success} 次行动成功${failed ? ` · ${failed} 次失败` : ''}${unknown ? ` · ${unknown} 次结果未知` : ''}`) : ui('No external action', '未采取对外行动');
      this.put({ ...run, state: outcome === 'done' ? unknown ? 'unknown' : failed ? 'failed' : 'done' : outcome,
        durationMs: Math.max(0, Date.now() - this.busy.since), summary: `${result} · ${ui(`${this.busy.requestCount ?? 0} model requests · ${this.busy.completedTools ?? 0} tools`, `${this.busy.requestCount ?? 0} 次模型请求 · ${this.busy.completedTools ?? 0} 次工具`)}` });
    }
    this.busy = undefined; this.runningTools.clear(); this.runActions.clear(); this.runId = undefined; this.refresh();
  }
  close() { this.flush(); this.disconnect(); this.listeners.clear(); if (this.timer) clearTimeout(this.timer); }
}
