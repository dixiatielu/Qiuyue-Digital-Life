import { ui } from './ui-language.js';
import { HStack, Input, Markdown, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, indexedColor, matchesKey, styleText, truncateToWidth, visibleWidth, getTerminalColorMode, type Component, type MarkdownTheme, type Terminal, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { callControl } from './control.js';
import { followDisplay } from './display-client.js';
import { busyLabel, plainText, type DisplayItem, type DisplayPacket, type DisplayStatus } from './monitor.js';

const labels = (): Record<string, string> => ({
  pending: ui('Waiting for remote receipt', '等待远端回执'), success: ui('Success', '成功'), failed: ui('Failed', '失败'), unknown: ui('Unknown', '结果未知'),
  preparing: ui('Preparing arguments', '生成参数中'), running: ui('Running', '执行中'), done: ui('Tool completed', '工具完成'), error: ui('Error', '错误'),
  streaming: ui('Generating', '生成中'), stop: ui('Completed', '完成'), interrupted: ui('Interrupted', '已中断'), aborted: ui('Cancelled', '已取消'),
  queued: ui('Waiting for observation', '等待纳入观察'), accepted: ui('Included in observation', '已纳入观察'), processed: ui('Recorded', '已记录'),
});
const time = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const humanTokens = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? '—' : value >= 1024 ? `${(value / 1024).toFixed(1)}K` : String(value);
const bold = (text: string) => styleText(text, { bold: true }, getTerminalColorMode());
const dim = (text: string) => styleText(text, { dim: true }, getTerminalColorMode());
const color = (text: string, index: number) => styleText(text, { fg: indexedColor(index) }, getTerminalColorMode());
const accent = (text: string) => color(text, 147);
const success = (text: string) => color(text, 114);
const warning = (text: string) => color(text, 179);
const danger = (text: string) => color(text, 167);
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
const outcomeStyle = (item: DisplayItem, text: string) => item.state === 'unknown' ? warning(text) : problem(item) ? danger(text) : dim(text);
const marker = (item: DisplayItem, selected: boolean) => selected ? accent('›') : problem(item) ? outcomeStyle(item, symbol(item)) : symbol(item) === '✓' ? success('✓') : ['running', 'preparing', 'streaming'].includes(item.state ?? '') ? accent(symbol(item)) : dim(symbol(item));
function argumentSummary(item: DisplayItem) {
  try {
    const args = JSON.parse(item.text);
    return oneLine([args.group_id ? ui(`Group ${args.group_id}`, `群 ${args.group_id}`) : args.user_id ? ui(`Private ${args.user_id}`, `私聊 ${args.user_id}`) : '',
      ...['query', 'message', 'title', 'url'].map(key => typeof args[key] === 'string' ? args[key] : '')].filter(Boolean).join(' · ')).slice(0, 160);
  } catch { return ''; }
}
const theme: MarkdownTheme = {
  heading: bold, link: accent, linkUrl: dim, code: accent, codeBlock: text => text,
  codeBlockBorder: dim, quote: text => text, quoteBorder: dim, hr: dim, listBullet: text => text,
  bold, italic: text => text, strikethrough: text => text, underline: text => text,
};

/** The same packet reducer is used for snapshots, live updates and reconnect replay. */
export class DisplayModel {
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
  private cache = new Map<string, { item: DisplayItem; width: number; selected: boolean; expanded: boolean; lines: string[] }>();
  constructor(readonly model: DisplayModel) {}
  invalidate() { this.cache.clear(); for (const markdown of this.markdown.values()) markdown.invalidate(); }
  rowOf(id: string) { for (const [row, itemId] of this.rows) if (id === itemId) return row; return undefined; }
  private renderItem(item: DisplayItem, width: number, selected: boolean, expanded: boolean) {
    const lines: string[] = [];
    const stateLabel = item.type === 'environment' ? ({ pending: ui('Waiting for observation', '等待观察'), processing: ui('Waiting to be included', '等待纳入'), accepted: ui('Included in observation', '已纳入观察'), processed: ui('Recorded', '已记录') } as Record<string, string>)[item.state ?? ''] : labels()[item.state ?? ''];
    const state = item.state ? `[${stateLabel ?? item.state}] ` : '';
    if (!expanded && item.type !== 'assistant') {
      const name = item.type === 'tool' ? `${toolLabel(item.title)}${toolLabel(item.title) === item.title ? '' : dim(` · ${item.title}`)}` : item.title;
      const summary = item.type === 'tool' || item.type === 'action' ? argumentSummary(item) : oneLine(item.text);
      const duration = item.durationMs === undefined ? '' : ` · ${item.durationMs < 10_000 ? `${(item.durationMs / 1000).toFixed(1)}s` : elapsed(item.durationMs)}`;
      const line = `${marker(item, selected)} ${problem(item) ? outcomeStyle(item, state) : ''}${dim(time(item.at))} ${selected ? accent(name) : name}${dim(duration)}${summary ? ` · ${summary}` : ''}${item.details || item.text ? dim(' ▸') : ''}`;
      // Put the outcome on its own line in very narrow terminals.
      if (problem(item) && width < 40) lines.push(...new Text(state.trim(), 0, 0).render(Math.max(1, width)));
      lines.push(truncateToWidth(line, width));
      return lines;
    }
    if (state && width < 40) lines.push(...new Text(state.trim(), 0, 0).render(Math.max(1, width)));
    const title = `${marker(item, selected)} ${width < 40 ? '' : outcomeStyle(item, state)}${dim(time(item.at))}  ${selected ? accent(plainText(item.title)) : plainText(item.title)}`;
    lines.push(truncateToWidth(title, width));
    let body = plainText(item.text);
    if (!expanded && item.type !== 'assistant') body = body.split('\n').slice(0, 3).join('\n').slice(0, 400);
    if (body) {
      if (item.type === 'assistant') {
        let markdown = this.markdown.get(item.id);
        if (!markdown) { markdown = new Markdown(body, 2, 0, theme); this.markdown.set(item.id, markdown); }
        else markdown.setText(body);
        lines.push(...markdown.render(Math.max(1, width)));
      } else lines.push(...new Text(body, width > 4 ? 2 : 0, 0).render(Math.max(1, width)));
    }
    if (expanded && item.details) lines.push(...new Text(dim(plainText(item.details)), width > 4 ? 2 : 0, 0).render(Math.max(1, width)));
    lines.push('');
    return lines.map(line => truncateToWidth(line, width));
  }
  render(width: number) {
    const padding = ' '.repeat(gutter(width));
    width = Math.max(1, width - padding.length * 2);
    this.rows.clear();
    const items = this.model.filter || this.model.showDetails ? this.model.visible() : [...this.model.items.values()]; const lines: string[] = [];
    if (!this.model.filter && !this.model.showDetails) lines.push(...[
      ui('A continuing life, with its own memories.', '拥有持续记忆的数字生命。'),
      dim(ui('/help for commands · Exiting leaves the digital life running', '/help 查看命令 · 退出界面后数字生命继续运行')), '',
    ].map(line => truncateToWidth(line, width)));
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
      if (cached?.item !== item || cached.width !== width || cached.selected !== selected || cached.expanded !== expanded) {
        cached = { item, width, selected, expanded, lines: this.renderItem(item, width, selected, expanded) };
        this.cache.set(item.id, cached);
      }
      lines.push(...cached.lines);
      for (let row = start; row < lines.length; row++) this.rows.set(row, item.id);
    };
    if (this.model.filter || this.model.showDetails) {
      for (const item of items) render(item);
    } else {
      const runs = new Map(items.filter(item => item.type === 'run').map(item => [item.runId, item]));
      const waiting = items.filter(item => item.type === 'environment' && !item.quiet && ['pending', 'processing'].includes(item.state ?? ''));
      const waitingIds = new Set(waiting.map(item => item.id));
      const system = items.filter(item => !waitingIds.has(item.id) && (item.quiet || item.type === 'system' && !problem(item) || item.type === 'environment' && (item.eventKind === 'perception_gap' || item.eventKind?.startsWith('meta_event:'))));
      const hidden = new Set([...waiting, ...system].map(item => item.id));
      const renderRun = (run: DisplayItem) => {
        const expanded = this.model.expanded.has(run.id);
        const running = run.state === 'running';
        const outcome = running ? ui('Started thinking', '开始思考') : run.state === 'error' ? ui('Run failed', '本轮失败') : run.state === 'interrupted' ? ui('Run interrupted', '本轮中断') : ui('Run ended', '本轮结束');
        const duration = run.durationMs === undefined ? '' : ` · ${elapsed(run.durationMs)}`;
        if ((running || expanded) && lines.length && lines.at(-1) !== '') append(run.id, ['']);
        const selected = this.model.selected === run.id;
        append(run.id, [`${marker(run, selected)} ${dim(time(run.at))} ${running || selected ? accent(outcome) : problem(run) ? outcomeStyle(run, outcome) : outcome}${dim(duration)}${!running && run.summary ? outcomeStyle(run, ` · ${run.summary}`) : ''} ${dim(expanded ? '▾' : '▸')}`]);
        if (!running && !expanded) return;
        append(run.id, [`  ${dim(`${ui('Trigger', '触发')} · ${ui(`${run.eventIds?.length ?? 0} events`, `${run.eventIds?.length ?? 0} 条事件`)} · `)}${oneLine(run.text.split('\n')[0] ?? '')}`]);
        if (expanded && run.details) append(run.id, new Text(dim(run.details), 2, 0).render(Math.max(1, width)));
        for (const child of items) {
          if (child.runId !== run.runId || child.id === run.id || child.type === 'environment' || child.type === 'system' || child.id === run.observationId) continue;
          if (child.type === 'observation' && child.state !== 'accepted' || child.type === 'action' && !problem(child)) continue;
          if (child.type === 'observation') append(child.id, [`  ${dim(`↳ ${ui('Included', '已纳入')} ${child.title} · `)}${oneLine(child.text)} ${dim(this.model.expanded.has(child.id) ? '▾' : '▸')}`]);
          else render(child);
          if (child.type === 'observation' && this.model.expanded.has(child.id)) append(child.id, new Text(child.text, 2, 0).render(Math.max(1, width)));
        }
      };
      for (const item of items) {
        if (item.type === 'run') renderRun(item);
        else if (!hidden.has(item.id) && !runs.has(item.runId) && item.type !== 'observation') render(item);
      }
      if (waiting.length) {
        const id = 'display:waiting';
        const age = elapsed(Date.now() - Math.min(...waiting.map(item => item.receivedAt ?? item.at)));
        append(id, ['', `${accent(this.model.expanded.has(id) ? '▾' : '▸')} ${ui(`${waiting.length} received · not yet included in the model`, `新收到 ${waiting.length} 条 · 尚未纳入模型`)}${dim(` · ${ui('Oldest waiting', '最早等待')} ${age}`)}`]);
        const preview = this.model.expanded.has(id) ? waiting : waiting.slice(-1);
        for (const item of preview) {
          const state = item.state === 'processing' ? ui('Waiting to be included', '等待纳入') : ui('Waiting for observation', '等待观察');
          append(item.id, [truncateToWidth(`  ${dim(`${time(item.at)} ${state} · `)}${item.source ?? ''} · ${oneLine(item.text)}`, width)]);
          if (this.model.expanded.has(item.id)) render(item);
        }
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

/** Shown above the footer only while a thinking run is in progress, like a coding agent's spinner row. */
export class ActivityLine implements Component {
  constructor(readonly model: DisplayModel, private now = Date.now) {}
  get active() { return Boolean(this.model.connected && this.model.status?.busy); }
  invalidate() {}
  render(width: number) {
    const busy = this.model.connected ? this.model.status?.busy : undefined;
    if (!busy) return [];
    const now = this.now();
    const modelStage = ['waiting', 'thinking', 'writing', 'calling', 'compacting'].includes(busy.stage);
    const startedAt = modelStage ? busy.requestStartedAt ?? busy.stageSince ?? busy.since : busy.stageSince ?? busy.since;
    const stalled = modelStage && now - (busy.lastOutputAt ?? startedAt) >= 120_000;
    const phase = `${busyLabel(busy)}${stalled ? ui(' · Waiting longer than usual', ' · 等待较久') : ''}`;
    const timing = modelStage && busy.requestStartedAt !== undefined ? ui(`Request ${busy.requestCount ?? 1}: ${elapsed(now - startedAt)}`, `第 ${busy.requestCount ?? 1} 次请求 ${elapsed(now - startedAt)}`) : ui(`Stage ${elapsed(now - startedAt)}`, `当前阶段 ${elapsed(now - startedAt)}`);
    const lines = [`${accent(spinner[Math.floor(now / spinnerMs) % spinner.length]!)} ${stalled ? warning(`${plainText(phase)}…`) : accent(`${plainText(phase)}…`)}${dim(` · ${timing}`)}`];
    if (modelStage) {
      const progress = busy.outputChunks === undefined ? ui('Streaming progress unavailable', '流式进度未知') : busy.lastOutputAt === undefined ? ui('First output has not arrived', '首个响应片段尚未收到') : ui(`${busy.outputChunks} chunks · Last output ${elapsed(now - busy.lastOutputAt)} ago`, `已收到 ${busy.outputChunks} 个片段 · 距上次输出 ${elapsed(now - busy.lastOutputAt)}`);
      lines.push(dim(`  ${progress}${stalled ? ui(' · No recent output; a stall is not confirmed', ' · 暂无新输出，尚不能确认卡住') : ''}`));
    }
    if (busy.lastCompletedTool) lines.push(dim(`  ${ui('Last completed', '最近完成')} · ${toolLabel(busy.lastCompletedTool)}`));
    return lines.map(line => inset(line, width));
  }
}

export interface TuiSession { tui: TuiAltScreen; model: DisplayModel; close(): void }
export function createTui(path: string, terminal: Terminal = new ProcessTerminal()): TuiSession {
  const model = new DisplayModel();
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
    return [inset(`${accent('☾')} ${bold(ui('Qiuyue', '秋月'))}${dim(` · ${s?.model ?? ui('Waiting for status', '等待状态')}`)}`, width), ''];
  } };
  const footer: Component = { invalidate() {}, render(width) {
    const s = model.status;
    const parts = s ? [
      model.connected ? dim(`QQ ${s.connection}`) : warning(ui('Disconnected · Last status', '连接断开 · 最后状态')),
      ...(s.paused ? [warning(ui('Paused', '整体暂停'))] : []),
      ...(model.filter ? [accent(ui(`Filter ${model.filter}`, `筛选 ${model.filter}`))] : []),
      dim(`${ui('Life', '生活')}${s.lifeEnabled ? ui(' on', '开启') : ui(' off', '关闭')}`),
      dim(`${ui('Context', '上下文')} ${humanTokens(s.contextTokens)}/${humanTokens(s.contextLimit)}`),
      dim(`${ui('Pending', '待处理')} ${s.pendingEvents}`),
      dim(ui(`${s.modelCallsToday} calls today`, `今日调用 ${s.modelCallsToday}`)),
      dim(ui(`${s.actionsThisHour} actions this hour`, `本小时行动 ${s.actionsThisHour}`)),
    ] : [dim(model.connectionMessage)];
    const available = Math.max(0, width - 2 * gutter(width));
    const hint = dim(available >= 70 ? ui('/help · Tab expand · Ctrl+C exit', '/help · Tab 展开 · Ctrl+C 退出') : '/help');
    const join = () => parts.join(dim(' · '));
    while (parts.length > 1 && visibleWidth(join()) + visibleWidth(hint) + 3 > available) parts.pop();
    const left = join();
    const space = available - visibleWidth(left) - visibleWidth(hint);
    return [inset(space >= 3 ? left + ' '.repeat(space) + hint : left, width)];
  } };
  const input = new Input({ prompt: accent('› '), placeholder: ui('Management command · /help', '输入管理命令 · /help'), placeholderStyle: dim });
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
    if (command === '/help') { setNote(ui('/pause /resume /life on|off /status /details /filter keyword|errors|all /expand /collapse /quit\nAlt↑↓ select · Tab expand · Ctrl+End follow · Ctrl+C exit\nExiting leaves the digital life running.', '/pause /resume /life on|off /status /details /filter 关键词|errors|all /expand /collapse /quit\nAlt↑↓ 选择 · Tab 展开 · Ctrl+End 跟随 · Ctrl+C 退出\n退出界面后数字生命继续运行。'), 0); }
    else if (command === '/details') { model.showDetails = !model.showDetails; timeline.invalidate(); setNote(model.showDetails ? ui('Full records · /details returns to the compact timeline', '完整记录 · /details 返回紧凑时间线') : ui('Compact timeline · Tab expands the selected item', '紧凑时间线 · Tab 展开所选项')); }
    else if (command === '/filter') { model.filter = rest.join(' ') === 'all' ? '' : rest.join(' '); model.selected = undefined; setNote(ui('Filtering affects only the display; event reception and reasoning continue.', '筛选只影响展示；事件接收和思考保持运行。')); }
    else if (command === '/expand') model.toggle();
    else if (command === '/collapse') model.expanded.clear();
    else if ((command === '/pause' || command === '/resume' || command === '/status') && rest.length === 0 || command === '/life' && rest.length === 1 && ['on', 'off'].includes(rest[0]!)) {
      setNote(ui(`${command} submitted; waiting for confirmation…`, `${command} 已提交，等待确认……`), 0);
      void callControl(path, { args: [command!.slice(1), ...rest] }).then(() => { if (!stopped) setNote(ui(`${command} confirmed`, `${command} 已确认`)); }).catch(error => { if (!stopped) setNote(ui(`Action not confirmed: ${error.message}`, `操作未确认：${error.message}`), 0); });
    } else setNote(ui('Enter a supported management command; use /help to view commands. Ordinary text is not sent to the Agent or QQ.', '请输入支持的管理命令；/help 查看。普通文字不会发送给 Agent 或 QQ。'), 0);
    tui.requestRender();
  };
  input.onSubmit = value => { input.setValue(''); showNote = false; clearTimeout(noteTimer); localCommands(value); };
  tui.addInputListener(data => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) { close(); return { consume: true }; }
    if (matchesKey(data, 'alt+up') || matchesKey(data, 'alt+down')) {
      model.select(matchesKey(data, 'alt+up') ? -1 : 1);
      const row = model.selected ? timeline.rowOf(model.selected) : undefined;
      if (row !== undefined && (row < scroll.scrollTop || row >= scroll.scrollTop + scroll.viewportHeight)) scroll.scrollTo(Math.max(0, row - 1));
      tui.requestRender(); return { consume: true };
    }
    if (matchesKey(data, 'tab')) { model.toggle(); tui.requestRender(); return { consume: true }; }
    if (matchesKey(data, 'ctrl+end')) { scroll.scrollToEnd(); model.unseen = 0; tui.requestRender(); return { consume: true }; }
    return undefined;
  });
  tui.start();
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
