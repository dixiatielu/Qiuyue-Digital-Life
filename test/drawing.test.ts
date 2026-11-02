import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai';
import { Drawings, ImageClient, imageType, type Painter } from '../src/drawing.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { deferred, fixture } from './helpers.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);
/** A painter whose pictures arrive when the test lets them. */
function painter() {
  const calls: string[] = []; const pending: ReturnType<typeof deferred<Buffer | Error>>[] = [];
  const value: Painter = { model: 'painter', paint: async (prompt, signal) => {
    calls.push(prompt); const next = deferred<Buffer | Error>(); pending.push(next);
    signal?.addEventListener('abort', () => next.resolve(new Error('aborted')), { once: true });
    const result = await next.promise; if (result instanceof Error) throw result; return result;
  } };
  return { value, calls, finish: (result: Buffer | Error, index = 0) => pending[index]!.resolve(result) };
}
function setup(social?: Parameters<typeof fixture>[0]) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawings-'));
  const paint = painter(); let drawings!: Drawings;
  const f = fixture(social, undefined, undefined, store => (drawings = new Drawings(store, paint.value, dir, 90)));
  f.brain.thought.lifeOnly = false;
  const run = (name: string, args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === name)!.execute('call', args);
  const done = () => new Promise<void>(resolve => { const stop = f.store.subscribe(notice => { if (notice.kind === 'environment' && notice.event.kind === 'drawing') { stop(); resolve(); } }); });
  return { f, dir, paint, run, done, get drawings() { return drawings; }, close: () => { f.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const text = (result: { content: { type: string }[] }) => JSON.parse((result.content[0] as { text: string }).text);

test('the image client asks for one picture and explains a refusal', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const replies = [new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })), new Response(JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } }), { status: 400 }), new Response(JSON.stringify({ data: [] }))];
  const client = new ImageClient({ enabled: true, baseUrl: 'https://images.example/v1/', model: 'gpt-image', apiKeyEnv: 'QIUYUE_TEST_IMAGE_KEY', timeoutMs: 1000, dir: '' }, async (url, init) => { requests.push({ url: String(url), init: init! }); return replies.shift()!; });
  process.env.QIUYUE_TEST_IMAGE_KEY = 'secret';
  try {
    assert.deepEqual(await client.paint('a cat'), png);
    assert.equal(requests[0]!.url, 'https://images.example/v1/images/generations');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { model: 'gpt-image', prompt: 'a cat', n: 1 });
    assert.equal((requests[0]!.init.headers as Record<string, string>).Authorization, 'Bearer secret');
    await assert.rejects(client.paint('a cat'), /HTTP 400: Your request was rejected by the safety system\./);
    await assert.rejects(client.paint('a cat'), /no image data/);
  } finally { delete process.env.QIUYUE_TEST_IMAGE_KEY; }
  assert.equal(imageType(png), 'image/png');
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageType(Buffer.from('<html>')), undefined);
});

test('a drawing is painted apart from the thought and comes back as an observation with its picture', async () => {
  const { f, paint, run, done, close } = setup();
  try {
    f.brain.thought.triggers = new Set(['e:asked']);
    const started = text(await run('draw', { prompt: 'An orange cat asleep on a sunny windowsill, watercolor' }));
    assert.match(started.drawingId, /^drawing:[0-9a-f-]{36}$/); assert.equal(started.status, 'drawing');
    assert.deepEqual(paint.calls, ['An orange cat asleep on a sunny windowsill, watercolor']);
    // Nothing comes back until the picture does.
    assert.equal(f.store.pending(), 0);
    const finished = done(); paint.finish(png); await finished;
    const observation = f.store.claim(20)!;
    const event = observation.events[0]!;
    assert.deepEqual([event.kind, event.payload.drawingId, event.payload.sources, event.payload.error], ['drawing', started.drawingId, ['e:asked'], undefined]);
    assert.match(event.text, new RegExp(`put ${started.drawingId} where an image file goes`));
    assert.deepEqual(f.store.setting('drawingsUnderWay'), {});
    f.faux.setResponses([context => {
      const content = JSON.stringify(context.messages);
      assert.ok(content.includes(`The following is your drawing ${started.drawingId} from event ${event.id}`));
      assert.ok(content.includes(png.toString('base64')));
      return answer('I like how it came out.');
    }]);
    await f.brain.run(observation);
    assert.equal(f.faux.state.callCount, 1);
    const viewed = await run('view_event_image', { id: event.id, index: 0 });
    assert.deepEqual(viewed.content[1], { type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
  } finally { close(); }
});

test('a drawing that fails comes back with the reason and no picture', async () => {
  const { f, paint, run, done, close } = setup();
  try {
    const started = text(await run('draw', { prompt: 'Something the endpoint refuses' }));
    const finished = done(); paint.finish(new Error('The image request failed: HTTP 400: rejected by the safety system')); await finished;
    const event = f.store.claim(20)!.events[0]!;
    assert.equal(event.payload.drawingId, started.drawingId);
    assert.match(String(event.payload.error), /rejected by the safety system/);
    assert.match(event.text, /could not be finished/);
    await assert.rejects(run('view_event_image', { id: event.id, index: 0 }), /no picture/);
    assert.deepEqual(f.store.setting('drawingsUnderWay'), {});
  } finally { close(); }
});

test('a drawing is sent by its ID: what is sent carries the picture, and the action record keeps the ID', async () => {
  const sent: { action: string; args: Record<string, unknown> }[] = [];
  const { f, paint, run, done, close } = setup({ execute: async (action, args) => { sent.push({ action, args }); return { message_id: -9 }; } });
  try {
    const { drawingId } = text(await run('draw', { prompt: 'A mug of cocoa by a snowy window' }));
    const finished = done(); paint.finish(png); await finished;
    const message = [{ type: 'image', data: { file: drawingId } }, { type: 'text', data: { text: '画好啦' } }];
    await run('send_group_msg', { group_id: 100, message });
    assert.deepEqual(sent, [{ action: 'send_group_msg', args: { group_id: 100, message: [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }, { type: 'text', data: { text: '画好啦' } }] } }]);
    const action = f.store.actions().find(item => item.kind === 'send_group_msg')!;
    assert.deepEqual([action.status, action.args], ['success', { group_id: 100, message }]);
    await run('send_qzone_msg', { content: '今天画的', images: [drawingId] });
    assert.deepEqual(sent[1]!.args.images, [`base64://${png.toString('base64')}`]);
    // A drawing that does not exist fails before anything is recorded or sent.
    const missing = 'drawing:00000000-0000-4000-8000-000000000000';
    await assert.rejects(run('send_group_msg', { group_id: 100, message: [{ type: 'image', data: { file: missing } }] }), /does not exist/);
    assert.equal(sent.length, 2); assert.equal(f.store.actions().length, 2);
  } finally { close(); }
});

test('a drawing a restart cut short is reported at the next start, and files past retention are removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawings-recover-'));
  const store = new Store(':memory:');
  try {
    const paint = painter();
    const first = new Drawings(store, paint.value, dir, 90);
    const { drawingId } = first.start('A long painting', []);
    await first.stop();
    // Shutdown leaves it under way rather than calling it failed.
    assert.equal(store.pending(), 0);
    assert.deepEqual(Object.keys(store.setting('drawingsUnderWay')), [drawingId]);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, '11111111-1111-4111-8111-111111111111.png'); const recent = join(dir, '22222222-2222-4222-8222-222222222222.png');
    writeFileSync(old, png); writeFileSync(recent, png);
    const longAgo = new Date(Date.now() - 91 * 86_400_000); utimesSync(old, longAgo, longAgo);
    new Drawings(store, paint.value, dir, 90).recover();
    const event = store.claim(20)!.events[0]!;
    assert.deepEqual([event.kind, event.payload.drawingId], ['drawing', drawingId]);
    assert.match(String(event.payload.error), /restarted/);
    assert.deepEqual(store.setting('drawingsUnderWay'), {});
    assert.equal(existsSync(old), false); assert.deepEqual(readFileSync(recent), png);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the draw tool is offered only when drawing is on', () => {
  const f = fixture();
  try { assert.equal(f.tools.current().some(tool => tool.name === 'draw'), false); } finally { f.store.close(); }
  const { f: on, close } = setup();
  try { assert.equal(on.tools.current().some(tool => tool.name === 'draw'), true); } finally { close(); }
});

test('drawing is off by default and, when on, needs an endpoint and a model; its files sit beside the configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawing-config-'));
  try {
    const base = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const path = join(dir, 'config.json');
    const load = (drawing: Record<string, unknown>) => { writeFileSync(path, JSON.stringify({ ...base, drawing })); return loadConfig(path); };
    const on = { enabled: true, baseUrl: 'http://127.0.0.1:8317/v1', model: 'gpt-image-2.5' };
    assert.deepEqual(load({}).drawing, { enabled: false, baseUrl: '', model: '', apiKeyEnv: 'MODEL_API_KEY', timeoutMs: 300_000, dir: join(dir, 'data/drawings') });
    assert.equal(load({ ...on, dir: 'pictures' }).drawing.dir, join(dir, 'pictures'));
    for (const baseUrl of ['', 'ftp://images.example', 'https://user:pass@images.example/v1']) assert.throws(() => load({ ...on, baseUrl }), /drawing.baseUrl/);
    assert.throws(() => load({ ...on, model: ' ' }), /drawing.model/);
    assert.throws(() => load({ ...on, timeoutMs: 0 }), /drawing.timeoutMs/);
    assert.throws(() => load({ ...on, apiKeyEnv: 'not-a-name' }), /environment variable/);
    assert.throws(() => load({ ...on, enabled: 'yes' }), /boolean/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
