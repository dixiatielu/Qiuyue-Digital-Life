import { ui } from './ui-language.js';
import { HStack, Markdown, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth, type Component, type MarkdownTheme, type Terminal, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { callControl } from './control.js';
import { followDisplay } from './display-client.js';
import { busyLabel, plainText, type DisplayItem, type DisplayPacket, type DisplayStatus } from './monitor.js';
import { CommandInput } from './tui-commands.js';
import { bold, dim, TuiTheme } from './tui-theme.js';

const labels = (): Record<string, string> => ({
  pending: ui('Waiting for remote receipt', '等待远端回执'), success: ui('Success', '成功'), failed: ui('Failed', '失败'), unknown: ui('Unknown', '结果未知'),
  preparing: ui('Preparing arguments', '生成参数中'), running: ui('Running', '执行中'), done: ui('Tool completed', '工具完成'), error: ui('Error', '错误'),
  streaming: ui('Generating', '生成中'), stop: ui('Completed', '完成'), interrupted: ui('Interrupted', '已中断'), aborted: ui('Cancelled', '已取消'),
  queued: ui('Waiting for observation', '等待纳入观察'), accepted: ui('Included in observation', '已纳入观察'), processed: ui('Recorded', '已记录'),
});
const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const humanTokens = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '—' : value >= 1024 ? `${(value / 1024).toFixed(1)}K` : String(value);
const gutter = (width: number) => width >= 20 ? 2 : 0;
const inset = (text: string, width: number) => ' '.repeat(gutter(width)) + truncateToWidth(text, Math.max(0, width - 2 * gutter(width)));
const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const spinnerMs = 80;
const elapsed = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const oneLine = (text: string) => plainText(text).replace(/\s+/g, ' ').trim();
const problem = (item: DisplayItem) => ['error', 'failed', 'unknown'].includes(item.state ?? '');
const toolLabel = (name: string) => ({
  read_event: ui('Read event', '读取消息'), view_event_image: ui('View image', '查看消息图片'), recall: ui('Recall memories', '检索记忆'),
  remember: ui('Save memory', '保存记忆'), read_context: ui('Read earlier context', '读取历史上下文'),
  send_group_msg: ui('Send group message', '发送群消息'), send_private_msg: ui('Send private message', '发送私聊消息'),
  send_custom_face: ui('Send sticker', '发送表情'), add_custom_face: ui('Save sticker', '收藏表情'),
  set_group_reaction: ui('React to message', '回应消息'), search_snowluma_tools: ui('Find tools', '查找工具'),
  load_snowluma_tools: ui('Read tool instructions', '读取工具用法'),
} as Record<string, string>)[name] ?? name;
const symbol = (item: DisplayItem) => problem(item) ? '!' : ['done', 'success', 'processed', 'stop'].includes(item.state ?? '') ? '✓' : item.state === 'interrupted' || item.state === 'aborted' ? '−' : '·';
const outcomeStyle = (item: DisplayItem, text: string, theme: TuiTheme) => item.state === 'unknown' || item.state === 'pending' ? theme.warning(text) : problem(item) ? theme.danger(text) : item.state === 'success' ? theme.success(text) : dim(text);
const marker = (item: DisplayItem, selected: boolean, theme: TuiTheme) => selected ? theme.accent('›') : problem(item) ? outcomeStyle(item, symbol(item), theme) : symbol(item) === '✓' ? theme.success('✓') : ['running', 'preparing', 'streaming'].includes(item.state ?? '') ? theme.accent(symbol(item)) : dim(symbol(item));
function argumentsOf(item: DisplayItem): Record<string, unknown> {
  try { const value = JSON.parse(item.text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}
const actionKind = (item: DisplayItem) => item.actionKind ?? item.title.replace(/^(?:Action|行动) · /, '');
const isMessage = (item: DisplayItem) => ['send_group_msg', 'send_private_msg', 'send_custom_face', 'send_group_ai_record'].includes(actionKind(item));
function messageText(value: unknown): string {
  if (typeof value === 'string') return plainText(value);
  if (!Array.isArray(value)) return '';
  return value.map(segment => {
    if (!segment || typeof segment !== 'object') return '';
    if (segment.type === 'text') return typeof segment.data?.text === 'string' ? plainText(segment.data.text) : '';
    if (segment.type === 'at') return `@${plainText(String(segment.data?.qq ?? ''))}`;
    const name = ({ image: ui('Image', '图片'), face: ui('Emoji', '表情'), record: ui('Voice', '语音'), video: ui('Video', '视频'), reply: ui('Reply', '引用回复'), forward: ui('Forwarded messages', '转发消息') } as Record<string, string>)[String(segment.type)] ?? String(segment.type ?? ui('Attachment', '附件'));
    return `[${plainText(name)}]`;
  }).join('');
}
function argumentSummary(item: DisplayItem) {
  const args = argumentsOf(item);
  return oneLine([args.group_id ? ui(`Group ${args.group_id}`, `群 ${args.group_id}`) : args.user_id ? ui(`Private ${args.user_id}`, `私聊 ${args.user_id}`) : '',
    ...(item.type === 'tool' && isMessage(item) ? [] : ['query', 'message', 'title', 'url']).map(key => typeof args[key] === 'string' ? args[key] : '')].filter(Boolean).join(' · ')).slice(0, 160);
}
const markdownTheme = (theme: TuiTheme): MarkdownTheme => ({
  heading: bold, link: theme.accent, linkUrl: dim, code: theme.accent, codeBlock: text => text,
  codeBlockBorder: dim, quote: text => text, quoteBorder: dim, hr: dim, listBullet: text => text,
  bold, italic: text => text, strikethrough: text => text, underline: text => text,
});

/** The same packet reducer is used for snapshots, live updates and reconnect replay. */
export class DisplayModel {
  readonly theme = new TuiTheme();
  items = new Map<string, DisplayItem>();
  status?: DisplayStatus;
  connected = false;
  connectionMessage = ui('Connecting to daemon', '正在连接常驻进程');
  note = ui('Use /help for commands; the digital life keeps running after the TUI exits', '/help 查看命令；退出界面后数字生命继续运行');
  filter = '';
  expanded = new Set<string>();
  selected?: string;
  unseen = 0;
  showDetails = false;
  selectionOrder: string[] = [];
  apply(packet: DisplayPacket, following = true) {
    if (packet.type === 'ready') return;
    if (following) this.unseen = 0;
    if (packet.type === 'snapshot') {
      this.items = new Map(packet.items.map(item => [item.id, item])); this.status = packet.status;
      this.expanded.clear(); this.selected = undefined; this.unseen = 0;
      if (packet.reason) this.note = packet.reason;
    } else if (packet.change.type === 'status') this.status = packet.change.status;
    else {
      if (!following && !this.items.has(packet.change.item.id)) this.unseen++;
      this.items.set(packet.change.item.id, packet.change.item);
      const activeRun = [...this.items.values()].find(item => item.type === 'run' && item.state === 'running')?.id;
      while (this.items.size > 200) { const id = [...this.items.keys()].find(id => id !== activeRun)!; this.items.delete(id); this.expanded.delete(id); }
    }
  }
  visible() {
    const filter = this.filter.toLocaleLowerCase();
    return [...this.items.values()].filter(item => filter === 'errors'
      ? ['error', 'failed', 'unknown'].includes(item.state ?? '') || item.title.includes('error')
      : filter ? `${item.title} ${item.text} ${item.source ?? ''} ${item.state ?? ''} ${item.summary ?? ''}`.toLocaleLowerCase().includes(filter) : this.showDetails || !item.quiet);
  }
  select(direction: number) {
    const ids = this.selectionOrder.length ? this.selectionOrder : this.visible().map(item => item.id); if (!ids.length) return;
    const current = ids.indexOf(this.selected ?? '');
    this.selected = ids[Math.max(0, Math.min(ids.length - 1, current < 0 ? ids.length - 1 : current + direction))];
  }
  toggle(id = this.selected ?? this.selectionOrder.at(-1) ?? this.visible().at(-1)?.id) {
    if (!id) return;
    this.selected = id;
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
  }
}

export class Timeline implements Component {
  private rows = new Map<number, string>();
  private markdown = new Map<string, Markdown>();
  private cache = new Map<string, { item: DisplayItem; width: number; selected: boolean; expanded: boolean; detailed: boolean; lines: string[] }>();
  constructor(readonly model: DisplayModel) {}
  invalidate() { this.cache.clear(); for (const markdown of this.markdown.values()) markdown.invalidate(); }
  rowOf(id: string) { for (const [row, itemId] of this.rows) if (id === itemId) return row; return undefined; }
  private renderItem(item: DisplayItem, width: number, selected: boolean, expanded: boolean) {
    const { accent } = this.model.theme;
    const mark = marker(item, selected, this.model.theme);
    const outcome = (text: string) => outcomeStyle(item, text, this.model.theme);
    const lines: string[] = [];
    const stateLabel = item.type === 'environment' ? ({ pending: ui('Waiting for observation', '等待观察'), processing: ui('Waiting to be included', '等待纳入'), accepted: ui('Included in observation', '已纳入观察'), processed: ui('Recorded', '已记录') } as Record<string, string>)[item.state ?? ''] : labels()[item.state ?? ''];
    const state = item.state ? `[${stateLabel ?? item.state}] ` : '';
    if (!this.model.showDetails && (item.type === 'environment' || item.type === 'action')) {
      const args = argumentsOf(item);
      const sentMessage = item.type === 'action' && isMessage(item);
      const destination = item.source ?? (args.group_id ? ui(`Group ${args.group_id}`, `群 ${args.group_id}`) : args.user_id ? ui(`Private ${args.user_id}`, `私聊 ${args.user_id}`) : '');
      const name = item.type === 'environment'
        ? item.sender ? `${item.source ?? ''} / ${item.sender}` : item.title.replace(/^(?:Received|Recorded|收到|已记录) · /, '')
        : `${ui('Qiuyue', '秋月')}${destination ? ` → ${destination}` : ''}${sentMessage ? '' : ` · ${toolLabel(actionKind(item))}`}`;
      const stateText = item.type === 'action' ? sentMessage && item.state === 'success' ? ui('Sent', '已发送') : stateLabel ?? item.state ?? ''
        : ['pending', 'processing'].includes(item.state ?? '') ? stateLabel : '';
      // Wrap outcome labels so a long destination or a narrow terminal cannot hide uncertainty.
      const heading = `${selected ? accent('› ') : ''}${item.type === 'action' ? accent(name) : dim(`${time(item.at).slice(0, 5)}  ${name}`)}`;
      const status = stateText ? `${item.type === 'action' ? `${mark} ` : ''}${outcome(stateText)}` : '';
      lines.push(...new Text(`${heading}${status ? `  ${status}` : ''}`, 0, 0).render(width));
      const body = item.type === 'environment' ? plainText(item.text)
        : messageText(args.message) || (actionKind(item) === 'send_custom_face' ? ui('[Sticker]', '[表情]') : argumentSummary(item));
      const bodyLines = new Text(body, width > 6 ? 2 : 0, 0).render(width);
      lines.push(...(expanded ? bodyLines : bodyLines.slice(0, 8)));
      if (!expanded && bodyLines.length > 8) lines.push(dim(ui('  … Tab to read more', '  … Tab 查看全文')));
      if (expanded) {
        if (item.type === 'action') lines.push(...new Text(dim(plainText(item.text)), width > 6 ? 2 : 0, 0).render(width));
        if (item.details) lines.push(...new Text(dim(plainText(item.details)), width > 6 ? 2 : 0, 0).render(width));
      }
      lines.push('');
      return lines.map(line => truncateToWidth(line, width));
    }
    if (!expanded) {
      const name = item.type === 'tool' ? toolLabel(item.title) : item.title;
      const summary = item.type === 'tool' || item.type === 'action' ? argumentSummary(item) : oneLine(item.text);
      const duration = item.durationMs === undefined ? '' : ` · ${item.durationMs < 10_000 ? `${(item.durationMs / 1000).toFixed(1)}s` : elapsed(item.durationMs)}`;
      const line = `  ${mark} ${problem(item) ? outcome(state) : ''}${selected ? accent(name) : dim(name)}${dim(duration)}${summary && item.type !== 'assistant' ? ` · ${summary}` : ''}${item.details || item.text ? dim(' ▸') : ''}`;
      // Put the outcome on its own line in very narrow terminals.
      if (problem(item) && width < 40) lines.push(...new Text(state.trim(), 0, 0).render(Math.max(1, width)));
      lines.push(truncateToWidth(line, width));
      return lines;
    }
    if (state && width < 40) lines.push(...new Text(state.trim(), 0, 0).render(Math.max(1, width)));
    const title = `${mark} ${width < 40 ? '' : outcome(state)}${dim(time(item.at))}  ${selected ? accent(plainText(item.title)) : plainText(item.title)}`;
    lines.push(truncateToWidth(title, width));
    let body = plainText(item.text);
    if (body) {
      if (item.type === 'assistant') {
        let markdown = this.markdown.get(item.id);
        if (!markdown) { markdown = new Markdown(body, 2, 0, markdownTheme(this.model.theme)); this.markdown.set(item.id, markdown); }
        else markdown.setText(body);
        lines.push(...markdown.render(Math.max(1, width)));
      } else lines.push(...new Text(body, width > 4 ? 2 : 0, 0).render(Math.max(1, width)));
    }
    if (expanded && item.details) lines.push(...new Text(dim(plainText(item.details)), width > 4 ? 2 : 0, 0).render(Math.max(1, width)));
    lines.push('');
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number) {
    const { accent } = this.model.theme;
    const padding = ' '.repeat(gutter(width));
    width = Math.max(1, width - padding.length * 2);
    this.rows.clear();
    const items = this.model.filter || this.model.showDetails ? this.model.visible() : [...this.model.items.values()]; const lines: string[] = [];
    const active = new Set(items.map(item => item.id));
    for (const id of this.markdown.keys()) if (!active.has(id)) this.markdown.delete(id);
    for (const id of this.cache.keys()) if (!active.has(id)) this.cache.delete(id);
    const append = (id: string, rendered: string[]) => {
      const start = lines.length; lines.push(...rendered.map(line => truncateToWidth(line, width)));
      for (let row = start; row < lines.length; row++) this.rows.set(row, id);
    };
    const render = (item: DisplayItem) => {
      const start = lines.length;
      const selected = this.model.selected === item.id; const expanded = this.model.showDetails || this.model.expanded.has(item.id);
      // Packets replace an item object whenever it changes, so identity is a sufficient cache key;
      // this keeps spinner frames from re-wrapping the whole timeline.
      let cached = this.cache.get(item.id);
      if (cached?.item !== item || cached.width !== width || cached.selected !== selected || cached.expanded !== expanded || cached.detailed !== this.model.showDetails) {
        cached = { item, width, selected, expanded, detailed: this.model.showDetails, lines: this.renderItem(item, width, selected, expanded) };
        this.cache.set(item.id, cached);
      }
      lines.push(...cached.lines);
      for (let row = start; row < lines.length; row++) this.rows.set(row, item.id);
    };
    if (this.model.filter || this.model.showDetails) {
      for (const item of items) render(item);
    } else {
      const runs = new Map(items.filter(item => item.type === 'run').map(item => [item.runId, item]));
      const triggerIds = new Set([...runs.values()].flatMap(run => run.eventIds ?? []));
      const waiting = items.filter(item => item.type === 'environment' && !item.quiet && !triggerIds.has(item.id) && ['pending', 'processing'].includes(item.state ?? ''));
      const waitingIds = new Set(waiting.map(item => item.id));
      const system = items.filter(item => !waitingIds.has(item.id) && (item.quiet || item.type === 'system' && !problem(item) || item.type === 'environment' && item.eventKind?.startsWith('meta_event:')));
      const historyDetails = items.filter(item => !runs.has(item.runId) && ['tool', 'assistant'].includes(item.type) && !problem(item) && !['running', 'preparing', 'streaming'].includes(item.state ?? ''));
      const hidden = new Set([...waiting, ...system, ...historyDetails].map(item => item.id));
      const grouped = new Map<string | undefined, DisplayItem[]>();
      for (const item of items) { const children = grouped.get(item.runId) ?? []; children.push(item); grouped.set(item.runId, children); }
      const renderRun = (run: DisplayItem) => {
        const expanded = this.model.expanded.has(run.id);
        const running = run.state === 'running';
        const children = grouped.get(run.runId) ?? [];
        const events = new Set<string>();
        const renderEvents = (record: DisplayItem) => {
          let found = false;
          for (const id of record.eventIds ?? []) {
            const event = this.model.items.get(id);
            if (!event || event.type !== 'environment') continue;
            found = true;
            if (!events.has(id)) { events.add(id); render(event); }
          }
          // Runs retain their trigger even after the bounded event buffer has evicted it.
          if (!found) append(record.id, [...new Text(dim(`${time(record.at).slice(0, 5)}  ${ui('Observation', '观察')}`), 0, 0).render(width), ...new Text(plainText(record.text), width > 6 ? 2 : 0, 0).render(width), '']);
        };
        if (lines.length && lines.at(-1) !== '') append(run.id, ['']);
        renderEvents(run);
        for (const child of children) {
          if (child.type === 'observation' && child.id !== run.observationId && child.state === 'accepted') renderEvents(child);
          else if (child.type === 'environment' && !hidden.has(child.id) && !events.has(child.id)) { events.add(child.id); render(child); }
          else if (child.type === 'action') render(child);
        }
        const tools = children.filter(child => child.type === 'tool');
        const outputs = children.filter(child => child.type === 'assistant');
        const duration = run.durationMs === undefined ? '' : ` · ${elapsed(run.durationMs)}`;
        const selected = this.model.selected === run.id;
        const noAction = run.summary?.startsWith(ui('No external action', '未采取对外行动'));
        const status = run.state === 'error' ? ui('Run failed', '本轮失败') : run.state === 'interrupted' ? ui('Run interrupted', '本轮中断') : problem(run) ? run.summary : noAction ? ui('No external action', '未采取对外行动') : '';
        if (status) append(run.id, new Text(outcomeStyle(run, `${problem(run) ? '! ' : ''}${status}`, this.model.theme), 0, 0).render(width));
        const summary = `${expanded ? '▾' : '▸'} ${ui(`${tools.length} tool calls`, `${tools.length} 次工具调用`)}${duration}${outputs.length ? ui(` · ${outputs.length} model outputs (not sent)`, ` · ${outputs.length} 条模型输出（未发送）`) : ''}`;
        append(run.id, new Text(selected ? accent(summary) : dim(summary), width > 6 ? 2 : 0, 0).render(width));
        for (const child of children) {
          if (!['tool', 'assistant'].includes(child.type)) continue;
          if (expanded || this.model.expanded.has(child.id) || problem(child) || running && ['preparing', 'running'].includes(child.state ?? '')) render(child);
        }
        append(run.id, ['']);
      };
      for (const item of items) {
        if (item.type === 'run') renderRun(item);
        else if (!hidden.has(item.id) && !triggerIds.has(item.id) && !runs.has(item.runId) && item.type !== 'observation') render(item);
      }
      if (waiting.length) {
        const id = 'display:waiting';
        const age = elapsed(Date.now() - Math.min(...waiting.map(item => item.receivedAt ?? item.at)));
        append(id, ['', `${accent(this.model.expanded.has(id) ? '▾' : '▸')} ${ui(`${waiting.length} received · not yet included in the model`, `新收到 ${waiting.length} 条 · 尚未纳入模型`)}${dim(` · ${ui('Oldest waiting', '最早等待')} ${age}`)}`]);
        const preview = this.model.expanded.has(id) ? waiting : waiting.slice(-1);
        for (const item of preview) {
          const state = item.state === 'processing' ? ui('Waiting to be included', '等待纳入') : ui('Waiting for observation', '等待观察');
          if (this.model.expanded.has(id) || this.model.expanded.has(item.id)) render(item);
          else append(item.id, [truncateToWidth(`  ${dim(`${time(item.at)} ${state} · `)}${item.source ?? ''} · ${oneLine(item.text)}`, width)]);
        }
      }
      if (historyDetails.length) {
        const id = 'display:history-details';
        append(id, ['', dim(`${this.model.expanded.has(id) ? '▾' : '▸'} ${ui(`${historyDetails.length} historical tool / model records`, `${historyDetails.length} 条历史工具／模型记录`)}`)]);
        for (const item of historyDetails) if (this.model.expanded.has(id) || this.model.expanded.has(item.id)) render(item);
      }
      if (system.length) {
        const id = 'display:system';
        append(id, ['', dim(`${this.model.expanded.has(id) ? '▾' : '▸'} ${ui(`${system.length} system / heartbeat records`, `${system.length} 条系统／心跳记录`)} · /details`)]);
        if (this.model.expanded.has(id)) for (const item of system) render(item);
      }
    }
    if (!items.length) lines.push(...new Text(this.model.filter ? ui('No matching records; use /filter all to clear the filter.', '没有匹配的记录；/filter all 清除筛选。') : ui('Waiting for environment events and model activity…', '等待环境事件和模型活动……'), 0, 0).render(Math.max(1, width)));
    this.model.selectionOrder = [...new Set(this.rows.values())];
    return lines.map(line => line ? padding + line : '');
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== 'click' || event.button !== 'left') return;
    const id = this.rows.get(event.y); if (!id) return;
    this.model.toggle(id); return { handled: true, render: true };
  }
}

/** A stable activity row; detailed request telemetry is available with /details. */
export class ActivityLine implements Component {
  constructor(readonly model: DisplayModel, private now = Date.now) {}
  get active() { return Boolean(this.model.connected && this.model.status?.busy); }
  invalidate() {}
  render(width: number) {
    const { accent, warning } = this.model.theme;
    const busy = this.model.connected ? this.model.status?.busy : undefined;
    if (!this.model.connected) return [inset(warning(ui('! Waiting for daemon · Last known state', '! 等待常驻进程 · 显示最后已知状态')), width)];
    if (!busy) return [inset(this.model.status?.paused ? warning(ui('Ⅱ Paused · Still receiving events', 'Ⅱ 已暂停 · 仍在接收事件')) : dim(ui('· Idle · Waiting for environment events', '· 空闲 · 等待新的环境事件')), width)];
    const now = this.now();
    const modelStage = ['waiting', 'thinking', 'writing', 'calling', 'compacting'].includes(busy.stage);
    const startedAt = modelStage ? busy.requestStartedAt ?? busy.stageSince ?? busy.since : busy.stageSince ?? busy.since;
    const stalled = modelStage && now - (busy.lastOutputAt ?? startedAt) >= 120_000;
    const phase = `${busyLabel({ ...busy, tool: busy.tool ? toolLabel(busy.tool) : undefined })}${stalled ? ui(' · Waiting longer than usual', ' · 等待较久') : ''}`;
    const timing = modelStage && busy.requestStartedAt !== undefined ? ui(`Request ${busy.requestCount ?? 1}: ${elapsed(now - startedAt)}`, `第 ${busy.requestCount ?? 1} 次请求 ${elapsed(now - startedAt)}`) : ui(`Stage ${elapsed(now - startedAt)}`, `当前阶段 ${elapsed(now - startedAt)}`);
    const since = elapsed(now - startedAt);
    const recent = modelStage && busy.lastOutputAt !== undefined && !this.model.showDetails && width >= 90 ? ui(` · Last output ${elapsed(now - busy.lastOutputAt)} ago`, ` · 最近输出 ${elapsed(now - busy.lastOutputAt)} 前`) : '';
    const lines = [`${accent(spinner[Math.floor(now / spinnerMs) % spinner.length]!)} ${stalled ? warning(`${plainText(phase)}…`) : accent(`${plainText(phase)}…`)}${dim(` · ${this.model.showDetails ? timing : since}${recent}`)}`];
    if (modelStage && (this.model.showDetails || stalled)) {
      const progress = busy.outputChunks === undefined ? ui('Streaming progress unavailable', '流式进度未知') : busy.lastOutputAt === undefined ? ui('First output has not arrived', '首个响应片段尚未收到') : ui(`${busy.outputChunks} chunks · Last output ${elapsed(now - busy.lastOutputAt)} ago`, `已收到 ${busy.outputChunks} 个片段 · 距上次输出 ${elapsed(now - busy.lastOutputAt)}`);
      lines.push(dim(`  ${progress}${stalled ? ui(' · No recent output; a stall is not confirmed', ' · 暂无新输出，尚不能确认卡住') : ''}`));
    }
    if (this.model.showDetails && busy.lastCompletedTool) lines.push(dim(`  ${ui('Last completed', '最近完成')} · ${toolLabel(busy.lastCompletedTool)}`));
    return lines.map(line => inset(line, width));
  }
}

export interface TuiSession { tui: TuiAltScreen; model: DisplayModel; close(): void }
export function createTui(path: string, terminal: Terminal = new ProcessTerminal()): TuiSession {
  const model = new DisplayModel();
  const { accent, success, warning } = model.theme;
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true, scrollToEndIndicator: () => ui(`↓ ${model.unseen} new · Ctrl+End to follow`, `↓ 新增 ${model.unseen} 条 · Ctrl+End 跟随`) });
  const timeline = new Timeline(model);
  const activity = new ActivityLine(model);
  const activityBlock: Component = { invalidate() {}, render(width) {
    const lines = activity.render(width);
    return lines.length ? ['', ...lines] : [];
  } };
  const scroll = new ScrollView(timeline, { follow: 'end', primary: true });
  const header: Component = { invalidate() {}, render(width) {
    const s = model.status;
    const connection = !model.connected ? warning(ui('! Daemon disconnected · Reconnecting', '! 常驻进程断开 · 自动重连中'))
      : s ? (['Connected', '已连接'].includes(s.connection) ? success : warning)(`● QQ ${s.connection}`) : dim(ui('Waiting for status', '等待状态'));
    const health = [connection, ...(model.connected && s ? [s.paused ? warning(ui('Paused · Still receiving', '整体暂停 · 仍在接收')) : dim(ui(`Autonomous life ${s.lifeEnabled ? 'on' : 'off'}`, `自主生活 ${s.lifeEnabled ? '开' : '关'}`))] : [])];
    return [inset(`${accent('☾')} ${bold(ui('Qiuyue', '秋月'))}  ${dim(ui('Management terminal', '管理终端'))}${width >= 90 && s ? dim(` · ${s.model}`) : ''}`, width),
      ...new Text(health.join(dim(' · ')), gutter(width), 0).render(width), ''];
  } };
  const input = new CommandInput(model.theme, () => Math.min(5, Math.max(1, terminal.rows - 14)));
  const footer: Component = { invalidate() {}, render(width) {
    const s = model.status;
    const parts = s && !input.suggestions.length ? [
      ...(model.filter ? [accent(ui(`Filter ${model.filter}`, `筛选 ${model.filter}`))] : []),
      dim(`${ui('Context', '上下文')} ${humanTokens(s.contextTokens)}/${humanTokens(s.contextLimit)}${s.contextTokens !== undefined && Number.isFinite(s.contextTokens) && s.contextLimit > 0 ? ` · ${Math.round(s.contextTokens / s.contextLimit * 100)}%` : ''}`),
    ] : [];
    const available = Math.max(0, width - 2 * gutter(width));
    const hints = input.suggestions.length ? [ui('↑↓ select · Tab complete · Esc close', '↑↓ 选择 · Tab 补全 · Esc 关闭'), ui('Tab complete', 'Tab 补全')]
      : [ui('Tab details · Ctrl+End follow · Ctrl+C exit', 'Tab 详情 · Ctrl+End 跟随 · Ctrl+C 退出界面'), ui('Tab details · /help', 'Tab 详情 · /help'), '/help'];
    const join = () => parts.join(dim(' · '));
    while (parts.length > 1 && visibleWidth(join()) + 3 + 5 > available) parts.pop();
    const left = join();
    const hint = dim(hints.find(text => visibleWidth(text) + visibleWidth(left) + 3 <= available) ?? '');
    const space = available - visibleWidth(left) - visibleWidth(hint);
    return [inset(space >= 3 ? left + ' '.repeat(space) + hint : left, width)];
  } };
  const inputRow = new HStack([
    { component: new Text('', 0, 0), basis: 2, shrink: 1 },
    { component: input, basis: 0, grow: 1, minSize: 1 },
    { component: new Text('', 0, 0), basis: 2, shrink: 1 },
  ]);
  const rule: Component = { invalidate() {}, render(width) {
    return [inset(dim('─'.repeat(Math.max(0, width - 2 * gutter(width)))), width)];
  } };
  let showNote = false;
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const notice: Component = { invalidate() {}, render(width) {
    if (!showNote) return [];
    const padding = gutter(width);
    return new Text(plainText(model.note), padding, 0).render(Math.max(1, width));
  } };
  const setNote = (message: string, duration = 6000) => {
    model.note = plainText(message); showNote = true; clearTimeout(noteTimer);
    if (duration) noteTimer = setTimeout(() => { showNote = false; tui.requestRender(); }, duration);
    tui.requestRender();
  };
  tui.setLayoutRoot(new VStack([
    { component: header, basis: 'auto', shrink: 1 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: activityBlock, basis: 'auto', shrink: 1 },
    { component: notice, basis: 'auto', shrink: 1 },
    { component: input.palette, basis: 'auto', shrink: 1 },
    { component: rule, basis: 1, shrink: 1 },
    { component: inputRow, basis: 1, minSize: 1 },
    { component: rule, basis: 1, shrink: 1 },
    { component: footer, basis: 1, shrink: 1 },
  ]));
  tui.setFocus(input);
  let stopped = false;
  let stopFollowing = () => {};
  let ticker: ReturnType<typeof setInterval> | undefined;
  // Animate only while busy; the terminal tab's progress indicator mirrors the same state.
  const syncActivity = () => {
    if (activity.active === Boolean(ticker) || stopped) return;
    if (ticker) { clearInterval(ticker); ticker = undefined; } else ticker = setInterval(() => tui.requestRender(), spinnerMs);
    terminal.setProgress(activity.active);
  };
  const close = () => { if (stopped) return; stopped = true; clearInterval(ticker); clearTimeout(noteTimer); stopFollowing(); tui.stop(); };
  const localCommands = (value: string) => {
    const [command, ...rest] = value.trim().split(/\s+/u);
    if (command === '/quit' || command === '/exit') { close(); return; }
    if (command === '/help') { setNote(ui('/pause /resume /life on|off /status /details /filter keyword|errors|all /expand /collapse /quit\nType / to browse · Alt↑↓ select records · Tab details · Ctrl+End follow\nEsc closes help · Ctrl+C exits only the viewer.', '/pause /resume /life on|off /status /details /filter 关键词|errors|all /expand /collapse /quit\n输入 / 浏览命令 · Alt↑↓ 选择记录 · Tab 详情 · Ctrl+End 跟随\nEsc 关闭帮助 · Ctrl+C 只退出界面，数字生命继续运行。'), 0); }
    else if (command === '/details') { model.showDetails = !model.showDetails; timeline.invalidate(); setNote(model.showDetails ? ui('Full records · /details returns to conversations', '完整记录 · /details 返回交流视图') : ui('Conversations · Tab expands the selected details', '交流视图 · Tab 展开所选详情')); }
    else if (command === '/filter') { model.filter = rest.join(' ') === 'all' ? '' : rest.join(' '); model.selected = undefined; setNote(ui('Filtering affects only the display; event reception and reasoning continue.', '筛选只影响展示；事件接收和思考保持运行。')); }
    else if (command === '/expand') model.toggle();
    else if (command === '/collapse') model.expanded.clear();
    else if ((command === '/pause' || command === '/resume' || command === '/status') && rest.length === 0 || command === '/life' && rest.length === 1 && ['on', 'off'].includes(rest[0]!)) {
      setNote(ui(`${command} submitted; waiting for confirmation…`, `${command} 已提交，等待确认……`), 0);
      void callControl(path, { args: [command!.slice(1), ...rest] }).then(result => {
        if (stopped) return;
        if (command !== '/status') { setNote(ui(`${command} confirmed`, `${command} 已确认`)); return; }
        const status = result as { paused: boolean; lifeEnabled: boolean; pendingEvents: number; modelCallsToday: number; actionsThisHour: number };
        setNote([
          ui(`${status.paused ? 'Paused' : 'Running'} · Autonomous life ${status.lifeEnabled ? 'on' : 'off'}`, `${status.paused ? '整体暂停' : '运行中'} · 自主生活 ${status.lifeEnabled ? '开' : '关'}`),
          ui(`Pending ${status.pendingEvents} · ${status.modelCallsToday} model calls today · ${status.actionsThisHour} actions this hour`, `待处理 ${status.pendingEvents} · 今日模型调用 ${status.modelCallsToday} · 本小时行动 ${status.actionsThisHour}`),
          ui('Esc to close', 'Esc 关闭'),
        ].join('\n'), 0);
      }).catch(error => { if (!stopped) setNote(ui(`Action not confirmed: ${error.message}`, `操作未确认：${error.message}`), 0); });
    } else setNote(ui('Enter a supported management command; use /help to view commands. Ordinary text is not sent to the Agent or QQ.', '请输入支持的管理命令；/help 查看。普通文字不会发送给 Agent 或 QQ。'), 0);
    tui.requestRender();
  };
  input.onSubmit = value => { input.setValue(''); showNote = false; clearTimeout(noteTimer); localCommands(value); };
  input.onEscape = () => { showNote = false; clearTimeout(noteTimer); tui.requestRender(); };
  tui.addInputListener(data => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) { close(); return { consume: true }; }
    if (matchesKey(data, 'alt+up') || matchesKey(data, 'alt+down')) {
      model.select(matchesKey(data, 'alt+up') ? -1 : 1);
      const row = model.selected ? timeline.rowOf(model.selected) : undefined;
      if (row !== undefined && (row < scroll.scrollTop || row >= scroll.scrollTop + scroll.viewportHeight)) scroll.scrollTo(Math.max(0, row - 1));
      tui.requestRender(); return { consume: true };
    }
    if (matchesKey(data, 'tab') && !input.suggestions.length) { model.toggle(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+end')) { scroll.scrollToEnd(); model.unseen = 0; tui.requestRender(); return { consume: true }; }
    return undefined;
  });
  tui.start();
  const refreshTheme = () => { timeline.invalidate(); tui.requestRender(); };
  tui.onTerminalColorSchemeChange(scheme => { if (!stopped) { model.theme.setScheme(scheme); refreshTheme(); } });
  tui.setTerminalColorSchemeNotifications(true);
  void tui.queryTerminalColors({ timeoutMs: 200, onLateReply: colors => { if (!stopped) { model.theme.setColors(colors); refreshTheme(); } } }).then(colors => { if (!stopped) { model.theme.setColors(colors); refreshTheme(); } });
  stopFollowing = followDisplay(path, packet => {
    model.apply(packet, scroll.isFollowingEnd);
    if (packet.type === 'snapshot') { timeline.invalidate(); tui.resetTextSelection(); if (packet.reason) setNote(packet.reason, 8000); }
    syncActivity(); tui.requestRender();
  }, (connected, message) => {
    const previous = model.connectionMessage;
    model.connected = connected; model.connectionMessage = plainText(message);
    if (!connected || model.note === previous) setNote(model.connectionMessage);
    syncActivity(); tui.requestRender();
  });
  return { tui, model, close };
}

export function runTui(path: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI requires an interactive terminal; use logs --follow for redirected output.');
  const session = createTui(path);
  const stop = () => { session.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
