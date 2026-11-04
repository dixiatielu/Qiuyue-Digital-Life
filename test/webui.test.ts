import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { builtinSystemPrompt, systemInstructions } from '../src/prompts.js';
import { WebUi } from '../src/webui/server.js';
import { Credentials, credentialPaths, credentialNames } from '../src/credentials.js';
import { inspectConfig } from '../src/webui/inspect.js';
import { ServiceJobs, type LiveMirror } from '../src/webui/daemon.js';
import type { LifeReader } from '../src/webui/reader.js';
import { PluginManager } from '../src/plugin-manager.js';
import { createPlugins } from './helpers.js';
import { createTools } from './helpers.js';

import { contextIdentity } from '../src/brain.js';
import { LifeRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { handleControl, serveControl } from '../src/control.js';
import { DrawingLibrary } from '../src/plugins/gallery-store.js';

import { installPackagedPlugin } from './packaged-plugins.js';

const token = 'test-token-0123456789';
async function page(work: (call: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any }>, dir: string, port: number) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-webui-'));
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, base.personaFile), 'Qiuyue, a student who likes rain.\n');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, extra: { kept: true } }, null, 2) + '\n');
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, credentials: { MODEL_API_KEY: 'sk-old-value-1234' }, changes: [] }));
  const app = new WebUi(join(dir, 'config.json'), token, WebUi.paths(join(dir, 'config.json')));
  const server = await app.listen('127.0.0.1', 0);
  const port = (server.address() as AddressInfo).port;
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body === undefined ? (init.method && init.method !== 'GET' ? '{}' : undefined) : JSON.stringify(init.body),
    });
    const text = await response.text();
    let body: unknown = text; try { body = JSON.parse(text); } catch { /* HTML or plain text */ }
    return { status: response.status, body: body as any };
  };
  try { await work(call, dir, port); }
  finally { app.close(); server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('optional plugin forms and credentials come from manifests even offline, without importing user code', () => page(async (call, dir) => {
  const absent = await call('/api/plugins');
  assert.ok(absent.body.ids.includes('qq-main-snowluma-tools'));
  assert.ok(!absent.body.ids.includes('snowluma-tools'));
  assert.ok(!absent.body.ids.includes('bilibili')); assert.ok(!absent.body.ids.includes('xiaohongshu'));
  assert.ok(!(await call('/api/secrets')).body.entries.some((entry: any) => entry.name === 'BILIBILI_COOKIE'));
  await installPackagedPlugin(join(dir, 'plugins'), 'bilibili');
  await installPackagedPlugin(join(dir, 'plugins'), 'xiaohongshu');
  mkdirSync(join(dir, 'plugins/reading-room'), { recursive: true });
  writeFileSync(join(dir, 'plugins/reading-room/index.mjs'), 'throw new Error("Must not execute for management metadata");');
  writeFileSync(join(dir, 'plugins/reading-room/plugin.json'), JSON.stringify({
    id: 'reading-room', apiVersion: 2, name: 'Reading room', defaultEnabled: false, defaults: { credentialName: 'READING_ROOM_KEY' },
    configSchema: { type: 'object', properties: { credentialName: { type: 'string', credential: true } } },
  }));
  mkdirSync(join(dir, 'plugins/broken'), { recursive: true });
  writeFileSync(join(dir, 'plugins/broken/plugin.json'), 'invalid JSON');
  const plugins = await call('/api/plugins');
  assert.equal(plugins.status, 200);
  assert.equal(plugins.body.metadata.bilibili.defaults.cookieEnv, 'BILIBILI_COOKIE');
  assert.equal(plugins.body.metadata.xiaohongshu.defaults.baseUrl, 'http://127.0.0.1:18060');
  assert.equal(plugins.body.metadata['reading-room'].name, 'Reading room');
  assert.ok(plugins.body.errors.broken); assert.ok(!plugins.body.builtinIds.includes('bilibili'));
  const secrets = await call('/api/secrets');
  for (const [name, plugin] of [['BILIBILI_COOKIE', 'bilibili'], ['XIAOHONGSHU_TOKEN', 'xiaohongshu'], ['READING_ROOM_KEY', 'reading-room']]) {
    assert.ok(secrets.body.entries.some((entry: any) => entry.name === name && entry.usedBy.includes(plugin)));
  }
  const config = await call('/api/config');
  const updated = { ...config.body.raw, extensions: { settings: { 'reading-room': { credentialName: 'MY_READING_KEY' } } } };
  assert.equal((await call('/api/config', { method: 'PUT', body: { raw: updated, hash: config.body.hash } })).status, 200);
  const names = credentialNames(loadConfig(join(dir, 'config.json')));
  assert.ok(names.includes('MY_READING_KEY')); assert.ok(!names.includes('READING_ROOM_KEY'));
  assert.ok((await call('/api/secrets')).body.entries.some((entry: any) => entry.name === 'MY_READING_KEY' && entry.usedBy.includes('reading-room')));
}));

test('the page asks for its token, refuses foreign hosts and cross-site writes, and signs in with a cookie', () => page(async (call, _dir, port) => {
  assert.equal((await call('/api/overview', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await call('/api/overview', { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status, 401);
  // fetch will not send another Host, so ask the way a rebound name would arrive.
  const host = await new Promise<number>(done => request({ host: '127.0.0.1', port, path: '/api/overview', headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, response => { response.resume(); done(response.statusCode!); }).end());
  assert.equal(host, 421);
  const login = await call(`/login?token=${token}`, { headers: { Authorization: '' } });
  assert.equal(login.status, 401);
  assert.equal((await call('/api/overview', { headers: { Authorization: '', Cookie: `qiuyue_webui=${token}` } })).status, 200);
  assert.equal((await call('/api/control', { method: 'POST', body: { args: ['pause'] }, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/control', { method: 'POST', body: { args: ['pause'] }, headers: { Origin: 'http://attacker.example' } })).status, 403);
  assert.equal((await call('/api/control', { method: 'POST', body: { args: ['memory', 'forget', 'm:1'] } })).status, 400);
  assert.equal((await call('/app/../../config.json')).status, 404);
  assert.equal((await call('/vendor/typebox/package.json')).status, 404);
}));

test('the login page loads its styling and appearance before authentication, without exposing management resources', () => page(async (call, dir, port) => {
  const anonymous = { headers: { Authorization: '' } };
  const login = await call('/', anonymous);
  assert.equal(login.status, 401);
  for (const path of ['/app/style.css', '/app/favicon.svg', '/app/login.js', '/app/theme.js']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok(!response.headers.get('content-type')?.includes('text/html'), path);
    assert.ok(!(await response.text()).includes(token), path);
  }
  assert.match(login.body, /WEBUI_TOKEN/);
  assert.match(login.body, /credentials\.json/);
  assert.ok(!login.body.includes('.env'));
  assert.ok(!login.body.includes(token), 'the real credential is never embedded in the login page');
  for (const path of ['/app/main.js', '/app/pages/config.js', '/app/index.html', '/vendor/preact/package.json', '/api/config', '/api/secrets', '/api/live']) {
    assert.equal((await call(path, anonymous)).status, 401, path);
  }
  assert.equal((await call('/app/style.css', { method: 'POST', ...anonymous })).status, 401);
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, webui: { tokenEnv: 'MY_ADMIN_TOKEN' } }));
  assert.match((await call('/login', anonymous)).body, /MY_ADMIN_TOKEN/);
  writeFileSync(join(dir, 'config.json'), '{broken');
  assert.equal((await call('/login', anonymous)).status, 401, 'login still works when config needs repair');
}));

test('the login form accepts a token only in its body and ignores token query strings', () => page(async (_call, _dir, port) => {
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base)).headers.get('referrer-policy'), 'same-origin', 'native form submissions need their same-origin Origin header');
  const submit = (value: string, origin = base) => fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin }, body: new URLSearchParams({ token: value }),
  });
  const wrong = await submit('WEBUI_TOKEN');
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /aria-invalid="true"/);
  assert.equal((await submit(token, 'http://attacker.example')).status, 403);
  assert.equal((await submit(token, 'null')).status, 403);
  assert.equal((await submit('a'.repeat(9000))).status, 413);
  const signedIn = await submit(token);
  assert.equal(signedIn.status, 303);
  assert.equal(signedIn.headers.get('location'), '/');
  const cookie = signedIn.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await fetch(`${base}/api/overview`, { headers: { Cookie: cookie.split(';')[0]! } })).status, 200);
  const query = await fetch(`${base}/login?token=${token}`, { redirect: 'manual' });
  assert.equal(query.status, 401); assert.equal(query.headers.get('set-cookie'), null);
  assert.ok(!(await query.text()).includes(token));
}));

test('a configuration is saved only whole, valid, and against the version it was read at, keeping unknown keys and earlier versions', () => page(async (call, dir) => {
  const loaded = await call('/api/config');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.error, null);
  const raw = loaded.body.raw;
  const before = readFileSync(join(dir, 'config.json'), 'utf8');
  const invalid = await call('/api/config', { method: 'PUT', body: { raw: { ...raw, adapters: [{ ...raw.adapters[0]!, accountId: '0' }] }, hash: loaded.body.hash } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /accountId/);
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before);
  const checked = await call('/api/config/check', { method: 'POST', body: { raw: { ...raw, limits: { ...raw.limits, batchSize: 5 } } } });
  assert.equal(checked.body.valid, true);
  assert.equal(checked.body.context.continues, false, 'there is no saved working context to continue');
  const saved = await call('/api/config', { method: 'PUT', body: { raw: { ...raw, limits: { ...raw.limits, batchSize: 5 } }, hash: loaded.body.hash } });
  assert.equal(saved.status, 200);
  const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(written.limits.batchSize, 5);
  assert.deepEqual(written.extra, { kept: true });
  const stale = await call('/api/config', { method: 'PUT', body: { raw, hash: loaded.body.hash } });
  assert.equal(stale.status, 409, 'a save against an older read is refused');
  const history = await call('/api/history/config');
  assert.equal(history.body.length, 2);
  assert.equal((await call(`/api/history/config/${history.body[1].id}`)).body.text, before);
  assert.equal((await call('/api/history/config/..%2F..%2Fconfig.json')).status, 400);
}));

test('the persona and the system prompt are checked before saving, and the operator prompt lives in its own file', () => page(async (call, dir) => {
  const persona = await call('/api/persona');
  assert.equal((await call('/api/persona', { method: 'PUT', body: { text: '  \n', hash: persona.body.hash } })).status, 400);
  assert.equal((await call('/api/persona', { method: 'PUT', body: { text: 'Qiuyue, who likes snow.\r\n', hash: persona.body.hash } })).status, 200);
  assert.equal(readFileSync(join(dir, 'persona.example.md'), 'utf8'), 'Qiuyue, who likes snow.\n');
  assert.equal((await call('/api/history/persona')).body.length, 2);

  const prompt = await call('/api/prompt');
  assert.equal(prompt.body.override, undefined);
  assert.equal(prompt.body.builtin, builtinSystemPrompt);
  assert.match((await call('/api/prompt', { method: 'PUT', body: { text: 'No persona here.\n<!-- current-context -->\nMore.' } })).body.error, /\{\{persona\}\}/);
  assert.match((await call('/api/prompt', { method: 'PUT', body: { text: 'You are {{persona}}.' } })).body.error, /current-context/);
  const template = 'You are:\n{{persona}}\nOld part.\n<!-- current-context -->\nNew part.<!-- allow-fiction --> Fiction.<!-- /allow-fiction -->\n';
  assert.equal((await call('/api/prompt', { method: 'PUT', body: { text: template } })).status, 200);
  assert.equal(readFileSync(join(dir, 'system-prompt.md'), 'utf8'), template);
  const config = loadConfig(join(dir, 'config.json'));
  assert.equal(config.systemPrompt, template);
  assert.equal(systemInstructions(config), 'You are:\nQiuyue, who likes snow.\n\nOld part.\nNew part.');
  assert.equal(systemInstructions({ ...config, life: { ...config.life, allowFiction: true } }), 'You are:\nQiuyue, who likes snow.\n\nOld part.\nNew part. Fiction.');
  const preview = await call('/api/prompt/preview', { method: 'POST', body: { template: 'Hi {{persona}}\n<!-- current-context -->\n' } });
  assert.equal(preview.body.pluginSource, 'builtin');
  assert.ok(preview.body.text.startsWith('Hi Qiuyue, who likes snow.\n'));
  assert.equal(preview.body.text, systemInstructions({ ...config, systemPrompt: 'Hi {{persona}}\n<!-- current-context -->\n' }, inspectConfig(config).activityPrompts));
  const after = await call('/api/prompt');
  assert.equal(after.body.override, template);
  assert.equal(after.body.builtinChanged, false);
  assert.equal((await call('/api/prompt', { method: 'DELETE' })).status, 200);
  assert.equal(loadConfig(join(dir, 'config.json')).systemPrompt, undefined);
  assert.ok(existsSync(join(dir, 'system-prompt.md')), 'going back to the built-in prompt leaves the operator file on disk');
}));

test('credentials are masked, stored separately, version-checked, and cannot be read through history', async () => page(async (call, dir) => {
  const before = await call('/api/secrets');
  assert.equal(before.body.entries.find((item: any) => item.name === 'MODEL_API_KEY').value, '••••1234');
  assert.equal(before.body.entries.find((item: any) => item.name === 'MODEL_API_KEY').source, 'file');
  assert.ok(!before.body.entries.some((item: any) => item.name === 'OTHER'));
  const originalEnvironment = process.env.MODEL_API_KEY;
  const updated = await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'sk-new value#5678', revision: before.body.revision } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.entries.find((item: any) => item.name === 'MODEL_API_KEY').source, 'file');
  assert.equal(process.env.MODEL_API_KEY, originalEnvironment);
  const credentials = new Credentials(credentialPaths(join(dir, 'config.json')), {});
  assert.equal(credentials.get('MODEL_API_KEY'), 'sk-new value#5678');
  assert.ok(!JSON.stringify(updated.body).includes('sk-new value'));
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'stale-value', revision: before.body.revision } })).status, 409);
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'unversioned' } })).status, 400);
  const removed = await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: null, revision: updated.body.revision } });
  assert.equal(removed.status, 200);
  assert.equal(new Credentials(credentials.paths, {}).get('MODEL_API_KEY'), undefined, 'the file credential stays disabled');
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'BAD NAME', value: 'x', revision: removed.body.revision } })).status, 400);
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MULTI', value: 'a\nb', revision: removed.body.revision } })).status, 400);
  const history = join(dir, 'data/webui/history/env');
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, '123-abcdef123456.env'), 'OLD_KEY=secret-from-old-version');
  assert.equal((await call('/api/history/env')).status, 404);
  const version = await call('/api/history/env/123-abcdef123456.env');
  assert.equal(version.status, 404);
  assert.ok(!JSON.stringify(version.body).includes('secret-from-old-version'));
}));

test('external credentials are read-only and take the same priority in the page and runtime', async () => {
  const name = 'QIUYUE_WEBUI_EXTERNAL_KEY'; const old = process.env[name];
  process.env[name] = 'externally-managed-secret';
  try {
    await page(async (call, dir) => {
      const path = join(dir, 'config.json'); const config = JSON.parse(readFileSync(path, 'utf8'));
      config.model.apiKeyEnv = name; writeFileSync(path, JSON.stringify(config));
      const file = join(dir, 'credentials.json');
      const original = JSON.stringify({ version: 1, credentials: { [name]: 'file-value' }, changes: [] });
      writeFileSync(file, original);
      const list = await call('/api/secrets');
      const item = list.body.entries.find((item: any) => item.name === name);
      assert.equal(item.source, 'environment'); assert.equal(item.writable, false);
      assert.equal(new Credentials(credentialPaths(path)).get(name), 'externally-managed-secret');
      assert.equal((await call('/api/secrets', { method: 'PUT', body: { name, value: 'replacement', revision: list.body.revision } })).status, 400);
      assert.equal(readFileSync(file, 'utf8'), original);
    });
  } finally { if (old === undefined) delete process.env[name]; else process.env[name] = old; }
});

test('page connection tests and model listings immediately use the same file credential as the next daemon start', async () => page(async (call, dir) => {
  const authorizations: unknown[] = [];
  const endpoint = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: request.url?.endsWith('/models') ? [{ id: 'test-model' }] : [{ index: 0, embedding: [1, 0] }] }));
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/v1`;
    const before = await call('/api/secrets');
    const saved = await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'latest-file-test-key', revision: before.body.revision } });
    assert.equal(saved.status, 200);
    assert.equal((await call('/api/test/embedding', { method: 'POST', body: { embedding: { baseUrl, model: 'test', apiKeyEnv: 'MODEL_API_KEY' } } })).status, 200);
    assert.equal((await call('/api/providers/models', { method: 'POST', body: { provider: { id: 'test', name: 'Test', api: 'openai-completions', baseUrl, apiKeyEnv: 'MODEL_API_KEY' } } })).status, 200);
    const startup = new Credentials(credentialPaths(join(dir, 'config.json')));
    assert.deepEqual(authorizations, [0, 1].map(() => `Bearer ${startup.get('MODEL_API_KEY')}`));
    assert.equal(startup.get('MODEL_API_KEY'), 'latest-file-test-key');
  } finally { endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done())); }
}));

test('providers start from the endpoints already configured and are checked when saved', () => page(async call => {
  const listed = await call('/api/providers');
  assert.ok(listed.body.providers.length >= 1);
  assert.deepEqual((await call('/api/providers')).body.providers.map((item: any) => item.id), listed.body.providers.map((item: any) => item.id), 'seeded IDs stay put until saved');
  const bad = await call('/api/providers', { method: 'PUT', body: { providers: [{ id: 'a', name: 'A', api: 'openai-completions', baseUrl: 'https://user:pw@example.com/v1', apiKeyEnv: 'KEY' }] } });
  assert.equal(bad.status, 400);
  const good = await call('/api/providers', { method: 'PUT', body: { providers: [{ id: 'a', name: 'A', api: 'anthropic-messages', baseUrl: 'https://example.com', apiKeyEnv: 'KEY' }] } });
  assert.equal(good.status, 200);
  assert.deepEqual((await call('/api/providers')).body.providers.map((item: any) => item.name), ['A']);
}));

test('the working context identity follows the persona, prompt, model, and tools, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-identity-'));
  try {
    const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const path = join(dir, 'config.json');
    const identity = (raw: typeof base) => { writeFileSync(path, JSON.stringify(raw)); return inspectConfig(loadConfig(path)).identities[0]; };
    const original = identity(base);
    assert.equal(identity({ ...base, limits: { ...base.limits, batchSize: 3 }, memory: { ...base.memory, recallLimit: 2 } }), original);
    assert.notEqual(identity({ ...base, life: { ...base.life, allowFiction: true } }), original);
    assert.notEqual(identity({ ...base, plugins: { 'qq-main-qq-faces': false } }), original);
    assert.notEqual(identity({ ...base, adapters: [{ ...base.adapters[0]!, tools: { allow: '*', deny: ['send_poke'] } }] }), original);
    assert.notEqual(identity({ ...base, model: { ...base.model, thinkingLevel: 'low' } }), original);
    writeFileSync(join(dir, base.personaFile), 'Qiuyue, changed');
    assert.notEqual(identity(base), original);
    assert.ok(!inspectConfig(loadConfig(path)).plugins.includes('drawing'), 'drawing stays off without its endpoint');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restart waits until no thought or review is under way, and gives up at its deadline', async () => {
  const state = { busy: true, reviewing: undefined as number | undefined };
  const mirror = { get status() { return state.busy ? { busy: { stage: 'thinking', since: 0 } } : {}; } } as unknown as LiveMirror;
  const reader = { activity: () => ({ reviewing: state.reviewing, lastTrace: undefined, callStarting: false }) } as unknown as LifeReader;
  const commands: string[] = [];
  const jobs = new ServiceJobs(mirror, reader, 5, async (unit, action) => { commands.push(`${action} ${unit}`); });
  const job = jobs.start('life.service', 'restart', true);
  await new Promise(done => setTimeout(done, 30));
  assert.deepEqual(job.waitingFor, ['thinking']);
  assert.throws(() => jobs.start('life.service', 'stop', true), /already under way/);
  state.busy = false; state.reviewing = Date.now();
  await new Promise(done => setTimeout(done, 30));
  assert.deepEqual(job.waitingFor, ['reviewing']);
  assert.deepEqual(commands, []);
  state.reviewing = undefined;
  await new Promise(done => setTimeout(done, 30));
  assert.deepEqual(commands, ['restart life.service']);
  assert.equal(jobs.job?.state, 'done');
  state.busy = true;
  const late = jobs.start('life.service', 'stop', true, 20);
  await new Promise(done => setTimeout(done, 60));
  assert.equal(late.state, 'failed');
  assert.deepEqual(commands, ['restart life.service']);
  assert.equal(jobs.start('life.service', 'stop', false).state, 'running', 'without waiting, it acts at once');
  jobs.close();
});

test('the capabilities page discovers user plugins without importing them in the web process', () => page(async (call, dir) => {
  const path = join(dir, 'plugins', 'unloaded'); mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'index.mjs'), 'throw new Error("The web page must never execute this module");');
  const result = await call('/api/plugins');
  assert.equal(result.status, 200); assert.ok(result.body.ids.includes('unloaded'));
  assert.equal(result.body.running, null); assert.equal(result.body.inspected.unknown, true);
  const preview = await call('/api/prompt/preview', { method: 'POST' });
  assert.equal(preview.status, 200); assert.equal(preview.body.pluginSource, 'builtin');
  assert.ok(preview.body.activities.every((item: any) => item.plugin !== 'unloaded'));
  assert.equal((await call('/api/plugins/reload', { method: 'POST', body: { id: 'unloaded' }, headers: { Authorization: '' } })).status, 401);
  assert.equal((await call('/api/plugins/reload', { method: 'POST', body: { id: '../unloaded' } })).status, 400);
}));

test('capabilities show daemon versions and schema, and apply saved settings through a tracked reload', () => page(async (call, dir) => {
  const path = join(dir, 'config.json'), cfg = loadConfig(path), store = new Store(cfg.database);
  const social = { execute: async () => ({}) }, host = createPlugins(cfg, store, social);
  const thought = { generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false };
  const tools = createTools(cfg, store, social, () => thought, undefined, host);
  let identity = contextIdentity(cfg, tools);
  const brain = { thought, streaming: false, run: async () => {}, review: async () => {}, steer: async () => false, consolidate: async () => {}, abort: () => {} };
  const runtime = new LifeRuntime(cfg, store, brain, brain);
  const manager = new PluginManager(cfg, host, store, () => loadConfig(path), () => undefined);
  manager.connect(runtime, () => { const next = contextIdentity(cfg, tools), changed = next !== identity; identity = next; return changed; }, () => host.activityPrompts(new Set(tools.current().map(tool => tool.name))));
  mkdirSync(join(dir, 'plugins/clock'), { recursive: true });
  writeFileSync(join(dir, 'plugins/clock/index.mjs'), readFileSync(new URL('../examples/plugins/clock/index.mjs', import.meta.url), 'utf8').replace('setup(ctx) {', `setup(ctx) { ctx.activity({ activity: 'Check the time', tools: ['clock_read'], instructions: 'Clock guidance from the active plugin.' });`));
  const server = await serveControl(cfg.socket, request => handleControl(store, request, runtime, manager));
  try {
    await manager.start();
    const listed = await call('/api/plugins');
    const clock = listed.body.running.plugins.find((item: any) => item.id === 'clock');
    assert.equal(clock.state, 'running'); assert.equal(clock.version, '1.0.0');
    assert.equal(clock.configSchema.properties.timeZone.type, 'string');
    const preview = await call('/api/prompt/preview', { method: 'POST', body: { template: 'Draft {{persona}}\n<!-- current-context -->' } });
    assert.equal(preview.body.pluginSource, 'running');
    assert.equal(preview.body.text, systemInstructions({ ...cfg, systemPrompt: 'Draft {{persona}}\n<!-- current-context -->' }, host.activityPrompts(new Set(tools.current().map(tool => tool.name)))));
    assert.ok(preview.body.text.includes('Clock guidance from the active plugin.'));
    const config = await call('/api/config');
    assert.equal((await call('/api/config', { method: 'PUT', body: { raw: { ...config.body.raw, plugins: { clock: false } }, hash: config.body.hash } })).status, 200);
    const pending = await call('/api/plugins');
    assert.equal(pending.body.running.plugins.find((item: any) => item.id === 'clock').pending, true);
    assert.ok((await call('/api/prompt/preview', { method: 'POST' })).body.text.includes('Clock guidance from the active plugin.'), 'saved switches do not hide the running contribution before reload');
    const reload = await call('/api/plugins/reload', { method: 'POST', body: { id: 'clock' } });
    assert.equal(reload.status, 200); assert.ok(['preparing', 'waiting', 'applying', 'done'].includes(reload.body.state));
    await manager.settled();
    const after = await call('/api/plugins');
    assert.equal(after.body.running.job.state, 'done'); assert.equal(after.body.running.job.contextReset, true);
    assert.equal(after.body.running.plugins.find((item: any) => item.id === 'clock').state, 'disabled');
    assert.ok(!tools.current().some(tool => tool.name === 'clock_read'));
    const disabledPreview = await call('/api/prompt/preview', { method: 'POST' });
    assert.equal(disabledPreview.body.pluginSource, 'running');
    assert.ok(!disabledPreview.body.text.includes('Clock guidance from the active plugin.'));
  } finally { await manager.stop(); await runtime.stop(); await host.stop(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}));

test('gallery APIs browse offline, authenticate images, and send versioned edits only through the active plugin', () => page(async (call, dir, port) => {
  const path = join(dir, 'config.json'), cfg = loadConfig(path), store = new Store(cfg.database);
  const social = { execute: async () => ({}) }, host = createPlugins(cfg, store, social);
  const brain = { thought: { generation: 0, sources: new Set<string>(), triggers: new Set<string>(), lifeOnly: false }, streaming: false, run: async () => {}, review: async () => {}, steer: async () => false, consolidate: async () => {}, abort: () => {} };
  const runtime = new LifeRuntime(cfg, store, brain, brain);
  const manager = new PluginManager(cfg, host, store, () => loadConfig(path), () => undefined); manager.connect(runtime, () => false);
  const library = new DrawingLibrary(store.db, cfg.drawing.dir), key = `drawing:${crypto.randomUUID()}`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  await library.save(key, png, 'png', { prompt: '猫咪', model: 'test', createdAt: Date.now(), sources: [] });
  const route = `/api/gallery/${encodeURIComponent(key)}`;
  let server: Awaited<ReturnType<typeof serveControl>> | undefined;
  try {
    assert.equal((await call('/api/gallery')).body.total, 1);
    assert.equal((await call('/api/gallery?offset=-1')).status, 400);
    assert.equal((await call(route + '/image', { headers: { Authorization: '' } })).status, 401);
    const image = await fetch(`http://127.0.0.1:${port}${route}/image?download=true`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(image.status, 200); assert.match(image.headers.get('content-disposition')!, /attachment/); assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    assert.equal((await call(route, { method: 'PUT', body: { revision: 1, changes: { title: 'offline' } } })).status, 409);
    assert.equal(library.get(key)?.title, '');
    server = await serveControl(cfg.socket, request => handleControl(store, request, runtime, manager)); await manager.start();
    assert.equal((await call(route, { method: 'PUT', body: { revision: 1, changes: { title: '橘猫', tags: ['水彩'] } }, headers: { Origin: 'http://foreign.example' } })).status, 403);
    assert.equal((await call(route, { method: 'PUT', body: { revision: 1, changes: { title: '橘猫', tags: ['水彩'] } } })).status, 200);
    assert.equal((await call('/api/gallery?query=橘猫&tag=水彩')).body.items[0].id, key);
    assert.equal((await call(route, { method: 'PUT', body: { revision: 1, changes: { title: 'stale' } } })).status, 409);
    assert.equal((await call(route, { method: 'DELETE', body: { revision: 1 } })).status, 409);
    assert.equal((await call(route, { method: 'DELETE', body: { revision: 2 } })).status, 200);
    assert.equal((await call(route + '/image')).status, 404);
    assert.equal((await call('/api/gallery')).body.total, 0);
    assert.ok((await call(route)).body.deletedAt);
    const other = `drawing:${crypto.randomUUID()}`; await library.save(other, png, 'png', { prompt: 'next', model: 'test', createdAt: Date.now(), sources: [] });
    cfg.plugins.gallery = false;
    assert.equal((await call(`/api/gallery/${encodeURIComponent(other)}`, { method: 'PUT', body: { revision: 1, changes: { title: 'disabled' } } })).status, 400);
    assert.equal(library.get(other)?.title, '');
    assert.equal((await call('/api/gallery')).body.total, 1, 'operator can still browse disabled gallery');
  } finally { await manager.stop(); await runtime.stop(); await host.stop(); server?.closeClients(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); store.close(); }
}));

test('model assignments round-trip through the page with readiness, inheritance and primary continuity', () => page(async (call, dir) => {
  const current = (await call('/api/config')).body;
  const main = { provider: 'shared', id: 'daily', apiKeyEnv: 'MODEL_API_KEY', api: 'openai-completions', baseUrl: 'https://models.example/daily/v1', input: ['text', 'image'], contextWindow: 131072, maxTokens: 8192 };
  const raw = { ...current.raw, model: main };
  const saved = await call('/api/config', { method: 'PUT', body: { raw, hash: current.hash } });
  assert.equal(saved.status, 200);
  const config = loadConfig(join(dir, 'config.json'));
  const store = new Store(config.database);
  try {
    store.saveContext({ identity: inspectConfig(config).identities[0]!, generation: store.settings().generation, messages: [], sources: [] });
  } finally { store.close(); }
  const review = { ...main, id: 'review', apiKeyEnv: 'REVIEW_FILE_KEY', baseUrl: 'https://models.example/review/v1' };
  const summary = { ...main, id: 'summary', apiKeyEnv: 'SUMMARY_FILE_KEY', baseUrl: 'https://models.example/summary/v1' };
  const next = { ...raw, review: { model: review }, compaction: { ...raw.compaction, model: summary } };
  const check = (await call('/api/config/check', { method: 'POST', body: { raw: next } })).body;
  assert.equal(check.valid, true);
  assert.equal(check.context.continues, true);
  assert.ok(check.context.models.problems.some((problem: string) => problem.includes('REVIEW_FILE_KEY')));
  assert.equal((await call('/api/config', { method: 'PUT', body: { raw: next, hash: saved.body.hash } })).status, 200);
  const read = (await call('/api/config')).body;
  assert.deepEqual(read.raw.review.model, review);
  assert.deepEqual(read.raw.compaction.model, summary);
  const resolved = (await call('/api/models/resolve', { method: 'POST', body: { raw: next } })).body;
  assert.equal(resolved.main.thinking.id, 'daily'); assert.equal(resolved.review.thinking.id, 'review');
  assert.equal(resolved.main.compaction.id, 'summary'); assert.equal(resolved.review.compaction.id, 'summary');
  const inherited = { ...next, compaction: { ...raw.compaction } };
  const following = (await call('/api/models/resolve', { method: 'POST', body: { raw: inherited } })).body;
  assert.equal(following.main.compaction.id, 'daily'); assert.equal(following.review.compaction.id, 'review');
  const secrets = (await call('/api/secrets')).body.entries;
  assert.ok(secrets.find((secret: any) => secret.name === 'REVIEW_FILE_KEY').usedBy.includes('review.model'));
  assert.deepEqual(secrets.find((secret: any) => secret.name === 'SUMMARY_FILE_KEY').usedBy.filter((use: string) => use.startsWith('compaction:')), ['compaction:main', 'compaction:review']);
  const providers = (await call('/api/providers')).body.providers;
  assert.ok([main, review, summary].every(model => providers.some((provider: any) => provider.baseUrl === model.baseUrl)));
  const invalid = (await call('/api/config/check', { method: 'POST', body: { raw: { ...next, review: { model: {} } } } })).body;
  assert.equal(invalid.valid, false); assert.match(invalid.error, /review.model/);
  const changedMain = (await call('/api/config/check', { method: 'POST', body: { raw: { ...next, model: { ...main, id: 'another-daily' } } } })).body;
  assert.equal(changedMain.context.continues, false);
  assert.equal((await call('/api/config', { method: 'PUT', body: { raw: next, hash: current.hash } })).status, 409);
  const usage = (await call('/api/model-usage')).body;
  assert.equal(usage.total, 0); assert.equal(usage.cost, null);
}));
