import { ui } from './ui-language.js';
import { Input, Markdown, ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, styleText, truncateToWidth, getTerminalColorMode, type Component, type MarkdownTheme, type Terminal, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { callControl } from './control.js';
import { followDisplay } from './display-client.js';
import { plainText, type DisplayItem, type DisplayPacket, type DisplayStatus } from './monitor.js';

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
const theme: MarkdownTheme = {
  heading: bold, link: text => text, linkUrl: dim, code: text => text, codeBlock: text => text,
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
      while (this.items.size > 200) { const id = this.items.keys().next().value!; this.items.delete(id); this.expanded.delete(id); }
    }
  }
  visible() {
    const filter = this.filter.toLocaleLowerCase();
    return [...this.items.values()].filter(item => filter === 'errors'
      ? ['error', 'failed', 'unknown'].includes(item.state ?? '') || item.title.includes('error')
      : filter ? `${item.title} ${item.text} ${item.source ?? ''} ${item.state ?? ''}`.toLocaleLowerCase().includes(filter) : !item.quiet);
  }
  select(direction: number) {
    const items = this.visible(); if (!items.length) return;
    const current = items.findIndex(item => item.id === this.selected);
    this.selected = items[Math.max(0, Math.min(items.length - 1, current < 0 ? items.length - 1 : current + direction))]!.id;
  }
  toggle(id = this.selected ?? this.visible().at(-1)?.id) {
    if (!id) return;
    this.selected = id;
    if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
  }
}

export class Timeline implements Component {
  private rows = new Map<number, string>();
  private markdown = new Map<string, Markdown>();
  constructor(readonly model: DisplayModel) {}
  invalidate() { for (const markdown of this.markdown.values()) markdown.invalidate(); }
  rowOf(id: string) { for (const [row, itemId] of this.rows) if (id === itemId) return row; return undefined; }
  render(width: number) {
    this.rows.clear();
    const items = this.model.visible(); const lines: string[] = [];
    const active = new Set(items.map(item => item.id));
    for (const id of this.markdown.keys()) if (!active.has(id)) this.markdown.delete(id);
    for (const item of items) {
      const start = lines.length;
      const selected = this.model.selected === item.id;
      const stateLabel = item.type === 'environment' ? ({ pending: ui('Waiting for observation', '等待观察'), processing: ui('Waiting to be included', '等待纳入'), accepted: ui('Included in observation', '已纳入观察'), processed: ui('Recorded', '已记录') } as Record<string, string>)[item.state ?? ''] : labels()[item.state ?? ''];
      const state = item.state ? `[${stateLabel ?? item.state}] ` : '';
      if (state && width < 40) lines.push(...new Text(state.trim(), 0, 0).render(Math.max(1, width)));
      const title = `${selected ? '›' : ' '}${width < 40 ? '' : state}${time(item.at)}  ${plainText(item.title)}`;
      lines.push(truncateToWidth(selected ? bold(title) : title, width));
      const expanded = this.model.expanded.has(item.id);
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
      if (expanded && item.details) lines.push(...new Text(plainText(item.details), width > 4 ? 2 : 0, 0).render(Math.max(1, width)));
      if (item.details) lines.push(truncateToWidth(dim(`  [${expanded ? ui('Expanded', '已展开') : ui('Click or press Tab to expand details', '点击或 Tab 展开详情')}]`), width));
      lines.push('');
      for (let row = start; row < lines.length; row++) this.rows.set(row, item.id);
    }
    if (!items.length) lines.push(...new Text(this.model.filter ? ui('No matching records; use /filter all to clear the filter.', '没有匹配的记录；/filter all 清除筛选。') : ui('Waiting for environment events and model activity…', '等待环境事件和模型活动……'), 0, 0).render(Math.max(1, width)));
    if (!this.model.filter) {
      const quiet = [...this.model.items.values()].filter(item => item.quiet).length;
      if (quiet) lines.push(truncateToWidth(dim(ui(`${quiet} heartbeat records collapsed; use /filter heartbeat to view`, `已折叠 ${quiet} 条心跳记录；/filter heartbeat 查看`)), width));
    }
    return lines.map(line => truncateToWidth(line, width));
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type !== 'click' || event.button !== 'left') return;
    const id = this.rows.get(event.y); if (!id) return;
    this.model.toggle(id); return { handled: true, render: true };
  }
}

export interface TuiSession { tui: TuiAltScreen; model: DisplayModel; close(): void }
export function createTui(path: string, terminal: Terminal = new ProcessTerminal()): TuiSession {
  const model = new DisplayModel();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true, scrollToEndIndicator: () => ui(`↓ ${model.unseen} new · Ctrl+End to follow`, `↓ 新增 ${model.unseen} 条 · Ctrl+End 跟随`) });
  const timeline = new Timeline(model);
  const scroll = new ScrollView(timeline, { follow: 'end', primary: true });
  const header: Component = { invalidate() {}, render(width) {
    const s = model.status;
    const line1 = `${ui('Digital life', '数字生命')} · ${s?.model ?? ui('Waiting for status', '等待状态')} · ${model.connected ? ui('Connected to daemon', '已连接常驻进程') : ui('Disconnected', '连接断开')}`;
    const line2 = s ? `${model.connected ? '' : ui('Last status · ', '最后状态 · ')}QQ ${s.connection} · ${s.paused ? ui('Paused', '整体暂停') : s.phase} · ${ui('Life', '生活')}${s.lifeEnabled ? ui(' on', '开启') : ui(' off', '关闭')} · ${ui('Pending', '待处理')} ${s.pendingEvents}` : model.connectionMessage;
    return [bold(truncateToWidth(line1, width)), truncateToWidth(line2, width), '─'.repeat(Math.max(0, width))];
  } };
  const footer: Component = { invalidate() {}, render(width) {
    const s = model.status;
    const stats = s ? `${ui('Context', '上下文')} ${humanTokens(s.contextTokens)} / ${humanTokens(s.contextLimit)} · ${ui('Calls today', '今日调用')} ${s.modelCallsToday} · ${ui('Actions this hour', '本小时行动')} ${s.actionsThisHour}` : ui('If the daemon is not running, use npm start -- run in another terminal', '常驻进程未运行时，请另开终端执行 npm start -- run');
    const filter = model.filter ? ui(` · Filter ${model.filter}`, ` · 筛选 ${model.filter}`) : '';
    return ['─'.repeat(Math.max(0, width)), truncateToWidth(stats + filter, width), truncateToWidth(plainText(model.note), width), truncateToWidth(dim(ui('Alt↑↓ Select · Tab Expand · PgUp/PgDn Page · Ctrl+End Follow · Ctrl+C Exit', 'Alt↑↓ 选择 · Tab 展开 · PgUp/PgDn 翻页 · Ctrl+End 跟随 · Ctrl+C 退出')), width)];
  } };
  const input = new Input({ prompt: '> ', placeholder: '/pause  /resume  /life on|off  /filter  /help' });
  tui.setLayoutRoot(new VStack([
    { component: header, basis: 'auto', shrink: 1 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    { component: footer, basis: 'auto', shrink: 1 },
    { component: input, basis: 1, minSize: 1 },
  ]));
  tui.setFocus(input);
  let stopped = false;
  let stopFollowing = () => {};
  const close = () => { if (stopped) return; stopped = true; stopFollowing(); tui.stop(); };
  const localCommands = (value: string) => {
    const [command, ...rest] = value.trim().split(/\s+/u);
    if (command === '/quit' || command === '/exit') { close(); return; }
    if (command === '/help') { model.note = ui('/pause /resume /life on|off /status /filter keyword|errors|all /expand /collapse /quit', '/pause /resume /life on|off /status /filter 关键词|errors|all /expand /collapse /quit'); }
    else if (command === '/filter') { model.filter = rest.join(' ') === 'all' ? '' : rest.join(' '); model.selected = undefined; model.note = ui('Filtering affects only the display; event reception and reasoning continue.', '筛选只影响展示；事件接收和思考保持运行。'); }
    else if (command === '/expand') model.toggle();
    else if (command === '/collapse') model.expanded.clear();
    else if ((command === '/pause' || command === '/resume' || command === '/status') && rest.length === 0 || command === '/life' && rest.length === 1 && ['on', 'off'].includes(rest[0]!)) {
      model.note = ui(`${command} submitted; waiting for confirmation…`, `${command} 已提交，等待确认……`);
      void callControl(path, { args: [command!.slice(1), ...rest] }).then(() => { model.note = ui(`${command} confirmed`, `${command} 已确认`); tui.requestRender(); }).catch(error => { model.note = plainText(ui(`Action not confirmed: ${error.message}`, `操作未确认：${error.message}`)); tui.requestRender(); });
    } else model.note = ui('Enter a supported management command; use /help to view commands. Ordinary text is not sent to the Agent or QQ.', '请输入支持的管理命令；/help 查看。普通文字不会发送给 Agent 或 QQ。');
    tui.requestRender();
  };
  input.onSubmit = value => { input.setValue(''); localCommands(value); };
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
    if (packet.type === 'snapshot') { timeline.invalidate(); tui.resetTextSelection(); }
    tui.requestRender();
  }, (connected, message) => {
    const previous = model.connectionMessage;
    model.connected = connected; model.connectionMessage = plainText(message);
    if (!connected || model.note === previous) model.note = model.connectionMessage;
    tui.requestRender();
  });
  return { tui, model, close };
}

export function runTui(path: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('The TUI requires an interactive terminal; use logs --follow for redirected output.');
  const session = createTui(path);
  const stop = () => { session.close(); process.off('SIGINT', stop); process.off('SIGTERM', stop); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
