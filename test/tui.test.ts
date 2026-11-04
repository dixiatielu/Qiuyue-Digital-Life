import { beginAction } from './helpers.js';
import { qqEvent } from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { visibleWidth, type Terminal, type ProgramStatus } from '@earendil-works/pi-tui';
import { createModels, fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai';
import { PiBrain } from '../src/brain.js';
import { createTools } from './helpers.js';

import { Store } from '../src/store.js';
import { Monitor, plainText, type DisplayItem } from '../src/monitor.js';
import { callControl, handleControl, serveControl } from '../src/control.js';
import { ActivityLine, createTui, DisplayModel, Timeline } from '../src/tui.js';
import { loadUiLanguage } from '../src/ui-language.js';
import { CommandInput } from '../src/tui-commands.js';
import { config, deferred, event } from './helpers.js';

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2500;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out: ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

class TestTerminal implements Terminal {
  columns = 100; rows = 26; kittyProtocolActive = false; stopped = false;
  private input?: (data: string) => void;
  private resize?: () => void;
  output = '';
  progress: boolean[] = [];
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.stopped = true; }
  async drainInput() {}
  write(data: string) { this.output += data; }
  key(data: string) { this.input?.(data); }
  type(data: string) { for (const char of data) this.key(char); }
  size(columns: number, rows: number) { this.columns = columns; this.rows = rows; this.resize?.(); }
  moveBy(_lines: number) {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle(_title: string) {} setProgress(active: boolean) { this.progress.push(active); } setProgramStatus(_status: ProgramStatus) {}
}

test('timeline renders Chinese, emoji and markdown at narrow widths, and filters without deleting records', () => {
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  try {
    event(store, '这是中文与 emoji 🌙\n第二行消息');
    store.log('thought_error', { message: 'Connection error' });
    const attempt = beginAction(store, 'unknown', "qq_main__send_group_msg", { group_id: 100, message: 'A message' }, []);
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

test('completed conversations keep received and sent content visible while tool and model details stay folded', () => {
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  try {
    const source = store.receive(qqEvent({ key: 'conversation', kind: 'message', at: Date.now(), groupId: 100, actorId: 7, text: '今晚还练琴吗？', payload: { sender: { nickname: '阿岚' } } }, store))!;
    const batch = store.claim(10)!; monitor.startRun('conversation', batch);
    monitor.agentEvent({ type: 'tool_execution_start', toolCallId: 'send', toolName: 'send_group_msg', args: {} });
    const attempt = beginAction(store, 'send:conversation', "qq_main__send_group_msg", { group_id: 100, message: [{ type: 'text', data: { text: '练呀，今天练后半段。' } }, { type: 'image', data: { file: 'image-file' } }] }, [source.id]);
    store.finishAction(attempt.action.id, 'success', { message_id: 9 });
    monitor.agentEvent({ type: 'tool_execution_end', toolCallId: 'send', toolName: 'send_group_msg', isError: false, result: { content: [{ type: 'text', text: 'RAW_TOOL_RESULT' }] } });
    monitor.agentEvent({ type: 'message_end', message: answer('MODEL_TEXT_NOT_SENT') });
    store.acknowledge(batch.batchId); monitor.endRun();
    const model = new DisplayModel(); model.apply(monitor.snapshot());
    const timeline = new Timeline(model);
    const text = () => timeline.render(80).map(plainText).join('\n');
    assert.match(text(), /qq:900:group:100 \/ 阿岚/);
    assert.match(text(), /今晚还练琴吗？/);
    assert.match(text(), /Qiuyue → Group 100.*Sent/);
    assert.match(text(), /练呀，今天练后半段。\[Image\]/);
    assert.ok(!text().includes('RAW_TOOL_RESULT'));
    assert.ok(!text().includes('MODEL_TEXT_NOT_SENT'));
    assert.equal(model.items.get(attempt.action.id)?.actionKind, 'qq_main__send_group_msg');
    model.toggle('run:conversation');
    assert.match(text(), /Model output · not sent to QQ/);
    const output = [...model.items.values()].find(item => item.type === 'assistant')!;
    model.toggle(output.id); assert.match(text(), /MODEL_TEXT_NOT_SENT/);
    model.expanded.clear(); assert.match(text(), /练呀，今天练后半段。/);
    // Reconstructing history after a daemon restart still uses the confirmed action, not tool output.
    const restarted = new Monitor(config(), store);
    try { model.apply(restarted.snapshot()); assert.match(text(), /Qiuyue → Group 100.*Sent/); assert.match(text(), /练呀，今天练后半段。/); }
    finally { restarted.close(); }
  } finally { monitor.close(); store.close(); }
});

test('action outcomes remain distinct on narrow terminals and tool completion never implies delivery', () => {
  for (const [state, label] of [['pending', 'Waiting for remote receipt'], ['success', 'Sent'], ['failed', 'Failed'], ['unknown', 'Unknown']] as const) {
    const model = new DisplayModel();
    const item: DisplayItem = { id: 'action', type: 'action', at: Date.now(), title: 'Action · send_group_msg', state, source: 'Group 12345678901234567890', text: JSON.stringify({ message: '中文 🌙\nsecond line' }) };
    model.items.set(item.id, item);
    model.items.set('tool', { id: 'tool', type: 'tool', at: item.at, title: 'send_group_msg', state: 'done', text: '{}' });
    for (const width of [1, 12, 30, 80, 120]) {
      const lines = new Timeline(model).render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${state}, ${width}`);
      const text = lines.map(plainText).join('\n');
      // Strip wrapping to check labels even when a destination occupies several lines.
      assert.ok(text.replace(/\s/g, '').includes(label.replace(/\s/g, '')), `${state}, ${width}`);
      if (state !== 'success') assert.ok(!text.includes('Sent'));
    }
  }
});

test('history without run metadata keeps conversations visible and groups technical records separately', () => {
  const model = new DisplayModel(); const at = Date.now();
  const items: DisplayItem[] = [
    { id: 'incoming', at, type: 'environment', title: 'Recorded · Group 100 · Friend', state: 'processed', text: 'INCOMING_HISTORY' },
    { id: 'tool', at, type: 'tool', title: 'recall', state: 'done', text: '{"query":"TECHNICAL_QUERY"}' },
    { id: 'action', at, type: 'action', title: 'Action · send_group_msg', state: 'success', text: '{"group_id":100,"message":"SENT_HISTORY"}' },
    { id: 'model', at, type: 'assistant', title: 'Model output · not sent to QQ', state: 'done', text: 'UNSENT_MODEL_TEXT' },
    { id: 'error', at, type: 'tool', title: 'failed_tool', state: 'error', text: '{}' },
  ];
  for (const item of items) model.items.set(item.id, item);
  const timeline = new Timeline(model); const text = () => timeline.render(120).map(plainText).join('\n');
  assert.match(text(), /INCOMING_HISTORY/); assert.match(text(), /SENT_HISTORY/);
  assert.match(text(), /2 historical tool \/ model records/); assert.match(text(), /failed_tool/);
  assert.ok(!text().includes('TECHNICAL_QUERY')); assert.ok(!text().includes('UNSENT_MODEL_TEXT'));
  model.toggle('display:history-details'); assert.match(text(), /TECHNICAL_QUERY/);
  assert.match(text(), /Model output · not sent to QQ/); assert.ok(!text().includes('UNSENT_MODEL_TEXT'));
  model.toggle('model'); assert.match(text(), /UNSENT_MODEL_TEXT/);
});

test('command completion filters, preserves escaped text, and requires explicit submission after filling', () => {
  const input = new CommandInput(new DisplayModel().theme, () => 3);
  const submitted: string[] = []; input.onSubmit = value => submitted.push(value);
  const type = (value: string) => { for (const char of value) input.handleInput(char); };
  type('/sta');
  assert.deepEqual(input.suggestions.map(item => item[0]), ['/status']);
  input.handleInput('\x1b'); assert.equal(input.getValue(), '/sta'); assert.equal(input.suggestions.length, 0);
  type('t'); assert.equal(input.suggestions.length, 1);
  input.handleInput('\t'); assert.equal(input.getValue(), '/status'); assert.deepEqual(submitted, []);
  input.handleInput('\r'); assert.deepEqual(submitted, ['/status']);
  input.setValue(''); type('/p'); input.handleInput('\r');
  assert.equal(input.getValue(), '/pause'); assert.deepEqual(submitted, ['/status']);
  input.handleInput('\r'); assert.deepEqual(submitted, ['/status', '/pause']);
  input.setValue(''); type('/'); input.handleInput('\x1b[B'); input.handleInput('\t');
  assert.equal(input.getValue(), '/filter errors');
  type('中文'); assert.equal(input.getValue(), '/filter errors中文');
  input.setValue(''); type('/');
  for (const width of [1, 12, 30, 80, 120]) assert.ok(input.palette.render(width).every(line => visibleWidth(line) <= width));
});

test('conversation view keeps triggers, queued observations, tool details and uncertain actions distinct', async () => {
  const cfg = config(); const store = new Store(':memory:'); const monitor = new Monitor(cfg, store);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const entered = deferred(); const release = deferred(); let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => { entered.resolve(); await release.promise; throw new Error('receipt-unknown'); } }, () => brain.thought);
  brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) }, monitor);
  event(store, 'TRIGGER_CONTENT 中文 🌙');
  faux.setResponses([answer([fauxToolCall("qq_main__send_group_msg", { group_id: 100, message: 'VISIBLE_MESSAGE_BODY' })]), answer('MODEL_OUTPUT_NOT_SENT')]);
  const running = brain.run(store.claim(10)!);
  try {
    await entered.promise;
    event(store, 'WAITING_CONTENT', 200);
    await brain.steer(store.claim(10)!);
    store.log('connection_opened', { marker: 'SYSTEM_DETAILS_ONLY' });
    const model = new DisplayModel(); model.connected = true; model.apply(monitor.snapshot());
    const timeline = new Timeline(model);
    const text = () => timeline.render(160).map(plainText).join('\n');
    let rendered = text();
    assert.match(rendered, /qq:900:group:100.*\n.*TRIGGER_CONTENT/);
    assert.match(rendered, /Waiting for remote receipt/);
    assert.equal(rendered.split('VISIBLE_MESSAGE_BODY').length - 1, 1);
    assert.match(rendered, /1 received · not yet included in the model/);
    assert.match(rendered, /Waiting to be included.*WAITING_CONTENT/);
    assert.match(rendered, /Send group message/);
    assert.ok(!rendered.includes('"group_id"'));
    assert.ok(!rendered.includes('SYSTEM_DETAILS_ONLY'));
    const tool = [...model.items.values()].find(item => item.type === 'tool')!;
    model.toggle(tool.id); assert.match(text(), /"group_id"/);
    model.toggle(tool.id);
    for (const width of [1, 12, 30, 80, 160]) assert.ok(timeline.render(width).every(line => visibleWidth(line) <= width));
    release.resolve(); await running; model.apply(monitor.snapshot());
    rendered = text();
    assert.match(rendered, /1 unknown/);
    assert.match(rendered, /Qiuyue → Group 100.*Unknown/);
    assert.match(rendered, /VISIBLE_MESSAGE_BODY/);
    assert.ok(!rendered.includes('MODEL_OUTPUT_NOT_SENT'));
    assert.ok(!rendered.includes('"group_id"'));
    const run = [...model.items.values()].find(item => item.type === 'run')!;
    model.toggle(run.id); rendered = text();
    assert.match(rendered, /qq:900:group:200.*\n.*WAITING_CONTENT/);
    assert.match(rendered, /Unknown/); assert.ok(!rendered.includes('not yet included in the model'));
    model.showDetails = true; rendered = text();
    assert.match(rendered, /SYSTEM_DETAILS_ONLY/); assert.match(rendered, /"group_id"/);
    assert.match(rendered, /Model output · not sent to QQ/); assert.match(rendered, /MODEL_OUTPUT_NOT_SENT/);
    model.showDetails = false; model.filter = 'errors';
    model.toggle(tool.id);
    assert.match(text(), /receipt-unknown/);
  } finally { release.resolve(); await running.catch(() => {}); monitor.close(); store.close(); }
});

test('activity line keeps idle and stale state visible, and expands telemetry only on request or a stall', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  try {
    const model = new DisplayModel(); model.connected = true;
    let now = Date.now();
    const activity = new ActivityLine(model, () => now);
    model.apply(monitor.snapshot()); assert.match(activity.render(80).map(plainText).join('\n'), /Idle/);
    monitor.startRun('run:test', { batchId: 'batch:test', events: [] });
    t.mock.timers.tick(1);
    monitor.requestStarted();
    model.apply(monitor.snapshot());
    now = model.status!.busy!.requestStartedAt! + 75_000;
    const first = activity.render(80);
    assert.equal(first.length, 1);
    assert.match(plainText(first[0]!), /Waiting for model… · 1m 15s/);
    model.showDetails = true;
    assert.match(activity.render(120).map(plainText).join('\n'), /Request 1: 1m 15s.*\n.*First output has not arrived/);
    model.showDetails = false;
    now += 80; assert.notEqual(activity.render(80)[0], first[0]);
    now += 60_000;
    assert.match(activity.render(160).map(plainText).join('\n'), /Waiting longer than usual/);
    for (const width of [1, 5, 12]) assert.ok(activity.render(width).every(line => visibleWidth(line) <= width), `width ${width}`);
    monitor.agentEvent({ type: 'tool_execution_start', toolCallId: 't:1', toolName: 'recall', args: {} });
    model.apply(monitor.snapshot());
    assert.match(plainText(activity.render(80)[0]!), /Running Recall memories…/);
    assert.ok(!activity.render(160).map(plainText).join('\n').includes('Last output'));
    model.connected = false; assert.match(activity.render(80).map(plainText).join('\n'), /Waiting for daemon.*Last known state/);
    model.connected = true; monitor.endRun(); model.apply(monitor.snapshot());
    assert.match(activity.render(80).map(plainText).join('\n'), /Idle/);
    store.setSetting('paused', true); model.apply(monitor.snapshot());
    assert.match(activity.render(80).map(plainText).join('\n'), /Paused.*Still receiving/);
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
    for (let index = 0; index < 35; index++) { event(store, `Message ${index}`, 100); store.acknowledge(store.claim(1)!.batchId); }
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
    monitor.startRun('run:tui', { batchId: 'batch:tui', events: [] }); monitor.requestStarted(); monitor.flush();
    await waitFor(() => session.tui.getScreenLines().some(line => plainText(line).includes('Waiting for model…')) && terminal.progress.at(-1) === true, 'thinking indicator');
    monitor.endRun(); monitor.flush();
    await waitFor(() => !session.tui.getScreenLines().some(line => plainText(line).includes('Waiting for model…')) && terminal.progress.at(-1) === false, 'indicator cleared');
    terminal.type('/details\r'); assert.equal(session.model.showDetails, true);
    terminal.type('/details\r'); assert.equal(session.model.showDetails, false);
    terminal.type('/pause\r');
    await waitFor(() => store.settings().paused && session.model.note.includes('confirmed'), 'pause acknowledgement');
    terminal.type('/resume\r');
    await waitFor(() => !store.settings().paused && session.model.note.includes('confirmed'), 'resume acknowledgement');
    terminal.type('/life on\r');
    await waitFor(() => store.settings().lifeEnabled, 'life acknowledgement');
    terminal.type('/filter errors\r');
    assert.equal(session.model.filter, 'errors');
    terminal.type('/filter all\r'); assert.equal(session.model.filter, '');
    terminal.type('/sta');
    await waitFor(() => session.tui.getScreenLines().some(line => plainText(line).includes('View runtime status and counts')), 'command palette filters');
    terminal.key('\t'); terminal.key('\r');
    await waitFor(() => session.model.note.includes('model calls today'), 'status shows the counts removed from the footer');
    terminal.key('\x1b');
    await waitFor(() => !session.tui.getScreenLines().some(line => plainText(line).includes('model calls today')), 'Escape closes status');
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
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-language-')); const path = join(dir, 'config.json');
  const store = new Store(':memory:');
  try {
    event(store, 'shared event');
    for (const [language, phase, title, note, state] of [
      ['en', 'Idle', 'Received · qq:900:group:100', 'Use /help', 'Waiting for observation'],
      ['zh', '空闲', '收到 · qq:900:group:100', '/help 查看命令', '等待观察'],
    ]) {
      writeFileSync(path, JSON.stringify({ uiLanguage: language })); loadUiLanguage(path);
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
    rmSync(dir, { recursive: true, force: true }); loadUiLanguage(path);
    store.close();
  }
});
