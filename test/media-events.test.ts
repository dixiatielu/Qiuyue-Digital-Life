import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxAssistantMessage as answer, type Model } from '@earendil-works/pi-ai';
import { config, createTools, fixture, qqEvent } from './helpers.js';
import { PiBrain } from '../src/brain.js';
import { loadConfig } from '../src/config.js';
import { contextRecordId, persistableMessage, TokenMeter } from '../src/context.js';
import { deflateSync } from 'node:zlib';
import { mediaSeconds, mediaTokens, mp3Seconds, mp4Seconds, pdfPages, type MediaContent } from '../src/media.js';
import { nativeAdapterPlugin } from '../src/adapters/native.js';
import { telegramAdapter } from '../src/adapters/telegram/index.js';
import type { AdapterConfig } from '../src/config.js';
import { PluginHost } from '../src/plugins.js';
import { snowlumaToolsPlugin } from '../src/plugins/snowluma-tools.js';
import type { SocialAdapter } from '../src/platform.js';
import { Store } from '../src/store.js';
import { loadEventMedia, ToolRuntime, type ThoughtContext, type ToolMedia } from '../src/tool-runtime.js';

/** A constant-rate MPEG-1 Layer III stream at 44.1 kHz: `rate` is the header's bit-rate index, 9 for 128 kbit/s and 5 for 64. */
function mp3(frames: number, rate = 9, lead: number[] = []): Buffer {
  const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128][rate]!;
  const frame = Buffer.alloc(Math.floor(144_000 * kbps / 44_100)); frame.set([0xff, 0xfb, rate << 4, 0]);
  return Buffer.concat([Buffer.from(lead), ...Array.from({ length: frames }, () => frame)]);
}
function box(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content); const head = Buffer.alloc(8); head.writeUInt32BE(body.length + 8); head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
/** An MP4 that says how long it plays and holds nothing to play. */
function mp4(timescale: number, duration: number, wide = false): Buffer {
  const header = Buffer.alloc(wide ? 112 : 100);
  if (wide) { header[0] = 1; header.writeUInt32BE(timescale, 20); header.writeBigUInt64BE(BigInt(duration), 24); }
  else { header.writeUInt32BE(timescale, 12); header.writeUInt32BE(duration, 16); }
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0', 'latin1')), box('mdat', Buffer.alloc(64)), box('moov', box('mvhd', header))]);
}
const VOICE = mp3(100);
const voiceSource = (overrides: Partial<ToolMedia> = {}): ToolMedia => ({ kind: 'voice', load: async () => ({ data: VOICE, mimeType: 'audio/mpeg' }), ...overrides });
const limits = { maxMediaBytes: 1_000_000, maxMediaSeconds: 60 };

test('how long audio and video play is read from their own bytes', () => {
  // 100 frames of 1152 samples at 44.1 kHz play 2.61 seconds.
  assert.ok(Math.abs(mp3Seconds(VOICE)! - 2.61) < 0.02);
  // An encoder's first frame may hold information at another rate; the audio's rate is the second frame's.
  const led = Buffer.concat([mp3(1, 5), VOICE]);
  assert.ok(Math.abs(mp3Seconds(led)! - 2.62) < 0.03);
  // An ID3v2 tag gives its own length and is stepped over, whatever its bytes look like.
  const tagged = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20, 0xff), VOICE]);
  assert.ok(Math.abs(mp3Seconds(tagged)! - 2.61) < 0.02);
  assert.equal(mp3Seconds(Buffer.from('not audio at all')), undefined);
  assert.equal(mp4Seconds(mp4(1000, 5016)), 5.016);
  assert.equal(mp4Seconds(mp4(600, 12_000, true)), 20);
  assert.equal(mp4Seconds(Buffer.from('not a movie')), undefined);
  assert.equal(mp4Seconds(box('moov', Buffer.alloc(4))), undefined);
  assert.equal(mediaSeconds(mp4(1000, 5016), 'video/mp4'), 5.016);
  assert.equal(mediaSeconds(VOICE, 'audio/ogg'), undefined);
});

test('media is fetched within the operator\'s limits and comes back as the block a model perceives', async () => {
  const voice = await loadEventMedia(limits, voiceSource());
  assert.deepEqual({ ...voice, data: '' }, { type: 'media', mimeType: 'audio/mpeg', data: '', seconds: 2.6 });
  assert.equal(voice.data, VOICE.toString('base64'));
  // What the platform says of the length is believed before the bytes are asked.
  assert.equal((await loadEventMedia(limits, voiceSource({ seconds: 7 }))).seconds, 7);
  assert.equal((await loadEventMedia(limits, voiceSource({ load: async () => ({ data: Buffer.alloc(100), mimeType: 'audio/ogg' }) }))).seconds, undefined);
  // Anything a platform already says is too large or too long is refused before a byte is fetched.
  let fetched = 0; const counted = (overrides: Partial<ToolMedia>) => voiceSource({ load: async () => { fetched++; return { data: VOICE, mimeType: 'audio/mpeg' }; }, ...overrides });
  await assert.rejects(loadEventMedia(limits, counted({ bytes: 2_000_000 })), /This voice is 2\.0 MB; at most 1\.0 MB can be perceived/);
  await assert.rejects(loadEventMedia(limits, counted({ seconds: 600 })), /This voice runs 600s; at most 60s can be perceived/);
  await assert.rejects(loadEventMedia(limits, counted({ missingReason: 'The voice message has no readable file.' })), /no readable file/);
  assert.equal(fetched, 0);
  await assert.rejects(loadEventMedia({ ...limits, maxMediaBytes: 1000 }, voiceSource()), /at most 0\.0 MB/);
  await assert.rejects(loadEventMedia({ ...limits, maxMediaSeconds: 2 }, voiceSource()), /runs 3s; at most 2s/);
  await assert.rejects(loadEventMedia(limits, voiceSource({ load: async () => ({ data: VOICE, mimeType: 'application/octet-stream' }) })), /Unsupported media format: application\/octet-stream/);
});

test('QQ voice is converted by SnowLuma and video fetched from its address, numbered together as the record numbers them', async () => {
  const cfg = config(); const account = cfg.adapters[0]!;
  const calls: { action: string; args: Record<string, unknown> }[] = [];
  const adapter: SocialAdapter = { execute: async (action, args) => { calls.push({ action, args }); return args.file === 'broken.amr' ? { file: '', url: '', file_size: '0', file_name: '' } : { base64: VOICE.toString('base64'), out_format: 'mp3' }; } };
  const fetched: string[] = [];
  const plugin = snowlumaToolsPlugin(cfg, account, adapter, async (url, options) => { fetched.push(`${url} ${options.maxBytes}`); return { data: mp4(1000, 5016), type: 'application/octet-stream', url }; });
  const store = new Store(':memory:');
  try {
    const message = [
      { type: 'record', data: { file: 'spoken.amr', url: 'https://multimedia.nt.qq.com.cn/voice' } },
      { type: 'text', data: { text: 'look' } },
      { type: 'video', data: { file: 'clip.mp4', url: 'https://multimedia.nt.qq.com.cn/clip' } },
      { type: 'record', data: { file: 'broken.amr' } },
      { type: 'video', data: { file: 'lost.mp4' } },
    ];
    const event = store.receive(qqEvent({ key: 'qq:media', kind: 'message', at: Date.now(), text: 'look', groupId: 100, actorId: 7, payload: { message } }, store))!;
    const media = plugin.media!(event);
    assert.deepEqual(media.map(item => [item.kind, item.missingReason]), [['voice', undefined], ['video', undefined], ['voice', undefined], ['video', 'The video has no readable address.']]);
    assert.deepEqual(await media[0]!.load(1_000_000), { data: VOICE, mimeType: 'audio/mpeg' });
    assert.deepEqual(calls, [{ action: 'get_record', args: { file: 'spoken.amr', out_format: 'mp3' } }]);
    // QQ's media host does not name the type; the file name the message gives does.
    const clip = await loadEventMedia({ maxMediaBytes: 500_000, maxMediaSeconds: 60 }, media[1]!);
    assert.equal(clip.mimeType, 'video/mp4'); assert.equal(clip.seconds, 5);
    assert.deepEqual(fetched, ['https://multimedia.nt.qq.com.cn/clip 500000']);
    await assert.rejects(media[2]!.load(1_000_000), /no converted audio/);
    await assert.rejects(media[0]!.load(100), /exceeds the size limit/);
    // Without a connection to convert through, a voice message cannot be fetched at all.
    assert.equal(snowlumaToolsPlugin(cfg, account).media!(event)[0]!.missingReason, 'The voice message has no readable file.');
  } finally { store.close(); }
});

test('Telegram voice, audio, and video come in the formats Telegram holds them, with the length it gives', async () => {
  const tg: AdapterConfig = { ...config().adapters[0]!, id: 'tg_main', driver: 'telegram', accountId: '900', tokenEnv: 'TG_TOKEN', receive: 'manual', tools: { allow: '*', deny: [] }, groups: [] };
  const response = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  const updates = [
    { update_id: 1, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 1, voice: { file_id: 'voice_file', duration: 7, mime_type: 'audio/ogg', file_size: 3 } } },
    { update_id: 2, message: { message_id: 2, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 2, video_note: { file_id: 'note_file', duration: 12, length: 240 } } },
    { update_id: 3, message: { message_id: 3, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 3, audio: { file_id: 'song_file', duration: 200, mime_type: 'audio/mp4', title: 'Song' } } },
    { update_id: 4, message: { message_id: 4, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 4, text: 'no media' } },
    { update_id: 5, message: { message_id: 5, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 5, document: { file_id: 'paper_file', file_name: 'paper.pdf', mime_type: 'application/pdf', file_size: 3 } } },
    { update_id: 6, message: { message_id: 6, chat: { id: 7, type: 'private' }, from: { id: 7 }, date: 6, document: { file_id: 'zip_file', file_name: 'a.zip', mime_type: 'application/zip' } } },
  ];
  const downloads: string[] = [];
  const store = new Store(':memory:');
  const host = new PluginHost([nativeAdapterPlugin(telegramAdapter(tg, () => '900:test', (async url => {
    const value = String(url);
    if (value.includes('/file/bot')) { downloads.push(value.split('/file/bot900:test/')[1]!); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }); }
    const method = value.split('/').at(-1);
    return response(method === 'getMe' ? { id: 900 } : method === 'getWebhookInfo' ? { url: '' } : method === 'getFile' ? { file_id: 'any', file_path: 'voice/file_1.oga', file_size: 3 } : updates);
  }) as typeof fetch), store)]);
  try {
    const thought: ThoughtContext = { generation: store.settings().generation, sources: new Set(), triggers: new Set(), lifeOnly: false };
    const tools = host.bind(new ToolRuntime({ ...config(), adapters: [] }, store, () => thought, host))([]);
    await host.start(); await tools.find(tool => tool.name === 'tg_main__getUpdates')!.execute('test', {});
    const events = store.claim(10)!.events.filter(event => event.kind === 'message');
    const [voice, note, song, plain, paper, archive] = events.map(event => host.media(event));
    assert.deepEqual(voice!.map(({ kind, seconds, bytes }) => ({ kind, seconds, bytes })), [{ kind: 'voice', seconds: 7, bytes: 3 }]);
    assert.deepEqual(note!.map(({ kind, seconds }) => ({ kind, seconds })), [{ kind: 'video', seconds: 12 }]);
    assert.deepEqual(song!.map(({ kind, seconds }) => ({ kind, seconds })), [{ kind: 'audio', seconds: 200 }]);
    assert.deepEqual(plain, []);
    // A PDF sent as a document is read as one; a file of any other kind stays a name.
    assert.deepEqual(paper!.map(({ kind, bytes }) => ({ kind, bytes })), [{ kind: 'document', bytes: 3 }]);
    assert.deepEqual(archive, []);
    // The download names no type, so the message's own does; a video note is an MP4.
    assert.deepEqual(await loadEventMedia(limits, voice![0]!), { type: 'media', mimeType: 'audio/ogg', data: Buffer.from([1, 2, 3]).toString('base64'), seconds: 7 });
    assert.equal((await loadEventMedia(limits, note![0]!)).mimeType, 'video/mp4');
    assert.deepEqual(downloads, ['voice/file_1.oga', 'voice/file_1.oga']);
    await assert.rejects(loadEventMedia(limits, song![0]!), /runs 200s; at most 60s/);
    // A failure says nothing of the address, which holds the account's token.
    await assert.rejects(voice![0]!.load(2), error => error instanceof Error && error.message === 'Telegram media unavailable; it has not been perceived.');
  } finally { await host.stop(); store.close(); }
});

/** A thinking process over the built-in plugins whose model answers from the fixture's script but is declared as `model` is. */
function listening(model: Partial<Model<any>>, social: SocialAdapter) {
  const f = fixture(social);
  const models = createModels(); models.setProvider(f.faux.provider);
  let brain!: PiBrain;
  const tools = createTools(f.cfg, f.store, social, () => brain.thought);
  const restart = () => brain = new PiBrain(f.cfg, f.store, tools, { model: { ...f.faux.getModel(), ...model } as Model<any>, stream: (_target: any, context: any, options: any) => models.streamSimple(f.faux.getModel(), context, { ...options, cacheRetention: 'none' }) });
  restart();
  const said = (file: string) => f.store.receive(qqEvent({ key: `qq:voice:${file}`, kind: 'message', at: Date.now(), text: '[record]', groupId: 100, actorId: 7, payload: { message: [{ type: 'record', data: { file, url: 'https://multimedia.nt.qq.com.cn/voice' } }] } }, f.store))!;
  return { cfg: f.cfg, store: f.store, faux: f.faux, tools, said, get brain() { return brain; } };
}
const hearing = { api: 'google-generative-ai', input: ['text', 'image', 'audio'] } as unknown as Partial<Model<any>>;
const converting = () => {
  const converted: unknown[] = [];
  const social: SocialAdapter = { execute: async (action, args) => { if (action !== 'get_record') return { message_id: -1 }; converted.push(args.file); return { base64: VOICE.toString('base64') }; } };
  return { social, converted };
};

test('a model that takes audio hears a voice message with the line that brought it, and hears it again when asked', async () => {
  const { social, converted } = converting(); const f = listening(hearing, social);
  try {
    const voice = f.said('spoken.amr');
    let read: any[] = [];
    f.faux.setResponses([context => { read = structuredClone(context.messages.findLast(message => message.role === 'user' && Array.isArray(message.content))!.content as any[]); return answer('Quiet'); }]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(converted, ['spoken.amr']);
    assert.match(read[0].text, /\[voice 0\]/);
    const at = read.findIndex(block => block.type === 'image');
    assert.match(read[at - 1].text, /^The following is voice 0 from #[0-9a-f]+$/);
    // The inline carriage sends audio as the inline data an image is, under its own type.
    assert.deepEqual(read[at], { type: 'image', data: VOICE.toString('base64'), mimeType: 'audio/mpeg' });
    const kept = JSON.stringify(f.brain.agent.state.messages);
    assert.ok(!kept.includes(VOICE.toString('base64')));
    assert.match(kept, /\[Folded when the thought ended; it was 3s audio; view_event_media brings it back\]/);
    const played = await f.tools.current().find(tool => tool.name === 'view_event_media')!.execute('again', { id: voice.id });
    assert.deepEqual(played.content, [{ type: 'text', text: `Voice 0 from event ${voice.id}` }, { type: 'media', mimeType: 'audio/mpeg', data: VOICE.toString('base64'), seconds: 2.6 }]);
    await assert.rejects(f.tools.current().find(tool => tool.name === 'view_event_media')!.execute('none', { id: voice.id, index: 1 }), /no voice message, audio, video, or document at this index/);
  } finally { f.store.close(); }
});

test('voice messages beyond the limit wait to be asked for, and a model that takes no audio fetches none', async () => {
  const { social, converted } = converting(); const f = listening(hearing, social);
  try {
    f.cfg.limits.maxMedia = 1;
    f.said('first.amr'); f.said('second.amr');
    let text = '';
    f.faux.setResponses([context => { text = JSON.stringify(context.messages); return answer('Quiet'); }]);
    await f.brain.run(f.store.claim(10)!);
    assert.deepEqual(converted, ['first.amr']);
    assert.match(text, /voice 0 from #[0-9a-f]+ was not loaded; use view_event_media to hear it/);
  } finally { f.store.close(); }
  const deaf = converting(); const g = listening({}, deaf.social);
  try {
    g.said('unheard.amr');
    let text = '';
    g.faux.setResponses([context => { text = JSON.stringify(context.messages); return answer('Quiet'); }]);
    await g.brain.run(g.store.claim(10)!);
    assert.deepEqual(deaf.converted, []);
    assert.match(text, /\[voice 0\]/);
    assert.ok(!text.includes('The following is voice'));
    // The tool is declared whatever the model takes, so changing models does not begin the working context afresh.
    assert.ok(g.tools.current().some(tool => tool.name === 'view_event_media'));
  } finally { g.store.close(); }
});

test('the bytes of media are never archived, and a measured context holding media stays measured', () => {
  const media: MediaContent = { type: 'media', mimeType: 'audio/mpeg', data: VOICE.toString('base64'), seconds: 2.6 };
  const observation = { role: 'observation', batchId: 'b', eventIds: [], lifeOnly: false, content: [{ type: 'text', text: 'New' }, { type: 'text', text: 'The following is voice 0 from #abc123' }, media], timestamp: 1 } as never;
  const result = { role: 'toolResult', toolCallId: 'c', toolName: 'hear', content: [{ type: 'text', text: 'A recording' }, media], details: { secret: 1 }, isError: false, timestamp: 2 } as never;
  const saved = JSON.stringify([persistableMessage(observation), persistableMessage(result)]);
  assert.ok(!saved.includes(media.data));
  assert.match(saved, /it was 3s audio; view_event_media brings it back\]/);
  assert.match(saved, /\[Folded when the thought ended; it was 3s audio\]/);
  assert.ok(!saved.includes('secret'));
  // A record is known by what is saved of it, so the message in memory and the one restored share an ID.
  assert.equal(contextRecordId(observation), contextRecordId(persistableMessage(observation)));
  const plain = { role: 'observation', batchId: 'b', eventIds: [], lifeOnly: false, content: [{ type: 'text', text: 'New' }], timestamp: 1 } as never;
  assert.equal(persistableMessage(plain), plain);
  const meter = new TokenMeter(); const usage = { input: 900, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const system = { role: 'system', content: 'Instructions', timestamp: 0 } as never;
  meter.observe([system, observation], { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage, stopReason: 'stop', timestamp: 3 } as never, 'route');
  assert.equal(meter.measure([system, observation, { role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage, stopReason: 'stop', timestamp: 3 } as never], 'route').basis, 'usage');
  // Other bytes are another surface.
  const other = { ...(observation as any), content: [{ type: 'text', text: 'New' }, { type: 'text', text: 'The following is voice 0 from #abc123' }, { ...media, data: mp3(50).toString('base64') }] } as never;
  assert.equal(meter.measure([system, other], 'route').basis, 'estimate');
});

test('media limits are set by the operator, and no voice messages unasked is a valid choice', () => {
  const example = new URL('../config.example.json', import.meta.url).pathname;
  const loaded = loadConfig(example);
  assert.deepEqual([loaded.limits.maxMedia, loaded.limits.maxMediaBytes, loaded.limits.maxMediaSeconds], [4, 12_000_000, 300]);
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-media-config-'));
  try {
    const base = JSON.parse(readFileSync(example, 'utf8')); writeFileSync(join(dir, base.personaFile), 'Qiuyue');
    const withLimits = (limits: Record<string, number>) => { const path = join(dir, 'config.json'); writeFileSync(path, JSON.stringify({ ...base, limits })); return loadConfig(path).limits; };
    assert.equal(withLimits({ maxMedia: 0 }).maxMedia, 0);
    assert.throws(() => withLimits({ maxMedia: -1 }), /maxMedia must be a non-negative integer/);
    assert.throws(() => withLimits({ maxMediaBytes: 0 }), /maxMediaBytes must be a positive integer/);
    assert.throws(() => withLimits({ maxMediaSeconds: 1.5 }), /maxMediaSeconds must be a positive integer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A PDF with a page tree of `pages` pages, written in the clear or inside a compressed object stream as newer writers do. */
function pdf(pages: number, compressed = false): Buffer {
  const tree = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(' ')}] /Count ${pages} >>`;
  if (!compressed) return Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n${tree}\nendobj\n%%EOF\n`, 'latin1');
  const stream = deflateSync(Buffer.from(`2 0 ${tree}`, 'latin1'));
  return Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`, 'latin1'), stream, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')]);
}

test('the pages of a PDF are counted from its page tree, in the clear or in a compressed object stream', () => {
  assert.equal(pdfPages(pdf(1)), 1);
  // The list of a node's kids stands between its type and its count, however long it is.
  assert.equal(pdfPages(pdf(400)), 400);
  assert.equal(pdfPages(pdf(95, true)), 95);
  assert.equal(pdfPages(Buffer.from('%PDF-1.7 with nothing readable in it')), undefined);
  // An outline's count belongs to another dictionary and is not taken for pages.
  assert.equal(pdfPages(Buffer.from('<< /Type /Outlines /Count 900 >>\n<< /Type /Pages /Count 3 /Kids [] >>', 'latin1')), 3);
});

test('a PDF is read by the page, and one that would crowd the context is refused', async () => {
  const document = (pages: number, overrides: Partial<ToolMedia> = {}): ToolMedia => ({ kind: 'document', load: async () => ({ data: pdf(pages), mimeType: 'application/pdf' }), ...overrides });
  const read = await loadEventMedia(limits, document(12));
  assert.deepEqual({ ...read, data: '' }, { type: 'media', mimeType: 'application/pdf', data: '', pages: 12 });
  assert.equal(mediaTokens(read), 12 * 1100 + 8);
  // What is fetched must be what the message said it was.
  await assert.rejects(loadEventMedia(limits, document(1, { kind: 'video' })), /Unsupported media format: application\/pdf/);
  await assert.rejects(loadEventMedia(limits, document(1, { load: async () => ({ data: VOICE, mimeType: 'audio/mpeg' }) })), /Unsupported media format: audio\/mpeg/);
  await assert.rejects(loadEventMedia({ ...limits, contextTokens: 200_000 }, document(100)), /This document would take about 110008 tokens, more than a quarter of the context/);
  assert.equal((await loadEventMedia({ ...limits, contextTokens: 500_000 }, document(100))).pages, 100);
});

test('a QQ file is seen as an image or perceived as media by its name, fetched from a current address', async () => {
  const cfg = config(); const account = cfg.adapters[0]!;
  const asked: { action: string; args: Record<string, unknown> }[] = []; let refuse = false;
  const adapter: SocialAdapter = { execute: async (action, args) => { asked.push({ action, args }); if (refuse) throw new Error('not allowed'); return { url: `https://current.example/${args.file_id}` }; } };
  const fetched: string[] = [];
  const plugin = snowlumaToolsPlugin(cfg, account, adapter, async (url, options) => { fetched.push(`${url} ${options.maxBytes}`); return { data: url.includes('paper') ? pdf(7) : Buffer.from('bytes'), type: 'application/octet-stream', url }; });
  const store = new Store(':memory:');
  const file = (name: string, id: string, size = 1000, extra: Record<string, unknown> = {}) => ({ type: 'file', data: { file: name, name, file_id: id, id, file_size: size, size, url: `https://stale.example/${id}`, file_hash: '', ...extra } });
  try {
    const message = [
      { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/picture', summary: '' } },
      file('photo.PNG', 'photo'), file('paper.pdf', 'paper', 2_000_000), file('archive.zip', 'archive'), file('song.flac', 'song'), file('huge.jpg', 'huge', 9_000_000),
    ];
    const group = store.receive(qqEvent({ key: 'qq:files', kind: 'message', at: Date.now(), text: 'files', groupId: 100, actorId: 7, payload: { message } }, store))!;
    const images = plugin.images!(group);
    assert.deepEqual(images.map(image => [image.label.replace(/#[0-9a-f]+/, '#ref').replace(/; url.*/, ''), image.autoView]), [
      ['The following is image 0 from #ref', true],
      ['The following is image 1 from #ref, sent as the file photo.PNG', true],
      // A file keeps an image at full size, and a large one waits to be asked for.
      ['The following is image 2 from #ref, sent as the file huge.jpg', false],
    ]);
    assert.deepEqual(await images[1]!.load(), { data: Buffer.from('bytes'), mimeType: 'image/png' });
    assert.deepEqual(asked, [{ action: 'get_group_file_url', args: { group_id: 100, file_id: 'photo' } }]);
    assert.deepEqual(fetched, [`https://current.example/photo ${cfg.limits.maxMediaBytes}`]);
    const media = plugin.media!(group);
    assert.deepEqual(media.map(item => [item.kind, item.bytes]), [['document', 2_000_000], ['audio', 1000]]);
    const paper = await loadEventMedia({ ...cfg.limits, maxMediaBytes: 3_000_000 }, media[0]!);
    assert.equal(paper.mimeType, 'application/pdf'); assert.equal(paper.pages, 7);
    assert.equal(fetched.at(-1), 'https://current.example/paper 3000000');
    await assert.rejects(loadEventMedia({ ...cfg.limits, maxMediaBytes: 1_000_000 }, media[0]!), /This document is 2\.0 MB; at most 1\.0 MB/);
    // When the current address cannot be had, the one the message came with is tried.
    refuse = true;
    assert.equal((await media[1]!.load(1_000_000)).mimeType, 'audio/flac');
    assert.equal(fetched.at(-1), 'https://stale.example/song 1000000');
    refuse = false; asked.length = 0;
    const direct = store.receive(qqEvent({ key: 'qq:private-file', kind: 'message', at: Date.now(), text: 'file', actorId: 7, payload: { message: [file('notes.pdf', 'notes', 500, { file_hash: 'HASH' })] } }, store))!;
    await plugin.media!(direct)[0]!.load(1_000_000);
    assert.deepEqual(asked, [{ action: 'get_private_file_url', args: { user_id: 7, file_id: 'notes', file_hash: 'HASH' } }]);
  } finally { store.close(); }
});

test('an observation numbers what a file can be asked for as, and leaves other files as names', async () => {
  const { social } = converting(); const f = listening(hearing, social);
  try {
    const file = (name: string, size: number) => ({ type: 'file', data: { file: name, name, file_id: name, id: name, file_size: size, size, url: '', file_hash: '' } });
    f.store.receive(qqEvent({ key: 'qq:file-lines', kind: 'message', at: Date.now(), text: 'files', groupId: 100, actorId: 7, payload: { message: [file('huge.jpg', 9_000_000), file('paper.pdf', 1000), file('archive.zip', 1000), file('clip.mp4', 1000)] } }, f.store));
    let text = '';
    f.faux.setResponses([context => { text = JSON.stringify(context.messages); return answer('Quiet'); }]);
    await f.brain.run(f.store.claim(10)!);
    assert.match(text, /\[file huge\.jpg, image 0\]\[file paper\.pdf, document 0\]\[file archive\.zip\]\[file clip\.mp4, video 1\]/);
  } finally { f.store.close(); }
});

test('an image or video whose address has lapsed is fetched from the one the message carries when read again', async () => {
  const cfg = config(); const account = cfg.adapters[0]!;
  const read: unknown[] = []; let held = true;
  const png = Buffer.from('renewed picture');
  const adapter: SocialAdapter = { execute: async (action, args) => {
    read.push([action, args.message_id]);
    if (!held) throw new Error('message not found');
    return { message: [{ type: 'image', data: { file: 'a.jpg', url: 'https://multimedia.nt.qq.com.cn/fresh-a' } }, { type: 'image', data: { file: 'b.jpg', url: 'https://multimedia.nt.qq.com.cn/fresh-b' } }, { type: 'video', data: { file: 'clip.mp4', url: 'https://multimedia.nt.qq.com.cn/fresh-clip' } }] };
  } };
  const fetched: string[] = [];
  const plugin = snowlumaToolsPlugin(cfg, account, adapter, async (url, options) => {
    fetched.push(url.split('/').at(-1)!);
    if (url.includes('stale')) throw new Error('HTTP 400');
    if (url.includes('oversized')) throw new Error('The response exceeds the size limit.');
    return url.includes('clip') ? { data: mp4(1000, 3000), type: 'application/octet-stream', url } : { data: png, type: options.maxBytes === 5_000_000 ? 'image/png' : 'text/html', url };
  });
  const store = new Store(':memory:');
  try {
    const message = [
      { type: 'image', data: { file: 'a.jpg', url: 'https://multimedia.nt.qq.com.cn/stale-a' } },
      { type: 'image', data: { file: 'b.jpg', url: 'https://multimedia.nt.qq.com.cn/current-b' } },
      { type: 'video', data: { file: 'clip.mp4', url: 'https://multimedia.nt.qq.com.cn/stale-clip' } },
    ];
    const event = store.receive(qqEvent({ key: 'qq:lapsed', kind: 'message', at: Date.now(), text: 'old', groupId: 100, actorId: 7, payload: { message_id: 555, message } }, store))!;
    const [first, second] = plugin.images!(event);
    assert.deepEqual(await first!.load(), { data: png, mimeType: 'image/png' });
    assert.deepEqual(fetched, ['stale-a', 'fresh-a']); assert.deepEqual(read, [['get_msg', 555]]);
    // An address that still answers is used as it is, without reading the message again.
    await second!.load();
    assert.deepEqual(fetched.slice(2), ['current-b']); assert.equal(read.length, 1);
    const clip = await loadEventMedia(limits, plugin.media!(event)[0]!);
    assert.equal(clip.seconds, 3); assert.deepEqual(fetched.slice(3), ['stale-clip', 'fresh-clip']);
    // An event received before sources carried the message's ID has it in the payload SnowLuma pushed.
    read.length = 0;
    await plugin.images!({ ...event, source: { ...event.source!, messageId: undefined } })[0]!.load();
    assert.deepEqual(read, [['get_msg', 555]]);
    // When QQ no longer holds the message, the refusal stands.
    held = false;
    await assert.rejects(Promise.resolve(first!.load()), /HTTP 400/);
    // Too large is not a lapsed address, and is not asked about again.
    held = true; read.length = 0;
    const large = store.receive(qqEvent({ key: 'qq:large', kind: 'message', at: Date.now(), text: 'big', groupId: 100, actorId: 7, payload: { message_id: 556, message: [{ type: 'video', data: { file: 'big.mp4', url: 'https://multimedia.nt.qq.com.cn/oversized' } }] } }, store))!;
    await assert.rejects(plugin.media!(large)[0]!.load(1000), /exceeds the size limit/);
    assert.deepEqual(read, []);
  } finally { store.close(); }
});
