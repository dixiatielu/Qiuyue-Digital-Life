import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { once } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fauxAssistantMessage as answer } from '@earendil-works/pi-ai';
import { drawingPlugin, Drawings, ImageClient, imageType, prepareReferenceImage, type Painter, type PaintOptions } from '../src/plugins/drawing.js';
import { DrawingLibrary } from '../src/plugins/gallery-store.js';
import { loadConfig } from '../src/config.js';
import { Store, eventRef } from '../src/store.js';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
import { deferred, fixture, qqEvent } from './helpers.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('picture')]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('VP8 ')]);
/** A painter whose pictures arrive when the test lets them. */
function painter() {
  const calls: string[] = []; const options: (PaintOptions | undefined)[] = []; const pending: ReturnType<typeof deferred<Buffer | Error>>[] = [];
  const value: Painter = { model: 'painter', paint: async (prompt, signal, opts) => {
    calls.push(prompt); options.push(opts); const next = deferred<Buffer | Error>(); pending.push(next);
    signal?.addEventListener('abort', () => next.resolve(new Error('aborted')), { once: true });
    const result = await next.promise; if (result instanceof Error) throw result; return result;
  } };
  return { value, calls, options, finish: (result: Buffer | Error, index = 0) => pending[index]!.resolve(result), waitCall: async (index = 0) => { while (pending.length <= index) await new Promise(resolve => setImmediate(resolve)); } };
}
function setup(social?: Parameters<typeof fixture>[0], extraPlugins: (store: Store) => LifePlugin[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawings-'));
  const paint = painter(); let drawings!: Drawings;
  const f = fixture(social, undefined, undefined, store => [drawingPlugin(drawings = new Drawings(store, paint.value, dir)), ...extraPlugins(store)]);
  f.brain.thought.lifeOnly = false;
  const run = (name: string, args: Record<string, unknown>) => f.tools.current().find(tool => tool.name === name)!.execute('call', args);
  const done = () => new Promise<void>(resolve => { const stop = f.store.subscribe(notice => { if (notice.kind === 'environment' && notice.event.kind === 'drawing') { stop(); resolve(); } }); });
  return { f, dir, paint, run, done, get drawings() { return drawings; }, close: () => { f.store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const text = (result: { content: { type: string }[] }) => JSON.parse((result.content[0] as unknown as { text: string }).text);

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

test('imagen generates an image apart from the thought and returns an observation with its picture', async () => {
  const { f, paint, run, done, close } = setup();
  try {
    f.brain.thought.triggers = new Set(['e:asked']);
    const started = text(await run('imagen', { prompt: 'An orange cat asleep on a sunny windowsill, photorealistic photo with natural lighting' }));
    assert.match(started.drawingId, /^drawing:[0-9a-f-]{36}$/); assert.equal(started.status, 'drawing');
    assert.deepEqual(paint.calls, ['An orange cat asleep on a sunny windowsill, photorealistic photo with natural lighting']);
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
      assert.ok(content.includes(`The following is your generated image ${started.drawingId} from ${eventRef(event.id)}`));
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
    const started = text(await run('imagen', { prompt: 'Something the endpoint refuses' }));
    const finished = done(); paint.finish(new Error('The image request failed: HTTP 400: rejected by the safety system')); await finished;
    const event = f.store.claim(20)!.events[0]!;
    assert.equal(event.payload.drawingId, started.drawingId);
    assert.match(String(event.payload.error), /rejected by the safety system/);
    assert.match(event.text, /could not be generated/);
    await assert.rejects(run('view_event_image', { id: event.id, index: 0 }), /no picture/);
    assert.deepEqual(f.store.setting('drawingsUnderWay'), {});
  } finally { close(); }
});

test('a drawing is sent by its ID: what is sent carries the picture, and the action record keeps the ID', async () => {
  const sent: { action: string; args: Record<string, unknown> }[] = [];
  const { f, paint, run, done, close } = setup({ execute: async (action, args) => { sent.push({ action, args }); return { message_id: -9 }; } });
  try {
    const { drawingId } = text(await run('imagen', { prompt: 'A mug of cocoa by a snowy window, watercolor' }));
    const finished = done(); paint.finish(png); await finished;
    const message = [{ type: 'image', data: { file: drawingId } }, { type: 'text', data: { text: '画好啦' } }];
    await run("qq_main__send_group_msg", { group_id: 100, message });
    assert.deepEqual(sent, [{ action: 'send_group_msg', args: { group_id: 100, message: [{ type: 'image', data: { file: `base64://${png.toString('base64')}` } }, { type: 'text', data: { text: '画好啦' } }] } }]);
    const action = f.store.actions().find(item => item.kind === 'qq_main__send_group_msg')!;
    assert.deepEqual([action.status, action.args], ['success', { group_id: 100, message }]);
    await run("qq_main__send_qzone_msg", { content: '今天画的', images: [drawingId] });
    assert.deepEqual((sent[1]!.args as { images?: unknown }).images, [`base64://${png.toString('base64')}`]);
    // A drawing that does not exist fails before anything is recorded or sent.
    const missing = 'drawing:00000000-0000-4000-8000-000000000000';
    await assert.rejects(run("qq_main__send_group_msg", { group_id: 100, message: [{ type: 'image', data: { file: missing } }] }), /does not exist/);
    assert.equal(sent.length, 2); assert.equal(f.store.actions().length, 2);
  } finally { close(); }
});

test('a drawing a restart cut short is reported at the next start, and old works remain available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawings-recover-'));
  const store = new Store(':memory:');
  try {
    const paint = painter();
    const first = new Drawings(store, paint.value, dir);
    const firstHost = new PluginHost([drawingPlugin(first)]); await firstHost.start();
    const { drawingId } = first.start('A long painting', []);
    await firstHost.stop();
    // Shutdown leaves it under way rather than calling it failed.
    assert.equal(store.pending(), 0);
    assert.deepEqual(Object.keys(store.setting('drawingsUnderWay')), [drawingId]);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, '11111111-1111-4111-8111-111111111111.png'); const recent = join(dir, '22222222-2222-4222-8222-222222222222.png');
    writeFileSync(old, png); writeFileSync(recent, png);
    const longAgo = new Date(Date.now() - 91 * 86_400_000); utimesSync(old, longAgo, longAgo);
    const restarted = new PluginHost([drawingPlugin(new Drawings(store, paint.value, dir))]);
    await restarted.start();
    const event = store.claim(20)!.events[0]!;
    assert.deepEqual([event.kind, event.payload.drawingId], ['drawing', drawingId]);
    assert.match(String(event.payload.error), /restarted/);
    assert.deepEqual(store.setting('drawingsUnderWay'), {});
    assert.deepEqual(readFileSync(old), png); assert.deepEqual(readFileSync(recent), png);
    await restarted.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the imagen tool replaces draw and is offered only when drawing is on', () => {
  const f = fixture();
  try { assert.equal(f.tools.current().some(tool => tool.name === 'imagen'), false); } finally { f.store.close(); }
  const { f: on, close } = setup();
  try {
    assert.equal(on.tools.current().some(tool => tool.name === 'imagen'), true);
    assert.equal(on.tools.current().some(tool => tool.name === 'draw'), false);
    assert.ok(on.plugins.activities().some(item => item.tools.includes('imagen')));
    assert.equal(on.plugins.experienceKind('imagen'), 'drawing');
  } finally { close(); }
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

test('the image client sends /images/edits multipart for references and background=transparent when requested', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const ok = () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
  const replies = [ok(), ok(), ok(), new Response(JSON.stringify({ error: { message: 'edit refused' } }), { status: 400 })];
  const client = new ImageClient(
    { enabled: true, baseUrl: 'https://images.example/v1/', model: 'gpt-image-2.6', apiKeyEnv: 'QIUYUE_TEST_IMAGE_KEY', timeoutMs: 1000, dir: '' },
    async (url, init) => { requests.push({ url: String(url), init: init! }); return replies.shift()!; },
  );
  process.env.QIUYUE_TEST_IMAGE_KEY = 'secret';
  try {
    // Text-to-image with transparent background
    assert.deepEqual(await client.paint('a sticker cat', undefined, { transparentBackground: true }), png);
    assert.equal(requests[0]!.url, 'https://images.example/v1/images/generations');
    assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), { model: 'gpt-image-2.6', prompt: 'a sticker cat', n: 1, background: 'transparent' });

    // Single reference image -> singular `image` multipart field
    assert.deepEqual(await client.paint('make the sky sunset', undefined, { images: [{ data: png, mimeType: 'image/png', filename: 'reference-1.png' }], transparentBackground: true }), png);
    assert.equal(requests[1]!.url, 'https://images.example/v1/images/edits');
    assert.equal((requests[1]!.init.headers as Record<string, string>).Authorization, 'Bearer secret');
    assert.equal((requests[1]!.init.headers as Record<string, string>)['Content-Type'], undefined);
    const single = requests[1]!.init.body as FormData;
    assert.ok(single instanceof FormData);
    assert.equal(single.get('model'), 'gpt-image-2.6');
    assert.equal(single.get('prompt'), 'make the sky sunset');
    assert.equal(single.get('n'), '1');
    assert.equal(single.get('background'), 'transparent');
    assert.equal(single.getAll('image').length, 1);
    assert.equal(single.getAll('image[]').length, 0);
    const singleFile = single.get('image') as File;
    assert.equal(singleFile.type, 'image/png');
    assert.deepEqual(Buffer.from(await singleFile.arrayBuffer()), png);

    // Multiple reference images -> `image[]` multipart fields in order, without background when omitted
    assert.deepEqual(await client.paint('combine Image 1 and Image 2', undefined, { images: [{ data: png, mimeType: 'image/png' }, { data: jpg, mimeType: 'image/jpeg' }] }), png);
    assert.equal(requests[2]!.url, 'https://images.example/v1/images/edits');
    const multi = requests[2]!.init.body as FormData;
    assert.equal(multi.get('background'), null);
    assert.equal(multi.getAll('image').length, 0);
    const files = multi.getAll('image[]') as File[];
    assert.equal(files.length, 2);
    assert.equal(files[0]!.type, 'image/png');
    assert.deepEqual(Buffer.from(await files[0]!.arrayBuffer()), png);
    assert.equal(files[1]!.type, 'image/jpeg');
    assert.deepEqual(Buffer.from(await files[1]!.arrayBuffer()), jpg);

    // Error handling on /images/edits
    await assert.rejects(client.paint('bad edit', undefined, { images: [{ data: png, mimeType: 'image/png' }] }), /HTTP 400: edit refused/);
  } finally { delete process.env.QIUYUE_TEST_IMAGE_KEY; }
});

test('prepareReferenceImage keeps PNG/JPEG/WebP, converts GIF to PNG, and rejects non-images', async () => {
  assert.equal((await prepareReferenceImage(png, 0)).mimeType, 'image/png');
  assert.equal((await prepareReferenceImage(jpg, 1)).filename, 'reference-2.jpg');
  assert.equal((await prepareReferenceImage(webp, 2)).mimeType, 'image/webp');
  const gif = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).gif().toBuffer();
  const converted = await prepareReferenceImage(gif, 0);
  assert.equal(converted.mimeType, 'image/png');
  assert.equal(converted.filename, 'reference-1.png');
  assert.equal(imageType(converted.data), 'image/png');
  await assert.rejects(prepareReferenceImage(Buffer.from('<html>nope</html>'), 0), /not a supported PNG, JPEG, WebP, or GIF/);
});

test('imagen supports referencing gallery drawings and plugin event images, recording provenance and transparent background', async () => {
  let shownCount = 0;
  let pluginEventId = '';
  const adapterPlugin: LifePlugin = {
    id: 'test-photo-adapter',
    tools: () => [],
    images: event => event.id === pluginEventId ? [{
      label: 'Platform photo 0', unavailable: 'Unavailable', deferred: 'Deferred', autoView: true,
      load: async () => ({ data: jpg, mimeType: 'image/jpeg' }),
      onShown: () => { shownCount++; },
    }] : [],
  };
  const { f, dir, paint, run, done, close } = setup(undefined, () => [adapterPlugin]);
  try {
    // Create a base gallery image first
    const baseStarted = text(await run('imagen', { prompt: 'Base character illustration' }));
    await paint.waitCall(0);
    const baseDone = done(); paint.finish(png, 0); await baseDone;
    f.store.claim(20);

    // Create an incoming event whose image comes from a platform adapter (like Telegram)
    const chatEvent = f.store.receive(qqEvent({ key: 'tg:photo:1', kind: 'message', at: Date.now(), text: 'Look at this background', payload: { message: [] } }, f.store))!;
    pluginEventId = chatEvent.id;
    f.brain.thought.triggers = new Set(['e:ask']);

    // Reference both the gallery work and the platform event image (using short #xxxxxxxx ref) with transparent_background
    const editStarted = text(await run('imagen', {
      prompt: 'Put the character from Image 1 into the lighting of Image 2 as a sticker',
      images: [{ drawingId: baseStarted.drawingId }, { event: eventRef(chatEvent.id), index: 0 }],
      transparent_background: true,
    }));
    assert.equal(editStarted.status, 'drawing');
    assert.equal(editStarted.referenceCount, 2);
    assert.equal(editStarted.transparentBackground, true);
    // Referenced event is added to the thought's sources
    assert.ok(f.brain.thought.sources.has(chatEvent.id));

    await paint.waitCall(1);
    assert.equal(paint.options[1]?.transparentBackground, true);
    assert.equal(paint.options[1]?.images?.length, 2);
    assert.equal(paint.options[1]?.images?.[0]?.mimeType, 'image/png');
    assert.deepEqual(paint.options[1]?.images?.[0]?.data, png);
    assert.equal(paint.options[1]?.images?.[1]?.mimeType, 'image/jpeg');
    assert.deepEqual(paint.options[1]?.images?.[1]?.data, jpg);
    // Using an image as an imagen reference does not mark it as viewed by the model.
    assert.equal(shownCount, 0);

    const editDone = done(); paint.finish(png, 1); await editDone;
    const observation = f.store.claim(20)!;
    const event = observation.events.find(e => e.kind === 'drawing')!;
    const expectedRefs = [{ drawingId: baseStarted.drawingId }, { eventId: chatEvent.id, index: 0 }];
    assert.deepEqual(event.payload.references, expectedRefs);
    assert.equal(event.payload.transparentBackground, true);
    assert.deepEqual(event.payload.sources, ['e:ask', chatEvent.id]);
    assert.match(event.text, new RegExp(`Referenced images: Image 1: ${baseStarted.drawingId}; Image 2: image 0 from ${eventRef(chatEvent.id)}`));

    const saved = new DrawingLibrary(f.store.db, dir).get(editStarted.drawingId)!;
    assert.deepEqual(saved.references, expectedRefs);
    assert.equal(saved.transparentBackground, true);
    assert.ok(saved.sources.some(source => source.id === chatEvent.id));

    // Empty images array behaves like text-to-image (no options passed)
    const emptyStarted = text(await run('imagen', { prompt: 'A fresh sketch', images: [] }));
    await paint.waitCall(2);
    assert.equal(paint.options[2], undefined);
    assert.equal(emptyStarted.referenceCount, undefined);
    const emptyDone = done(); paint.finish(png, 2); await emptyDone;
  } finally { close(); }
});

test('imagen loads QQ message image segments and tool-result URLs (including Qzone JPEG preference)', async t => {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url!);
    const avif = /[?&]t=8/.test(request.url!);
    response.writeHead(200, { 'Content-Type': avif ? 'image/avif' : 'image/jpeg' });
    response.end(avif ? Buffer.from('avif') : jpg);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const originalRequest = http.request;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => originalRequest(url, {
    ...options, autoSelectFamily: false, lookup: (_hostname, _options, done) => done(null, '127.0.0.1', 4),
  } as http.RequestOptions, callback));
  syncBuiltinESMExports();
  const { f, paint, run, done, close } = setup();
  try {
    const qqImgUrl = `http://m.qpic.cn:${address.port}/psc?/CHAT_IMG!/b&ek=1&t=8`;
    const qzoneUrl = `http://m.qpic.cn:${address.port}/psc?/QZONE_IMG!/c&ek=1&t=8`;
    const msgEvent = f.store.receive(qqEvent({ key: 'qq:msg:img', kind: 'message', at: Date.now(), text: '[image]', payload: { message: [{ type: 'image', data: { url: qqImgUrl } }] } }, f.store))!;
    const feedEvent = f.store.receive(qqEvent({ key: 'tool:qzone', kind: 'adapter:qq_main:get_qzone_public_feeds', at: Date.now(), text: '{}', payload: { result: { html: `<img src="${qzoneUrl.replaceAll('&', '&amp;')}">` } } }, f.store), true)!;

    const started = text(await run('imagen', {
      prompt: 'Blend Image 1 and Image 2 into a postcard',
      images: [{ event: msgEvent.id, index: 0 }, { event: feedEvent.id, url: qzoneUrl.replaceAll('&', '&amp;') }],
    }));
    assert.equal(started.referenceCount, 2);
    await paint.waitCall(0);
    assert.equal(requests[0], '/psc?/CHAT_IMG!/b&ek=1');
    assert.equal(requests[1], '/psc?/QZONE_IMG!/c&ek=1');
    assert.deepEqual(paint.options[0]?.images?.map(img => img.mimeType), ['image/jpeg', 'image/jpeg']);

    const finished = done(); paint.finish(png, 0); await finished;
    const event = f.store.claim(20)!.events.find(e => e.kind === 'drawing')!;
    assert.deepEqual(event.payload.references, [
      { eventId: msgEvent.id, index: 0 },
      { eventId: feedEvent.id, url: qzoneUrl },
    ]);
  } finally {
    close();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('imagen rejects invalid references synchronously and reports background load failures cleanly', async () => {
  let brokenEventId = '';
  const brokenPlugin: LifePlugin = {
    id: 'broken-photo-adapter',
    tools: () => [],
    images: event => event.id === brokenEventId ? [{
      label: 'Broken photo', unavailable: 'Platform image expired.', deferred: 'Deferred', autoView: true,
      load: async () => undefined,
    }] : [],
  };
  const { f, paint, run, done, close } = setup(undefined, () => [brokenPlugin]);
  try {
    const msgEvent = f.store.receive(qqEvent({ key: 'qq:msg:noimg', kind: 'message', at: Date.now(), text: 'hello', payload: { message: [{ type: 'text', data: { text: 'hello' } }] } }, f.store))!;
    const brokenEvent = f.store.receive(qqEvent({ key: 'tg:broken', kind: 'message', at: Date.now(), text: 'photo', payload: { message: [] } }, f.store))!;
    brokenEventId = brokenEvent.id;

    // A failed drawing event should also be rejected synchronously if referenced via { event, index: 0 }
    const failedStart = text(await run('imagen', { prompt: 'will fail' }));
    await paint.waitCall(0);
    const failDone = done(); paint.finish(new Error('refused'), 0); await failDone;
    const failedEvent = f.store.claim(20)!.events.find(e => e.kind === 'drawing')!;
    assert.equal(failedEvent.payload.drawingId, failedStart.drawingId);

    const missingId = 'drawing:00000000-0000-4000-8000-000000000000';
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ drawingId: missingId }] }), /does not exist/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ drawingId: missingId, event: msgEvent.id, index: 0 }] }), /either drawingId or event/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{}] }), /either drawingId or event/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ index: 0 }] }), /needs an event ID/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: msgEvent.id }] }), /exactly one of index or url/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: msgEvent.id, index: 0, url: 'https://example.com/a.png' }] }), /exactly one of index or url/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: msgEvent.id, index: 0 }] }), /does not exist or has no readable URL/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: msgEvent.id, url: 'https://example.com/not-in-event.png' }] }), /does not appear in the event/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: 'e:missing', index: 0 }] }), /does not exist or has been deleted/);
    await assert.rejects(run('imagen', { prompt: 'x', images: [{ event: failedEvent.id, index: 0 }] }), /no picture/);
    await assert.rejects(run('imagen', { prompt: 'x', images: Array.from({ length: 6 }, () => ({ drawingId: missingId })) }), /At most 5/);
    // Failed validation never pollutes thought sources or starts background work.
    assert.equal(f.brain.thought.sources.has(msgEvent.id), false);
    assert.equal(paint.calls.length, 1);

    // Background load failure reports back cleanly as a failed drawing event.
    const finished = done();
    const started = text(await run('imagen', { prompt: 'edit broken photo', images: [{ event: brokenEvent.id, index: 0 }] }));
    await finished;
    const event = f.store.claim(20)!.events.find(e => e.kind === 'drawing')!;
    assert.equal(event.payload.drawingId, started.drawingId);
    assert.match(String(event.payload.error), /Could not load reference image 1: Platform image expired\./);
    assert.deepEqual(f.store.setting('drawingsUnderWay'), {});
    assert.equal(paint.calls.length, 1);
  } finally { close(); }
});

test('restart recovery preserves reference metadata and transparentBackground without persisting image bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-drawings-recover-refs-'));
  const store = new Store(':memory:');
  try {
    const paint = painter();
    const first = new Drawings(store, paint.value, dir);
    const firstHost = new PluginHost([drawingPlugin(first)]); await firstHost.start();
    const refId = `drawing:${crypto.randomUUID()}`;
    const { drawingId: cutShort } = first.start('Edit cut short', ['e:src'], {
      references: [{ reference: { drawingId: refId }, load: () => ({ data: png, mimeType: 'image/png' }) }],
      transparentBackground: true,
    });
    const { drawingId: writtenBeforeCrash } = first.start('Edit written before crash', ['e:src'], {
      references: [{ reference: { drawingId: refId }, load: () => ({ data: png, mimeType: 'image/png' }) }],
      transparentBackground: true,
    });
    await firstHost.stop();
    const underWay = store.setting<Record<string, any>>('drawingsUnderWay');
    assert.deepEqual(underWay[cutShort].references, [{ drawingId: refId }]);
    assert.equal(underWay[cutShort].transparentBackground, true);
    assert.ok(!JSON.stringify(underWay).includes(png.toString('base64')));

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${writtenBeforeCrash.slice(8)}.png`), png);

    const restarted = new PluginHost([drawingPlugin(new Drawings(store, paint.value, dir))]);
    await restarted.start();
    const events = store.claim(20)!.events;
    const failedEv = events.find(e => e.payload.drawingId === cutShort)!;
    const okEv = events.find(e => e.payload.drawingId === writtenBeforeCrash)!;
    assert.match(String(failedEv.payload.error), /restarted/);
    assert.deepEqual(failedEv.payload.references, [{ drawingId: refId }]);
    assert.equal(okEv.payload.error, undefined);
    assert.deepEqual(okEv.payload.references, [{ drawingId: refId }]);
    assert.equal(okEv.payload.transparentBackground, true);
    const catalog = new DrawingLibrary(store.db, dir).get(writtenBeforeCrash)!;
    assert.deepEqual(catalog.references, [{ drawingId: refId }]);
    assert.equal(catalog.transparentBackground, true);
    await restarted.stop();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
