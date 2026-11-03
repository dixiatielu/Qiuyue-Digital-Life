import type { PluginContext } from '../src/plugin-sdk.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai';
import { PluginManager } from '../src/plugin-manager.js';
import { LifeRuntime } from '../src/runtime.js';
import { contextIdentity } from '../src/brain.js';
import { callControl, handleControl, serveControl } from '../src/control.js';
import { Drawings, drawingPlugin } from '../src/plugins/drawing.js';
import { deferred, event, fixture } from './helpers.js';

function harness(readCredentials?: () => CredentialReader) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-reload-'));
  const f = fixture();
  f.cfg.extensions = { directory: join(dir, 'plugins'), dataDirectory: join(dir, 'data'), settings: {}, reloadTimeoutMs: 5000 };
  let saved = structuredClone(f.cfg);
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  const manager = new PluginManager(f.cfg, f.plugins, f.store, { execute: async () => ({}) }, () => structuredClone(saved), () => undefined, undefined, readCredentials);
  manager.connect(runtime, () => { const changed = f.brain.refreshTools(); f.reviewer.refreshTools(); return changed; });
  const write = (id: string, text: string, file = 'index.mjs') => { mkdirSync(join(dir, 'plugins', id), { recursive: true }); writeFileSync(join(dir, 'plugins', id, file), text); };
  const execute = async (name: string, args = {}, review = false) => {
    const brain = review ? f.reviewer : f.brain;
    brain.thought.lifeOnly = false; brain.thought.generation = f.store.settings().generation; brain.thought.reviewing = review;
    const tool = (review ? f.reviewTools : f.tools).current().find(item => item.name === name)!;
    const result = await tool.execute('test', args);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { ...f, dir, manager, runtime, write, execute, get saved() { return saved; }, set saved(next) { saved = next; },
    close: async () => { await manager.stop(); await runtime.stop(); await f.plugins.stop(); f.store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const definition = (description = 'Read a sample') => `
import { value } from './helper.mjs';
export default {
  id: 'sample', apiVersion: 1, version: '1.0', defaults: { city: 'Shanghai' },
  configSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  setup(ctx) {
    ctx.tool({ name: 'sample_read', description: ${JSON.stringify(description)}, parameters: { type: 'object', properties: {} }, readOnly: true, review: true,
      execute(args, call) { const count = (ctx.storage.get('count') ?? 0) + 1; ctx.storage.set('count', count); return call.record('reading', { value, count, city: ctx.settings.city }); }
    });
    ctx.observe(() => ['A sample observation']);
    ctx.activity({ activity: 'Read a sample', tools: ['sample_read'] });
  }
};`;
async function waiting(manager: PluginManager) {
  const until = Date.now() + 5000;
  while (manager.job?.state === 'preparing' && Date.now() < until) await turn();
  assert.equal(manager.job?.state, 'waiting');
}

test('user plugins load and refresh helper files in both brains, keep data and compatible working context, and revoke old tools', async () => {
  const h = harness();
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs');
    await h.manager.start();
    assert.deepEqual((await h.execute('sample_read')).result, { value: 1, count: 1, city: 'Shanghai' });
    const old = h.tools.current().find(tool => tool.name === 'sample_read')!;
    event(h.store); h.faux.setResponses([answer('I remember this.')]); await h.brain.run(h.store.claim(10)!);
    const transcript = structuredClone(h.brain.agent.state.messages);
    const identity = contextIdentity(h.cfg, h.tools), generation = h.store.settings().generation;
    h.write('sample', 'export const value = 2;', 'helper.mjs');
    assert.equal(h.manager.status().plugins.find(plugin => plugin.id === 'sample')?.pending, true);
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.equal(h.manager.job?.contextReset, false);
    assert.equal(contextIdentity(h.cfg, h.tools), identity); assert.equal(h.store.settings().generation, generation);
    assert.deepEqual(h.brain.agent.state.messages, transcript);
    assert.deepEqual((await h.execute('sample_read', {}, true)).result, { value: 2, count: 2, city: 'Shanghai' });
    await assert.rejects(old.execute('stale', {}), /old version|reloaded/);
    assert.equal(h.manager.status().plugins.find(plugin => plugin.id === 'sample')?.pending, false);
    assert.equal(readdirSync(join(h.dir, 'plugins/sample/.qiuyue-cache')).length, 1);
  } finally { await h.close(); }
});

test('tool declaration changes renew context once, while plugin settings and core settings apply separately', async () => {
  const h = harness();
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs'); await h.manager.start();
    event(h.store); h.faux.setResponses([answer('Keep this experience.')]); await h.brain.run(h.store.claim(10)!);
    const generation = h.store.settings().generation, persona = h.cfg.persona;
    h.saved.extensions.settings.sample = { city: 'Beijing' }; h.saved.persona = 'A different persona';
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.contextReset, false); assert.equal(h.cfg.persona, persona);
    assert.equal((await h.execute('sample_read')).result.city, 'Beijing');
    assert.deepEqual(h.manager.status().restartRequired, ['persona']);
    h.write('sample', definition('Read a different sample'));
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.contextReset, true); assert.equal(h.store.settings().generation, generation + 1);
    assert.equal(h.brain.agent.state.messages.length, 1);
    assert.ok(h.store.recent(20).some(item => item.text === 'Hello'));
  } finally { await h.close(); }
});

test('syntax errors, incompatible interfaces, invalid settings and conflicts keep the running version', async () => {
  const h = harness();
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs'); await h.manager.start();
    const identity = contextIdentity(h.cfg, h.tools);
    for (const text of ['export default {', definition().replace('apiVersion: 1', 'apiVersion: 9'), definition().replace("name: 'sample_read'", "name: 'read_event'")]) {
      h.write('sample', text); h.manager.request(['reload', 'sample']); await h.manager.settled();
      assert.equal(h.manager.job?.state, 'failed'); assert.equal((await h.execute('sample_read')).result.value, 1);
      assert.equal(contextIdentity(h.cfg, h.tools), identity);
    }
    h.write('sample', definition()); h.saved.extensions.settings.sample = { city: 42 };
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.match(h.manager.job?.error ?? '', /Invalid settings/); assert.equal((await h.execute('sample_read')).result.city, 'Shanghai');
    assert.equal(h.cfg.extensions.settings.sample, undefined);
    assert.equal(readdirSync(join(h.dir, 'plugins/sample/.qiuyue-cache')).length, 1, 'failed snapshots are cleaned');
  } finally { await h.close(); }
});

test('one broken user plugin does not prevent startup, and disabling and removing plugins revokes their tools', async () => {
  const h = harness();
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs');
    h.write('broken', 'throw new Error("broken startup");'); await h.manager.start();
    assert.match(h.manager.status().plugins.find(plugin => plugin.id === 'broken')?.error ?? '', /broken startup/);
    assert.equal((await h.execute('sample_read')).result.value, 1);
    h.saved.plugins.sample = false; h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.ok(!h.tools.current().some(tool => tool.name === 'sample_read'));
    assert.equal(h.manager.status().plugins.find(plugin => plugin.id === 'sample')?.state, 'disabled');
    h.saved.plugins.sample = true; h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal((await h.execute('sample_read')).result.count, 2);
    rmSync(join(h.dir, 'plugins/sample'), { recursive: true });
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.ok(!h.tools.current().some(tool => tool.name === 'sample_read'));
  } finally { await h.close(); }
});

test('host-owned timers and asynchronous disposal do not accumulate across reloads', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = harness();
  try {
    h.write('timer', `import { appendFile } from 'node:fs/promises'; import { join } from 'node:path';
      export default { id: 'timer', apiVersion: 1, setup(ctx) {
        ctx.every(1000, () => ctx.storage.set('ticks', (ctx.storage.get('ticks') ?? 0) + 1));
        ctx.onDispose(async () => { await appendFile(join(ctx.dataDirectory, 'disposed'), 'x'); });
      } };`);
    await h.manager.start(); t.mock.timers.tick(1000); await turn();
    assert.equal(h.store.setting('plugin:timer:ticks'), 1);
    for (let i = 0; i < 3; i++) { h.manager.request(['reload', 'timer']); await h.manager.settled(); assert.equal(h.manager.job?.state, 'done'); }
    assert.equal(readFileSync(join(h.dir, 'data/timer/disposed'), 'utf8'), 'xxx');
    t.mock.timers.tick(1000); await turn();
    assert.equal(h.store.setting('plugin:timer:ticks'), 2);
  } finally { await h.close(); }
});

test('reload drains background tasks, preserves their observations, and does not start new timer work meanwhile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness();
  try {
    h.write('worker', `export default { id: 'worker', apiVersion: 1, setup(ctx) {
      ctx.every(100, () => ctx.storage.set('ticks', (ctx.storage.get('ticks') ?? 0) + 1));
      ctx.tool({ name: 'start_work', description: 'Start background work', parameters: { type: 'object' }, execute() {
        ctx.background(async () => { await new Promise(resolve => setTimeout(resolve, 1000)); ctx.publish({ key: 'result', kind: 'finished', text: 'Finished work', origin: 'self' }); }); return { started: true };
      } });
    } };`);
    await h.manager.start(); await h.execute('start_work'); h.manager.request(['reload', 'worker']); await waiting(h.manager); await turn();
    const before = h.store.setting('plugin:worker:ticks', 0);
    const arrived = event(h.store, 'Arrived during reload'); t.mock.timers.tick(500); await turn();
    assert.equal(h.manager.job?.state, 'waiting'); assert.equal(h.store.setting('plugin:worker:ticks', 0), before);
    assert.equal(h.store.event(arrived.id)?.text, 'Arrived during reload');
    t.mock.timers.tick(500); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done');
    assert.equal(h.store.claim(20)?.events.find(item => item.text === 'Finished work')?.payload.origin, 'self');
    t.mock.timers.tick(100); await turn(); assert.equal(h.store.setting('plugin:worker:ticks', 0), before + 1);
  } finally { t.mock.timers.tick(10000); await turn(); await h.close(); }
});

test('a drain timeout leaves the old plugin and config active and resumes its timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const h = harness(); h.cfg.extensions.reloadTimeoutMs = 1000;
  try {
    h.write('worker', `export default { id: 'worker', apiVersion: 1, setup(ctx) {
      ctx.every(100, () => ctx.storage.set('ticks', (ctx.storage.get('ticks') ?? 0) + 1));
      ctx.tool({ name: 'start_work', description: 'Start work', parameters: { type: 'object' }, execute() {
        ctx.background(() => new Promise(resolve => setTimeout(resolve, 2000))); return true;
      } });
    } };`);
    await h.manager.start(); await h.execute('start_work'); h.saved.plugins.worker = false;
    h.manager.request(['reload', 'worker']); await waiting(h.manager); await turn();
    t.mock.timers.tick(1000); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'failed'); assert.match(h.manager.job?.error ?? '', /timed out/);
    assert.notEqual(h.cfg.plugins.worker, false); assert.ok(h.tools.current().some(tool => tool.name === 'start_work'));
    t.mock.timers.tick(1000); await turn(); assert.ok(h.store.setting('plugin:worker:ticks', 0) > 0);
  } finally { t.mock.timers.tick(10000); await turn(); await h.close(); }
});

test('image generation finishes before disabling its plugin, without being reported as restart-interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-reload-drawing-')), painting = deferred<Buffer>();
  const f = fixture(undefined, undefined, undefined, (store, cfg) => {
    cfg.drawing = { ...cfg.drawing, enabled: true, dir, baseUrl: 'https://images.example/v1', model: 'test' };
    return [drawingPlugin(new Drawings(store, { model: 'test', paint: () => painting.promise }, dir, 90), () => true)];
  });
  f.cfg.extensions.directory = join(dir, 'plugins');
  const saved = structuredClone(f.cfg); saved.plugins.drawing = false;
  const runtime = new LifeRuntime(f.cfg, f.store, f.brain, f.reviewer);
  const manager = new PluginManager(f.cfg, f.plugins, f.store, { execute: async () => ({}) }, () => saved, () => undefined);
  manager.connect(runtime, () => { const changed = f.brain.refreshTools(); f.reviewer.refreshTools(); return changed; });
  try {
    await manager.start(); f.brain.thought.lifeOnly = false;
    await f.tools.current().find(tool => tool.name === 'draw')!.execute('draw', { prompt: 'A flower' });
    manager.request(['reload', 'drawing']); await waiting(manager);
    painting.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])); await manager.settled();
    assert.equal(manager.job?.state, 'done'); assert.ok(!f.tools.current().some(tool => tool.name === 'draw'));
    const drawn = f.store.claim(20)?.events.find(item => item.kind === 'drawing'); assert.ok(drawn); assert.equal(drawn.payload.error, undefined);
    assert.deepEqual(f.store.setting('drawingsUnderWay'), {});
  } finally { painting.resolve(Buffer.alloc(0)); await manager.stop(); await runtime.stop(); await f.plugins.stop(); f.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('plugin actions keep unknown outcomes and do not repeat a dispatch; read-only tools cannot send through query', async () => {
  const h = harness();
  try {
    h.write('writer', `export default { id: 'writer', apiVersion: 1, setup(ctx) {
      ctx.tool({ name: 'write_once', description: 'Write externally', parameters: { type: 'object' }, execute(args, call) {
        return call.action('post', { text: 'hello' }, async () => { ctx.storage.set('sent', (ctx.storage.get('sent') ?? 0) + 1); throw new Error('Connection lost after sending'); });
      } });
      ctx.tool({ name: 'bad_read', description: 'A misdeclared read', parameters: { type: 'object' }, readOnly: true, review: true,
        execute(args, call) { return call.snowluma.query('send_group_msg', { group_id: 100, message: 'hello' }); } });
    } };`);
    await h.manager.start();
    assert.equal((await h.execute('write_once')).outcome.status, 'unknown');
    assert.equal((await h.execute('write_once')).reused, true);
    assert.equal(h.store.setting('plugin:writer:sent'), 1);
    assert.ok(!h.reviewTools.current().some(tool => tool.name === 'write_once'));
    await assert.rejects(h.execute('bad_read', {}, true), /Use snowluma.action/);
  } finally { await h.close(); }
});

test('reload applies native permissions together with dependent enhancements and rejects held native tools', async () => {
  const h = harness();
  try {
    await h.manager.start(); h.brain.thought.lifeOnly = false;
    const held = h.tools.current().find(tool => tool.name === 'send_group_msg')!;
    h.saved.snowluma.tools.deny = ['send_group_msg', 'modify_custom_face'];
    h.manager.request(['reload', 'snowluma-tools']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.equal(h.manager.job?.contextReset, true);
    assert.ok(!h.tools.current().some(tool => tool.name === 'send_group_msg'));
    assert.ok(!(h.tools.current().find(tool => tool.name === 'add_custom_face')!.parameters as any).properties.desc);
    h.brain.thought.generation = h.store.settings().generation;
    await assert.rejects(held.execute('old', { group_id: 100, message: 'hello' }), /old version|not enabled/);
  } finally { await h.close(); }
});

test('management socket reports actual loaded versions and completes asynchronous handlers without serializing a Promise', async () => {
  const h = harness();
  const path = join(h.dir, 'control.sock');
  const server = await serveControl(path, async request => handleControl(h.store, request, h.runtime, h.manager));
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs'); await h.manager.start();
    const before = await callControl(path, { args: ['plugins', 'list'] }) as ReturnType<PluginManager['status']>;
    assert.equal(before.plugins.find(plugin => plugin.id === 'sample')?.state, 'running');
    h.write('sample', 'export const value = 2;', 'helper.mjs');
    const started = await callControl(path, { args: ['plugins', 'reload', 'sample'] }) as { id: string; state: string };
    assert.equal(started.state, 'preparing'); await h.manager.settled();
    const after = await callControl(path, { args: ['plugins', 'status'] }) as ReturnType<PluginManager['status']>;
    assert.equal(after.job?.id, started.id); assert.equal(after.job?.state, 'done');
    assert.notEqual(after.plugins.find(plugin => plugin.id === 'sample')?.sourceHash, before.plugins.find(plugin => plugin.id === 'sample')?.sourceHash);
  } finally { server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); await h.close(); }
});

test('the reload CLI waits for completion and exits unsuccessfully when the running version is kept', async () => {
  const h = harness();
  const socket = join(h.dir, 'control.sock');
  const configPath = join(h.dir, 'config.json');
  writeFileSync(join(h.dir, 'persona.md'), h.cfg.persona);
  writeFileSync(configPath, JSON.stringify({ ...h.cfg, socket, personaFile: 'persona.md' }));
  const server = await serveControl(socket, request => handleControl(h.store, request, h.runtime, h.manager));
  const reload = () => promisify(execFile)(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname,
    'plugins', 'reload', 'sample', '--config', configPath], { timeout: 15_000 });
  try {
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs'); await h.manager.start();
    h.write('sample', 'export const value = 2;', 'helper.mjs');
    const result = JSON.parse((await reload()).stdout);
    assert.equal(result.state, 'done'); assert.equal((await h.execute('sample_read')).result.value, 2);
    h.write('sample', 'export default {');
    await assert.rejects(reload(), (error: any) => {
      assert.equal(error.code, 1); assert.equal(JSON.parse(error.stdout).state, 'failed'); return true;
    });
    assert.equal((await h.execute('sample_read')).result.value, 2);
  } finally { server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); await h.close(); }
});

test('a plugin with invalid initial settings still exposes its form and can be repaired without restarting', async () => {
  const h = harness();
  try {
    h.write('sample', definition().replace("defaults: { city: 'Shanghai' },", 'defaults: {},')); h.write('sample', 'export const value = 1;', 'helper.mjs');
    await h.manager.start();
    const failed = h.manager.status().plugins.find(plugin => plugin.id === 'sample')!;
    assert.equal(failed.state, 'failed'); assert.equal((failed.configSchema?.properties as any).city.type, 'string');
    h.saved.extensions.settings.sample = { city: 'Beijing' }; h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.equal((await h.execute('sample_read')).result.city, 'Beijing');
  } finally { await h.close(); }
});

test('disabling a plugin does not require importing its broken edited code, and disabled code is skipped at startup', async () => {
  const h = harness();
  try {
    h.write('broken', 'throw new Error("must not run");'); h.cfg.plugins.broken = false; h.saved.plugins.broken = false;
    h.write('sample', definition()); h.write('sample', 'export const value = 1;', 'helper.mjs'); await h.manager.start();
    assert.equal(h.manager.status().plugins.find(plugin => plugin.id === 'broken')?.state, 'disabled');
    h.write('sample', 'export default {'); h.saved.plugins.sample = false;
    h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'done'); assert.ok(!h.tools.current().some(tool => tool.name === 'sample_read'));
    h.saved.plugins.sample = true; h.manager.request(['reload', 'sample']); await h.manager.settled();
    assert.equal(h.manager.job?.state, 'failed'); assert.ok(!h.tools.current().some(tool => tool.name === 'sample_read'));
  } finally { await h.close(); }
});

test('reloading a plugin refreshes its credential snapshot without changing core configuration or context', async () => {
  let key = '';
  const h = harness(() => { const snapshot = key; return () => snapshot; });
  try {
    h.write('key-check', `export default { id: 'key-check', apiVersion: 1, setup(ctx) {
      ctx.tool({ name: 'key_check', description: 'Check a credential', parameters: { type: 'object' }, readOnly: true,
        execute() { return { changed: ctx.credential('PLUGIN_KEY') === 'rotated-test-key' }; } });
    } };`);
    await h.manager.start(); assert.equal((await h.execute('key_check')).changed, false);
    key = 'rotated-test-key'; h.manager.request(['reload', 'key-check']); await h.manager.settled();
    assert.equal(h.manager.job?.contextReset, false); assert.equal((await h.execute('key_check')).changed, true);
  } finally { await h.close(); }
});

type CredentialReader = PluginContext['credential'];
