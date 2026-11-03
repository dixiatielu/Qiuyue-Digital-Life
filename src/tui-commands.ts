import { Input, matchesKey, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import { ui } from './ui-language.js';
import { dim, type TuiTheme } from './tui-theme.js';

const commands = () => [
  ['/status', ui('View runtime status and counts', '查看运行状态与统计')],
  ['/filter errors', ui('Show failures and unknown outcomes', '查看失败和结果未知')],
  ['/filter all', ui('Show all conversations', '清除筛选，查看全部交流')],
  ['/filter ', ui('Filter by keyword', '按关键词筛选')],
  ['/details', ui('Toggle full records', '切换完整记录')],
  ['/expand', ui('Toggle selected details', '展开或收起所选详情')],
  ['/collapse', ui('Collapse details, keep messages', '收起详情，保留交流内容')],
  ['/pause', ui('Pause thinking; keep receiving events', '暂停思考，继续接收事件')],
  ['/resume', ui('Resume thinking and actions', '恢复思考与自主行动')],
  ['/life on', ui('Enable autonomous life', '开启自主生活')],
  ['/life off', ui('Disable autonomous life', '关闭自主生活')],
  ['/help', ui('Commands and keyboard shortcuts', '查看管理命令和快捷键')],
  ['/quit', ui('Exit this viewer; keep the Agent running', '退出界面，数字生命继续运行')],
];

/** Completion fills the input; only submitting a complete command executes it. */
export class CommandInput extends Input {
  private dismissed?: string;
  private selected = 0;
  readonly palette: Component;
  constructor(theme: TuiTheme, private maxRows: () => number) {
    super({ prompt: theme.accent('› '), placeholder: ui('Management command · / to browse', '管理命令 · 输入 / 查看可用命令'), placeholderStyle: dim });
    this.palette = { invalidate() {}, render: width => {
      const matches = this.suggestions;
      if (!matches.length) return [];
      const count = Math.max(1, this.maxRows());
      const start = Math.max(0, this.selected - count + 1);
      const padding = width >= 20 ? 2 : 0;
      const available = Math.max(1, width - padding * 2);
      return matches.slice(start, start + count).map(([command, description], index) =>
        ' '.repeat(padding) + truncateToWidth(`${index + start === this.selected ? theme.accent('›') : ' '} ${theme.accent(command!)}${dim(`  ${description}`)}`, available));
    } };
  }
  get suggestions() {
    const value = this.getValue();
    return value.startsWith('/') && value !== this.dismissed ? commands().filter(([command]) => command!.startsWith(value)) : [];
  }
  override setValue(value: string) {
    super.setValue(value); this.selected = 0; this.dismissed = undefined;
  }
  override handleInput(data: string) {
    const matches = this.suggestions;
    if (matches.length) {
      if (matchesKey(data, 'escape')) { this.dismissed = this.getValue(); return; }
      if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
        this.selected = (this.selected + (matchesKey(data, 'up') ? -1 : 1) + matches.length) % matches.length; return;
      }
      if (matchesKey(data, 'tab') || matchesKey(data, 'enter') && !commands().some(([command]) => command === this.getValue())) {
        this.setValue(matches[this.selected]![0]!);
        super.handleInput('\x05'); // Input.setValue preserves the old cursor; completion moves it to the end.
        this.dismissed = this.getValue(); return;
      }
    }
    const before = this.getValue();
    super.handleInput(data);
    if (this.getValue() !== before) { this.selected = 0; this.dismissed = undefined; }
  }
}
