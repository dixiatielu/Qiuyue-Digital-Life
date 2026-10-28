import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage as answer, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { Monitor, type DisplayPacket } from '../src/monitor.js';
import { Store } from '../src/store.js';
import { PiBrain } from '../src/brain.js';
import { createTools } from '../src/tools.js';
import { callControl, handleControl, serveControl } from '../src/control.js';
import { followDisplay } from '../src/display-client.js';
import { DisplayModel } from '../src/tui.js';
import { config, deferred, event } from './helpers.js';

export async function waitFor(predicate: () => boolean, message = 'condition', ms = 2500) {
  const deadline = Date.now() + ms;
  while (!predicate()) { if (Date.now() > deadline) assert.fail(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('display notices describe committed records only, and broken observers cannot fail actions', () => {
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  const packets: DisplayPacket[] = []; monitor.subscribe(undefined, packet => packets.push(packet));
  try {
    const before = packets.length;
    assert.throws(() => store.transaction(() => { event(store, 'rolled back'); throw new Error('rollback'); }), /rollback/);
    monitor.flush();
    assert.equal(packets.length, before);
    assert.equal(store.pending(), 0);
    store.subscribe(() => { throw new Error('viewer failure'); });
    const source = event(store, 'committed');
    const attempt = store.beginAction('action:1', 'send_group_msg', { message: 'committed' }, [source.id]);
    store.finishAction(attempt.action.id, 'unknown', { reason: 'receipt lost' });
    assert.equal(store.actionById(attempt.action.id)?.status, 'unknown');
    const item = monitor.snapshot().items.find(item => item.id === attempt.action.id);
    assert.equal(item?.state, 'unknown');
    assert.ok(JSON.stringify(packets).includes('committed'));
    assert.ok(!JSON.stringify(packets).includes('rolled back'));
  } finally { monitor.close(); store.close(); }
});

test('real Pi deltas, queued steering and tool execution appear live while unknown actions remain unknown', async () => {
  const cfg = config(); const store = new Store(':memory:'); const monitor = new Monitor(cfg, store);
  const packets: DisplayPacket[] = []; monitor.subscribe(undefined, packet => packets.push(packet));
  const faux = fauxProvider({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
  const models = createModels(); models.setProvider(faux.provider);
  const entered = deferred(); const release = deferred();
  let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => { entered.resolve(); await release.promise; throw new Error('receipt lost'); } }, () => brain.thought);
  brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) }, monitor);
  const source = event(store, 'First message');
  const batch = store.claim(10)!;
  faux.setResponses([
    answer([fauxThinking('private-thought-never-publish'), fauxText('This is public text appearing one character at a time.'), fauxToolCall('send_group_msg', { group_id: 100, message: 'Hello' })]),
    answer('Stay quiet'),
  ]);
  const running = brain.run(batch);
  try {
    await waitFor(() => packets.some(packet => packet.type === 'event' && packet.change.type === 'item' && packet.change.item.type === 'assistant' && packet.change.item.state === 'streaming'), 'live partial text');
    assert.equal(store.event(source.id)?.status, 'processing');
    await entered.promise;
    assert.ok(monitor.snapshot().items.some(item => item.type === 'tool' && item.state === 'running'));
    event(store, 'New message from another setting', 200);
    const steering = store.claim(10)!;
    assert.equal(await brain.steer(steering), true);
    assert.equal(monitor.snapshot().items.find(item => item.id === steering.batchId)?.state, 'queued');
    release.resolve(); await running;
    const snapshot = monitor.snapshot();
    assert.equal(snapshot.items.find(item => item.id === steering.batchId)?.state, 'accepted');
    assert.ok(snapshot.items.some(item => item.type === 'action' && item.state === 'unknown'));
    assert.ok(snapshot.items.some(item => item.type === 'tool' && item.state === 'error'));
    assert.equal(snapshot.status.phase, 'Idle');
    assert.ok(!JSON.stringify(packets).includes('private-thought-never-publish'));
    assert.equal(store.pending(), 0);
    assert.equal(snapshot.items.find(item => item.id === source.id)?.state, 'processed');
    const restored = new Monitor(cfg, store);
    assert.ok(restored.snapshot().items.some(item => item.type === 'tool' && item.text.includes('group_id') && item.details?.includes('unknown')));
    restored.close();
  } finally { release.resolve(); await running.catch(() => {}); monitor.close(); store.close(); }
});

test('bounded replay restores missed events, detects gaps and never replays forgotten content', () => {
  const cfg = config(); const store = new Store(':memory:'); const monitor = new Monitor(cfg, store, 3);
  const view = new DisplayModel(); monitor.subscribe(undefined, packet => view.apply(packet));
  try {
    const erased = event(store, 'erase-this-content');
    const cursor = monitor.snapshot().cursor;
    event(store, 'missed-one'); monitor.flush();
    const replay: DisplayPacket[] = []; const stop = monitor.subscribe(cursor, packet => replay.push(packet)); stop();
    assert.ok(replay.some(packet => packet.type === 'event'));
    assert.ok(!replay.some(packet => packet.type === 'snapshot'));
    for (let index = 0; index < 10; index++) event(store, `overflow-${index}`);
    monitor.flush();
    const gap: DisplayPacket[] = []; monitor.subscribe(cursor, packet => gap.push(packet))();
    assert.equal(gap[0]?.type, 'snapshot');
    assert.ok(gap[0]?.type === 'snapshot' && gap[0].reason);
    store.forget(erased.id);
    assert.ok(!JSON.stringify([...view.items.values()]).includes('erase-this-content'));
    const reconnect: DisplayPacket[] = []; monitor.subscribe(cursor, packet => reconnect.push(packet))();
    assert.equal(reconnect[0]?.type, 'snapshot');
    assert.ok(!JSON.stringify(reconnect).includes('erase-this-content'));
    const current: DisplayPacket[] = []; monitor.subscribe(monitor.snapshot().cursor, packet => current.push(packet))();
    assert.deepEqual(current.map(packet => packet.type), ['ready']);
    const restarted = new Monitor(cfg, store);
    assert.ok(!JSON.stringify(restarted.snapshot()).includes('erase-this-content')); restarted.close();
  } finally { monitor.close(); store.close(); }
});

test('display projection strips credentials, reasoning, images and terminal control sequences', () => {
  const cfg = config(); const old = process.env[cfg.model.apiKeyEnv]; process.env[cfg.model.apiKeyEnv] = 'test-display-secret';
  const store = new Store(':memory:'); const monitor = new Monitor(cfg, store);
  try {
    event(store, 'hello\x1b]52;c;malicious\x07\x1b[2J test-display-secret');
    const attempt = store.beginAction('private', 'get_credentials', { access_token: 'other-credential', message: 'test-display-secret' }, []);
    store.finishAction(attempt.action.id, 'success', { cookie: 'cookie-value' });
    monitor.startRun('run:test', { batchId: 'batch:test', events: [] });
    monitor.agentEvent({ type: 'tool_execution_update', toolCallId: 't:0', toolName: 'partial', args: {}, partialResult: { content: [{ type: 'text', text: 'Public progress' }], details: { private: 'tool-private-data' } } });
    monitor.agentEvent({ type: 'tool_execution_end', toolCallId: 't:1', toolName: 'credentials', isError: false, result: { content: [{ type: 'text', text: '{"access_token":"hidden-in-json"}' }, { type: 'image', data: 'image-bytes', mimeType: 'image/png' }] } });
    const serialized = JSON.stringify(monitor.snapshot());
    for (const value of ['test-display-secret', 'other-credential', 'cookie-value', 'hidden-in-json', 'image-bytes', 'tool-private-data', '\\u001b', 'malicious']) assert.ok(!serialized.includes(value), value);
    assert.ok(serialized.includes('<REDACTED>'));
    assert.ok(Buffer.byteLength(serialized) < 1_000_000);
  } finally { monitor.close(); store.close(); if (old === undefined) delete process.env[cfg.model.apiKeyEnv]; else process.env[cfg.model.apiKeyEnv] = old; }
});

test('socket viewers reconnect without starting another Agent and management commands remain available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-display-')); const path = join(dir, 'control.sock');
  const store = new Store(':memory:'); const cfg = config(); let monitor = new Monitor(cfg, store);
  let server = await serveControl(path, request => handleControl(store, request), monitor);
  const packets: DisplayPacket[] = []; const connections: boolean[] = [];
  const stop = followDisplay(path, packet => packets.push(packet), connected => connections.push(connected), 20);
  try {
    await waitFor(() => connections.includes(true), 'viewer connection');
    event(store, 'First connection'); monitor.flush();
    await waitFor(() => JSON.stringify(packets).includes('First connection'), 'live socket event');
    await callControl(path, { args: ['pause'] });
    assert.equal(store.settings().paused, true);
    const before = packets.filter(packet => packet.type === 'snapshot').length;
    server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); monitor.close();
    monitor = new Monitor(cfg, store);
    event(store, 'New event after restart');
    server = await serveControl(path, request => handleControl(store, request), monitor);
    await waitFor(() => packets.filter(packet => packet.type === 'snapshot').length > before, 'restart snapshot');
    assert.ok(JSON.stringify(packets.at(-2)).includes('New event after restart') || JSON.stringify(packets).includes('New event after restart'));
    stop();
    assert.equal((await callControl(path, { args: ['status'] }) as { paused: boolean }).paused, true);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM settings WHERE key='daemon'").get()!.n, 0);
  } finally { stop(); monitor.close(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('slow socket viewers are disconnected without failing committed perception', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-slow-display-')); const path = join(dir, 'control.sock');
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  const server = await serveControl(path, request => handleControl(store, request), monitor);
  const viewer = createConnection(path); viewer.on('error', () => {});
  try {
    await once(viewer, 'connect');
    viewer.write(JSON.stringify({ args: ['subscribe'] }) + '\n');
    await once(viewer, 'data'); viewer.pause();
    for (let index = 0; index < 150; index++) event(store, `${index}:` + 'big'.repeat(10000));
    monitor.flush();
    assert.equal(store.pending(), 150);
    assert.ok(Buffer.byteLength(JSON.stringify(monitor.snapshot())) < 600_000);
    assert.equal((await callControl(path, { args: ['status'] }) as { pendingEvents: number }).pendingEvents, 150);
    let connections = 1;
    for (let attempt = 0; connections > 0 && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      connections = await new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    }
    assert.equal(connections, 0);
  } finally { viewer.destroy(); monitor.close(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('logs --follow emits valid live UTF-8 NDJSON and stopping the viewer leaves the daemon alive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-follow-cli-')); const path = join(dir, 'control.sock');
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  raw.socket = path; raw.database = join(dir, 'must-not-create.sqlite');
  writeFileSync(join(dir, raw.personaFile), 'Qiuyue'); writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
  const store = new Store(':memory:'); const monitor = new Monitor(config(), store);
  const server = await serveControl(path, request => handleControl(store, request), monitor);
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'logs', '--follow', '--config', join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  try {
    await waitFor(() => output.includes('"ready"'), `CLI handshake: ${errors}`);
    event(store, 'CLI 实时中文消息'); monitor.flush();
    await waitFor(() => output.includes('CLI 实时中文消息'), 'CLI live record');
    const exited = once(child, 'exit'); child.kill('SIGINT');
    const [code] = await exited; assert.equal(code, 0);
    const packets = output.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(packets.some(packet => packet.type === 'snapshot'));
    assert.ok(packets.some(packet => packet.type === 'event'));
    assert.equal(existsSync(raw.database), false);
    assert.equal((await callControl(path, { args: ['status'] }) as { pendingEvents: number }).pendingEvents, 1);
  } finally { child.kill('SIGKILL'); monitor.close(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('forgetting while a model response is in flight prevents old content returning to the display', async () => {
  const cfg = config(); const store = new Store(':memory:'); const monitor = new Monitor(cfg, store);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  const entered = deferred(); const release = deferred(); let brain: PiBrain;
  const tools = createTools(cfg, store, { execute: async () => ({}) }, () => brain.thought);
  brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) }, monitor);
  const source = event(store, 'erase-in-flight');
  faux.setResponses([async () => { entered.resolve(); await release.promise; return answer('erase-in-flight'); }]);
  const running = brain.run(store.claim(10)!);
  try {
    await entered.promise;
    const cursor = monitor.snapshot().cursor;
    store.forget(source.id);
    release.resolve(); await assert.rejects(running);
    const after: DisplayPacket[] = []; monitor.subscribe(cursor, packet => after.push(packet))();
    assert.ok(!JSON.stringify(after).includes('erase-in-flight'));
    assert.ok(!JSON.stringify(monitor.snapshot()).includes('erase-in-flight'));
  } finally { release.resolve(); await running.catch(() => {}); monitor.close(); store.close(); }
});

test('an older daemon produces an actionable restart message instead of an unknown-command screen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-legacy-viewer-')); const path = join(dir, 'control.sock');
  const server = createServer(socket => socket.once('data', () => socket.end(JSON.stringify({ ok: false, error: 'Unknown command. Use help to view management commands.' }) + '\n')));
  server.listen(path); await once(server, 'listening');
  let message = '';
  const stop = followDisplay(path, () => {}, (_connected, text) => { message = text; }, 1000);
  try { await waitFor(() => message.includes('restart run'), 'legacy daemon hint'); }
  finally { stop(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
