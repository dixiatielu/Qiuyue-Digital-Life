import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { loadConfig } from '../src/config.js';
import { builtinSystemPrompt, systemInstructions } from '../src/prompts.js';
import { WebUi } from '../src/webui/server.js';
import { setEnvText } from '../src/webui/files.js';
import { inspectConfig } from '../src/webui/inspect.js';
import { ServiceJobs, type LiveMirror } from '../src/webui/daemon.js';
import type { LifeReader } from '../src/webui/reader.js';

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

test('credentials are written to .env and never returned, only whether and how they end', () => page(async (call, dir) => {
  const listed = await call('/api/secrets');
  const model = listed.body.find((item: any) => item.name === 'MODEL_API_KEY');
  assert.deepEqual(model.usedBy.slice(0, 1), ['model']);
  assert.equal(model.value, '••••1234');
  assert.ok(!JSON.stringify(listed.body).includes('sk-old-value'));
  assert.equal(listed.body.find((item: any) => item.name === 'OTHER').value, '1', 'a variable that is not a credential is shown');
  await call('/api/secrets', { method: 'PUT', body: { name: 'MODEL_API_KEY', value: 'sk-new value#5678' } });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), "# credentials\nMODEL_API_KEY='sk-new value#5678'\n\nOTHER=1\n");
  assert.equal(process.env.MODEL_API_KEY, 'sk-new value#5678');
  await call('/api/secrets', { method: 'PUT', body: { name: 'OTHER', value: null } });
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), "# credentials\nMODEL_API_KEY='sk-new value#5678'\n\n");
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'BAD NAME', value: 'x' } })).status, 400);
  assert.equal((await call('/api/secrets', { method: 'PUT', body: { name: 'MULTI', value: 'a\nb' } })).status, 400);
  delete process.env.MODEL_API_KEY;
}));

test('.env edits keep comments and order, and drop later definitions that would override the one set', () => {
  assert.equal(setEnvText('', 'A', 'x'), 'A=x\n');
  assert.equal(setEnvText('A=1\n# note\nB=2\nexport A=3\n', 'A', 'y'), 'A=y\n# note\nB=2\n');
  assert.equal(setEnvText('A=1\nB=2', 'B', null), 'A=1\n');
  assert.equal(setEnvText('A=1\n', 'C', 'with "double"'), "A=1\nC='with \"double\"'\n");
  assert.throws(() => setEnvText('', 'D', `both ' and "`), /both single and double/);
});

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
