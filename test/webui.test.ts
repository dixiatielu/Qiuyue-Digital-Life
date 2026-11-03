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
import { Credentials, credentialPaths } from '../src/credentials.js';
import { inspectConfig } from '../src/webui/inspect.js';
import { ServiceJobs, type LiveMirror } from '../src/webui/daemon.js';
import type { LifeReader } from '../src/webui/reader.js';
import { PluginManager } from '../src/plugin-manager.js';
import { createPlugins } from '../src/plugins/index.js';
import { createTools } from '../src/tools.js';
import { contextIdentity } from '../src/brain.js';
import { LifeRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { handleControl, serveControl } from '../src/control.js';

const token = 'test-token-0123456789';
async function page(work: (call: (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<{ status: number; body: any }>, dir: string, port: number) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-webui-'));
  const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  writeFileSync(join(dir, base.personaFile), 'Qiuyue, a student who likes rain.\n');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, extra: { kept: true } }, null, 2) + '\n');
  writeFileSync(join(dir, '.env'), '# credentials\nMODEL_API_KEY=sk-old-value-1234\n\nOTHER=1\n');
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

test('the page asks for its token, refuses foreign hosts and cross-site writes, and signs in with a cookie', () => page(async (call, _dir, port) => {
  assert.equal((await call('/api/overview', { headers: { Authorization: '' } })).status, 401);
  assert.equal((await call('/api/overview', { headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status, 401);
  // fetch will not send another Host, so ask the way a rebound name would arrive.
  const host = await new Promise<number>(done => request({ host: '127.0.0.1', port, path: '/api/overview', headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, response => { response.resume(); done(response.statusCode!); }).end());
  assert.equal(host, 421);
  const login = await call(`/login?token=${token}`, { headers: { Authorization: '' } });
  assert.equal(login.status, 303);
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
  assert.match(login.body, /\.env/);
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

test('the login form submits the token in its body and keeps startup login links working', () => page(async (_call, _dir, port) => {
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
  assert.equal((await fetch(`${base}/login?token=${token}`, { redirect: 'manual' })).status, 303);
}));

test('a configuration is saved only whole, valid, and against the version it was read at, keeping unknown keys and earlier versions', () => page(async (call, dir) => {
  const loaded = await call('/api/config');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.error, null);
  const raw = loaded.body.raw;
  const before = readFileSync(join(dir, 'config.json'), 'utf8');
  const invalid = await call('/api/config', { method: 'PUT', body: { raw: { ...raw, snowluma: { ...raw.snowluma, selfId: 0 } }, hash: loaded.body.hash } });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /selfId/);
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
  assert.equal(systemInstructions(config, true), 'You are:\nQiuyue, who likes snow.\n\nOld part.');
  assert.equal(systemInstructions({ ...config, life: { ...config.life, allowFiction: true } }), 'You are:\nQiuyue, who likes snow.\n\nOld part.\nNew part. Fiction.');
  const preview = await call('/api/prompt/preview', { method: 'POST', body: { template: 'Hi {{persona}}\n<!-- current-context -->\n' } });
  assert.equal(preview.body.text, 'Hi Qiuyue, who likes snow.\n');
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
  assert.equal(before.body.entries.find((item: any) => item.name === 'MODEL_API_KEY').source, 'legacy');
  assert.ok(!before.body.entries.some((item: any) => item.name === 'OTHER'));
  const originalEnvironment = process.env.MODEL_API_KEY;
  const updated = await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'sk-new value#5678', revision: before.body.revision } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.entries.find((item: any) => item.name === 'MODEL_API_KEY').source, 'file');
  assert.equal(process.env.MODEL_API_KEY, originalEnvironment);
  assert.ok(readFileSync(join(dir, '.env'), 'utf8').includes('sk-old-value-1234'), 'legacy input is read-only until explicit migration');
  const credentials = new Credentials(credentialPaths(join(dir, 'config.json')), {});
  assert.equal(credentials.get('MODEL_API_KEY'), 'sk-new value#5678');
  assert.ok(!JSON.stringify(updated.body).includes('sk-new value'));
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'stale-value', revision: before.body.revision } })).status, 409);
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'unversioned' } })).status, 400);
  const removed = await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: null, revision: updated.body.revision } });
  assert.equal(removed.status, 200);
  assert.equal(new Credentials(credentials.paths, {}).get('MODEL_API_KEY'), undefined, 'the old .env value stays disabled');
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
      writeFileSync(join(dir, '.env'), `${name}=legacy-value\n`);
      const list = await call('/api/secrets');
      const item = list.body.entries.find((item: any) => item.name === name);
      assert.equal(item.source, 'environment'); assert.equal(item.writable, false);
      assert.equal(new Credentials(credentialPaths(path)).get(name), 'externally-managed-secret');
      assert.equal((await call('/api/secrets', { method: 'PUT', body: { name, value: 'replacement', revision: list.body.revision } })).status, 400);
      assert.equal(existsSync(join(dir, 'credentials.json')), false);
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
    assert.notEqual(identity({ ...base, plugins: { 'qq-faces': false } }), original);
    assert.notEqual(identity({ ...base, snowluma: { ...base.snowluma, tools: { allow: '*', deny: ['send_poke'] } } }), original);
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
  const manager = new PluginManager(cfg, host, store, social, () => loadConfig(path), () => undefined);
  manager.connect(runtime, () => { const next = contextIdentity(cfg, tools), changed = next !== identity; identity = next; return changed; });
  mkdirSync(join(dir, 'plugins/clock'), { recursive: true });
  writeFileSync(join(dir, 'plugins/clock/index.mjs'), readFileSync(new URL('../examples/plugins/clock/index.mjs', import.meta.url)));
  const server = await serveControl(cfg.socket, request => handleControl(store, request, runtime, manager));
  try {
    await manager.start();
    const listed = await call('/api/plugins');
    const clock = listed.body.running.plugins.find((item: any) => item.id === 'clock');
    assert.equal(clock.state, 'running'); assert.equal(clock.version, '1.0.0');
    assert.equal(clock.configSchema.properties.timeZone.type, 'string');
    const config = await call('/api/config');
    assert.equal((await call('/api/config', { method: 'PUT', body: { raw: { ...config.body.raw, plugins: { clock: false } }, hash: config.body.hash } })).status, 200);
    const pending = await call('/api/plugins');
    assert.equal(pending.body.running.plugins.find((item: any) => item.id === 'clock').pending, true);
    const reload = await call('/api/plugins/reload', { method: 'POST', body: { id: 'clock' } });
    assert.equal(reload.status, 200); assert.ok(['preparing', 'waiting', 'applying', 'done'].includes(reload.body.state));
    await manager.settled();
    const after = await call('/api/plugins');
    assert.equal(after.body.running.job.state, 'done'); assert.equal(after.body.running.job.contextReset, true);
    assert.equal(after.body.running.plugins.find((item: any) => item.id === 'clock').state, 'disabled');
    assert.ok(!tools.current().some(tool => tool.name === 'clock_read'));
  } finally { await manager.stop(); await runtime.stop(); await host.stop(); server.closeClients(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}));
