import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth, type Terminal, type ProgramStatus } from '@earendil-works/pi-tui';
import { Store } from '../src/store.js';
import { Monitor, plainText } from '../src/monitor.js';
import { callControl, handleControl, serveControl } from '../src/control.js';
import { createTui, DisplayModel, Timeline } from '../src/tui.js';
import { config, event } from './helpers.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

class TestTerminal implements Terminal {
  columns = 100; rows = 26; kittyProtocolActive = false; stopped = false;
  private input?: (data: string) => void;
  private resize?: () => void;
  output = '';
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  key(data: string) { this.input?.(data); }
  type(data: string) { for (const char of data) this.key(char); }
  size(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.resize?.(); }
  moveBy(_lines: number) {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle(_title: string) {} setProgress(_active: boolean) {} setProgramStatus(_status: ProgramStatus) {}
}

test('timeline renders Chinese, emoji and markdown at narrow widths, and filters without deleting records', () => {
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  try {
    event(store, '这是中文与 emoji 🌙\n第二行消息');
    store.log('thought_error', { message: 'Connection error' });
    const attempt = store.beginAction('unknown', 'send_group_msg', { group_id: 100, message: 'A message' }, []);
    store.finishAction(attempt.action.id, 'unknown', { reason: 'No receipt' });
    const model = new DisplayModel(); model.apply(monitor.snapshot());
    const timeline = new Timeline(model);
    for (const width of [12, 30, 80, 120]) {
      const lines = timeline.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `width ${width}`);
      assert.ok(lines.some(line => plainText(line).includes('Unknown')));
    }
    model.filter = 'errors';
    assert.ok(model.visible().some(item => item.state === 'unknown'));
    assert.ok(model.visible().some(item => item.title === 'thought_error'));
    const count = model.items.size;
    model.filter = 'Nonexistent source'; assert.equal(model.visible().length, 0);
    model.filter = ''; assert.equal(model.items.size, count);
    model.toggle(attempt.action.id);
    assert.ok(timeline.render(100).some(line => plainText(line).includes('No receipt')));
  } finally { monitor.close(); store.close(); }
});

test('interactive TUI scrolls, follows output, confirms controls and detaches without stopping the daemon', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-tui-')); const path = join(dir, 'control.sock');
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  const server = await serveControl(path, request => handleControl(store, request), monitor);
  const terminal = new TestTerminal();
  const session = createTui(path, terminal);
  try {
    await waitFor(() => session.model.connected, 'TUI connection');
    store.log('connection_opened', {});
    for (let index = 0; index < 35; index++) event(store, `Message ${index}`, 100);
    monitor.flush();
    await waitFor(() => session.tui.getScreenLines().some(line => plainText(line).includes('Message 34')), 'latest message rendered');
    session.tui.scrollToTop(); session.tui.requestRender();
    await waitFor(() => !session.tui.isFollowingOutput, 'scrollback');
    const top = session.tui.viewportTop;
    event(store, 'New message while scrolling'); monitor.flush();
    await waitFor(() => session.model.unseen > 0, 'unseen counter');
    assert.equal(session.tui.viewportTop, top);
    terminal.key('\x1b[1;5F');
    await waitFor(() => session.tui.isFollowingOutput, 'Ctrl+End resumes following');
    terminal.type('/pause\r');
    await waitFor(() => store.settings().paused && session.model.note.includes('confirmed'), 'pause acknowledgement');
    terminal.type('/resume\r');
    await waitFor(() => !store.settings().paused && session.model.note.includes('confirmed'), 'resume acknowledgement');
    terminal.type('/life on\r');
    await waitFor(() => store.settings().lifeEnabled, 'life acknowledgement');
    terminal.type('/filter errors\r');
    assert.equal(session.model.filter, 'errors');
    terminal.type('/filter all\r'); assert.equal(session.model.filter, '');
    for (const width of [30, 80, 140]) {
      terminal.size(width, 20); session.tui.requestRender();
      await waitFor(() => session.tui.getScreenLines().every(line => visibleWidth(line) <= width), `resize ${width}`);
    }
    const before = store.dailyCalls();
    terminal.key('\x03');
    assert.equal(terminal.stopped, true);
    assert.equal(store.dailyCalls(), before);
    assert.equal((await callControl(path, { args: ['status'] }) as { paused: boolean }).paused, false);
    assert.equal(store.settings().lifeEnabled, true);
  } finally { session.close(); monitor.close(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('interface language defaults to English and supports Chinese for monitoring and management', () => {
  const previous = process.env.QIUYUE_UI_LANGUAGE;
  const store = new Store(':memory:');
  try {
    event(store, 'shared event');
    for (const [language, phase, title, note, state] of [
      ['en', 'Idle', 'Received · Group 100', 'Use /help', 'Waiting for observation'],
      ['zh', '空闲', '收到 · 群 100', '/help 查看命令', '等待观察'],
    ]) {
      process.env.QIUYUE_UI_LANGUAGE = language;
      const monitor = new Monitor(config(), store);
      try {
        const snapshot = monitor.snapshot();
        assert.equal(snapshot.status.phase, phase);
        assert.ok(snapshot.items.some(item => item.title.includes(title)));
        const model = new DisplayModel(); model.apply(snapshot);
        assert.ok(model.note.includes(note));
        assert.ok(new Timeline(model).render(100).some(line => plainText(line).includes(state)));
        const preview = handleControl(store, { args: ['memory', 'forget', [...model.items.keys()][0]!] }) as { message: string };
        assert.match(preview.message, language === 'zh' ? /此操作/ : /This also deletes/);
      } finally { monitor.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.QIUYUE_UI_LANGUAGE; else process.env.QIUYUE_UI_LANGUAGE = previous;
    store.close();
  }
});
