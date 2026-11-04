import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { fauxAssistantMessage as answer, fauxToolCall as call } from '@earendil-works/pi-ai';
import { bilibiliReference } from '../packages/bilibili/index.js';
import { xiaohongshuReference } from '../packages/xiaohongshu/index.js';
import { PlatformNetwork, ReadingHistory, networkDefaults } from '../packages/online-reading/index.js';
import { createPlugins } from './helpers.js';
import { ToolRuntime, type ThoughtContext } from '../src/tool-runtime.js';
import { PluginHost } from '../src/plugins.js';
import { Store } from '../src/store.js';
import { loadUserPlugin } from '../src/plugin-loader.js';
import { installPackagedPlugin } from './packaged-plugins.js';
import type { PluginContext } from '../src/plugin-sdk.js';
import { config, event, fixture } from './helpers.js';

const video = 'BV1xx411c7mD', note = '64f1a2b3c4d5e6f7a8b9c0d1';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fastClock(t: TestContext) { let now = Date.now(); t.mock.method(Date, 'now', () => now += 2000); return (ms: number) => { now += ms; }; }
function biliTransport(options: { noSubtitles?: boolean; subtitleFailure?: boolean; commentFailure?: boolean; externalSubtitle?: boolean } = {}) {
  const state = { loggedIn: true, favorite: false, loseFavoriteResponse: false, failFavoriteConfirmation: false, defaultFolder: true,
    liked: false, loseLikeResponse: false, failLikeConfirmation: false, invalidLikeState: false, likeCode: 0 };
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push({ url, init });
    if (url.hostname === 'b23.tv') return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${video}?p=2` } });
    if (url.hostname === 'i0.hdslb.com') return json({ body: Array.from({ length: 85 }, (_, i) => ({ from: i * 2, to: i * 2 + 2, content: `Cloud drawing step ${i}` })) });
    switch (url.pathname) {
      case '/x/frontend/finger/spi': return json({ code: 0, data: { b_3: 'guest-buvid' } });
      case '/x/web-interface/nav': return json({ code: state.loggedIn ? 0 : -101, data: { isLogin: state.loggedIn, mid: 900, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } } });
      case '/x/v3/fav/folder/created/list-all': return json({ code: 0, data: { list: [{ id: 123, mid: 900, title: state.defaultFolder ? '默认收藏夹' : '云朵', fav_state: state.favorite ? 1 : 0 }, { id: 456, mid: 900, title: 'Other collection', fav_state: 1 }] } });
      case '/x/v3/fav/resource/deal': {
        const form = new URLSearchParams(String(init?.body));
        if (!state.failFavoriteConfirmation) state.favorite = Boolean(form.get('add_media_ids'));
        if (state.loseFavoriteResponse) throw new Error('Disconnected after changing remote state');
        return json({ code: 0, data: { prompt: false } });
      }
      case '/x/web-interface/archive/relation': return json({ code: 0, data: { like: state.invalidLikeState ? 0 : state.liked } });
      case '/x/web-interface/archive/like': {
        if (state.likeCode !== 0) return json({ code: state.likeCode });
        if (!state.failLikeConfirmation) state.liked = new URLSearchParams(String(init?.body)).get('like') === '1';
        if (state.loseLikeResponse) throw new Error('Disconnected after changing remote state');
        return json({ code: 0 });
      }
      case '/x/web-interface/popular': return json({ code: 0, data: { list: [{ bvid: video, title: 'Clouds', owner: { name: 'Painter' } }], no_more: true } });
      case '/x/web-interface/wbi/search/type': return json({ code: 0, data: { result: [{ type: 'video', bvid: video, title: '<em>Clouds</em>', author: 'Painter' }, { type: 'ketang', bvid: '', title: 'Paid course' }], numPages: 2 } });
      case '/x/web-interface/wbi/view': return json({ code: 0, data: { bvid: video, aid: 42, title: 'Clouds', desc: 'Draw clouds', owner: { name: 'Painter' }, pic: 'https://i0.hdslb.com/cover.jpg', pages: [1, 2].map(page => ({ page, cid: 100 + page, part: `Part ${page}`, duration: 200 })) } });
      case '/x/player/wbi/v2': return options.subtitleFailure ? json({ code: -101 }) : json({ code: 0, data: { subtitle: { subtitles: options.noSubtitles ? [] : [{ lan: 'zh-CN', lan_doc: '中文', subtitle_url: options.externalSubtitle ? 'https://evil.example/steal' : '//i0.hdslb.com/subtitle.json' }] } } });
      case '/x/v2/reply/wbi/main': return options.commentFailure ? json({ code: -352 }) : json({ code: 0, data: { replies: [{ rpid: 12, member: { uname: 'A viewer' }, content: { message: 'Useful!' } }] } });
      default: throw new Error(`Unexpected request ${url.pathname}`);
    }
  }) as typeof fetch;
  return { requests, fetcher, state };
}
const storage = (store: Store, id: string): PluginContext['storage'] => ({
  get: (key, fallback) => store.setting(`plugin:${id}:${key}`, fallback),
  set: (key, value) => store.setSetting(`plugin:${id}:${key}`, value),
});
async function loadedPlugin(t: TestContext, platform: string, cfg: ReturnType<typeof config>, store: Store, fetcher: typeof fetch, credential?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'qiuyue-online-plugin-'));
  t.mock.method(globalThis, 'fetch', fetcher);
  cfg.extensions.directory = join(dir, 'plugins'); cfg.extensions.dataDirectory = join(dir, 'data'); cfg.plugins[platform] = true;
  await installPackagedPlugin(cfg.extensions.directory, platform);
  const loaded = await loadUserPlugin(platform, cfg, store, () => credential ?? (platform === 'bilibili' ? 'SESSDATA=private-session; bili_jct=private-csrf; unrelated=secret' : 'private-token'), AbortSignal.timeout(5000));
  await loaded.plugin.start?.();
  t.after(async () => { await loaded.plugin.stop?.(); rmSync(dir, { recursive: true, force: true }); });
  return loaded.plugin;
}
async function imageTransport(t: TestContext) {
  const requests: { path: string; authorization?: string; cookie?: string }[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization, cookie: request.headers.cookie });
    response.writeHead(request.url!.includes('failed') ? 404 : 200, { 'Content-Type': 'image/png' });
    response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=', 'base64'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const originalRequest = http.request;
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(https, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => originalRequest(new URL(`http://image.example:${address.port}${url.pathname}`), {
    ...options, autoSelectFamily: false, lookup: (_hostname, _options, done) => done(null, '127.0.0.1', 4),
  }, callback));
  syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return requests;
}
async function harness(t: TestContext, platform: 'bilibili' | 'xiaohongshu', fetcher: typeof fetch, existing?: Store, settings = {}, credential?: string) {
  const imageRequests = platform === 'xiaohongshu' ? await imageTransport(t) : [];
  const store = existing ?? new Store(':memory:'), cfg = config();
  cfg.extensions.settings[platform] = settings;
  const thought: ThoughtContext = { generation: store.settings().generation, sources: new Set(), triggers: new Set(), lifeOnly: false };
  const host = new PluginHost([await loadedPlugin(t, platform, cfg, store, fetcher, credential)]);
  const tools = host.bind(new ToolRuntime(cfg, store, () => thought))([]);
  const raw = (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => tools.find(tool => tool.name === name)!.execute('test', args, signal);
  const run = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const result = await raw(name, args, signal);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { cfg, thought, host, store, run, raw, imageRequests };
}

test('Bilibili discovery, real sources, saved intent and subtitle cursors survive restart and finish across parts', async t => {
  fastClock(t); const transport = biliTransport(); const dir = mkdtempSync(join(tmpdir(), 'qiuyue-reading-'));
  let h = await harness(t, 'bilibili', transport.fetcher, new Store(join(dir, 'life.sqlite')));
  try {
    const found = await h.run('bili_browse', { query: 'clouds' });
    assert.equal(found.result.items[0].title, 'Clouds'); assert.equal(found.result.nextPage, 2);
    assert.equal((await h.run('bili_history')).items[0].readAt, undefined, 'a search preview is not a completed read');
    const read = await h.run('bili_read', { input: video });
    assert.equal(read.result.subtitles.lines.length, 80); assert.deepEqual(read.result.nextCursor, { part: 1, subtitleOffset: 80 });
    assert.equal(h.store.event(read.sourceId)?.kind, 'plugin:bilibili:reading'); assert.ok(h.thought.sources.has(read.sourceId));
    assert.match(read.result.perception, /No video frames or audio/);
    await h.run('bili_keep', { id: video, saved: true, note: 'Try the cloud shading tomorrow' });
    h.store.close(); h = await harness(t, 'bilibili', transport.fetcher, new Store(join(dir, 'life.sqlite')));
    assert.equal((await h.run('bili_history', { savedOnly: true })).items[0].note, 'Try the cloud shading tomorrow');
    const continued = await h.run('bili_read', { input: `https://www.bilibili.com/video/${video}` });
    assert.equal(continued.result.subtitles.lines.length, 5); assert.equal(continued.result.subtitles.lines[0].from, 160);
    assert.deepEqual(continued.result.nextCursor, { part: 2, subtitleOffset: 0 });
    await h.run('bili_read', { input: video });
    const end = await h.run('bili_read', { input: video });
    assert.equal(end.result.partReadingComplete, true); assert.deepEqual(end.result.nextCursor, { part: 2, subtitleOffset: 85 });
    const restart = await h.run('bili_read', { input: video, restart: true });
    assert.equal(restart.result.part, 1); assert.equal(restart.result.subtitles.lines[0].from, 0);
    assert.equal(h.store.actions().length, 1); assert.equal(h.store.actions()[0]?.kind, 'plugin:bilibili:favorite');
    const player = transport.requests.find(r => r.url.pathname === '/x/player/wbi/v2')!;
    assert.ok(player.url.searchParams.has('w_rid')); assert.match(new Headers(player.init?.headers).get('cookie')!, /private-session/);
    assert.ok(!new Headers(player.init?.headers).get('cookie')!.includes('unrelated'));
    assert.equal(new Headers(transport.requests.find(r => r.url.hostname === 'i0.hdslb.com')!.init?.headers).get('cookie'), null);
  } finally { h.store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('missing or failed subtitles never become watched video or completed reading, and failures keep prior progress', async t => {
  fastClock(t); const options = { subtitleFailure: false, commentFailure: false }; const transport = biliTransport(options);
  const h = await harness(t, 'bilibili', transport.fetcher);
  try {
    await h.run('bili_read', { input: video }); options.subtitleFailure = true;
    const read = await h.run('bili_read', { input: video });
    assert.equal(read.result.subtitles.status, 'unavailable'); assert.equal(read.result.partReadingComplete, false);
    assert.deepEqual(read.result.nextCursor, { part: 1, subtitleOffset: 80 }); assert.match(read.result.warnings[0], /login required/);
    options.subtitleFailure = false; options.commentFailure = true;
    const partial = await h.run('bili_read', { input: video });
    assert.equal(partial.result.comments, null); assert.equal(partial.result.subtitles.lines.length, 5);
    const before = transport.requests.length;
    await assert.rejects(h.run('bili_browse'), /cooling down/); assert.equal(transport.requests.length, before);
  } finally { h.store.close(); }
  const absent = await harness(t, 'bilibili', biliTransport({ noSubtitles: true }).fetcher);
  try { const read = await absent.run('bili_read', { input: video }); assert.equal(read.result.subtitles.status, 'not_available'); assert.equal(read.result.partReadingComplete, false); }
  finally { absent.store.close(); }
});

test('video URLs are constrained, short links lose credentials, and untrusted subtitle hosts are not requested', async t => {
  fastClock(t); const transport = biliTransport({ externalSubtitle: true }); const h = await harness(t, 'bilibili', transport.fetcher);
  try {
    for (const input of [`https://evil.example/${video}`, `https://bilibili.com.evil.example/video/${video}`, `https://user:pass@www.bilibili.com/video/${video}`, `https://www.bilibili.com/video/${video}?p=-1`]) assert.throws(() => bilibiliReference(input));
    const read = await h.run('bili_read', { input: 'https://b23.tv/abc123' });
    assert.equal(read.result.part, 2); assert.match(read.result.warnings[0], /Unexpected subtitle host/);
    assert.ok(!transport.requests.some(r => r.url.hostname === 'evil.example'));
    assert.equal(new Headers(transport.requests[0]!.init?.headers).get('cookie'), null);
  } finally { h.store.close(); }
});

function xhsTransport() {
  const state = { loggedIn: true, failedDetail: false, differentNote: false, favorite: false, loseFavoriteResponse: false, images: ['https://sns-webpic-qc.xhscdn.com/cloud.jpg'],
    liked: false, loseLikeResponse: false, failLikeConfirmation: false, invalidLikeState: false, wrongLikeReceipt: false };
  const requests: { url: URL; init?: RequestInit }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push({ url, init });
    switch (url.pathname) {
      case '/api/v1/login/status': return json({ success: true, data: { is_logged_in: state.loggedIn } });
      case '/api/v1/feeds/list': case '/api/v1/feeds/search': return json({ success: true, data: { feeds: [
        { modelType: 'hot_query', id: 'non-note' },
        { id: note, xsecToken: 'note-access-token', modelType: 'note', noteCard: { displayTitle: 'Cloud painting', user: { nickname: 'Artist' }, cover: { urlDefault: 'https://sns-webpic-qc.xhscdn.com/cover.jpg' } } },
      ] } });
      case '/api/v1/feeds/favorite': {
        state.favorite = !JSON.parse(String(init?.body)).unfavorite;
        if (state.loseFavoriteResponse) throw new Error('Lost response after remote state changed');
        return json({ success: true, data: { feed_id: note, success: true, message: 'ok' } });
      }
      case '/api/v1/feeds/like': {
        if (!state.failLikeConfirmation) state.liked = !JSON.parse(String(init?.body)).unlike;
        if (state.loseLikeResponse) throw new Error('Lost response after remote state changed');
        return json({ success: true, data: { feed_id: state.wrongLikeReceipt ? 'another-note' : note, success: true, message: 'ok' } });
      }
      case '/api/v1/feeds/detail': return state.failedDetail ? json({ error: 'private-token private details' }) : json({ success: true, data: { feed_id: note, data: {
        note: { noteId: state.differentNote ? '74f1a2b3c4d5e6f7a8b9c0d1' : note, title: 'Cloud painting', desc: 'My watercolor method', type: 'normal', user: { nickname: 'Artist' }, imageList: state.images.map(urlDefault => ({ urlDefault })), interactInfo: { liked: state.invalidLikeState ? null : state.liked } },
        comments: { list: [{ id: 'c1', content: 'Nice clouds', userInfo: { nickname: 'Viewer' } }], hasMore: true },
      } } });
      default: throw new Error(`Unexpected ${url.pathname}`);
    }
  }) as typeof fetch;
  return { state, requests, fetcher };
}

test('Xiaohongshu reads text with attached images, retains private navigation tokens, and favorites on the account', async t => {
  fastClock(t); const transport = xhsTransport(), h = await harness(t, 'xiaohongshu', transport.fetcher);
  try {
    const feed = await h.run('xhs_browse'); assert.equal(feed.result.items.length, 1); assert.equal(feed.result.nextPage, null);
    assert.ok(!JSON.stringify(feed).includes('note-access-token'));
    await h.run('xhs_keep', { id: note, saved: true, note: 'Look at these colors later' });
    const read = await h.run('xhs_read', { input: note });
    assert.deepEqual(read.result.images, ['https://sns-webpic-qc.xhscdn.com/cloud.jpg']);
    assert.deepEqual(read.imageDelivery.attached, read.result.images); assert.equal(h.imageRequests.length, 1); assert.equal(read.result.commentsHaveMore, true);
    assert.ok(JSON.stringify(h.store.event(read.sourceId)?.payload).includes(read.result.images[0]));
    assert.equal((await h.run('xhs_history', { savedOnly: true })).items[0].sourceId, read.sourceId);
    assert.ok(!JSON.stringify(await h.run('xhs_history')).includes('note-access-token'));
    const detail = transport.requests.find(r => r.url.pathname.endsWith('/detail'))!;
    assert.deepEqual(JSON.parse(String(detail.init?.body)), { feed_id: note, xsec_token: 'note-access-token', load_all_comments: false });
    assert.equal(new Headers(detail.init?.headers).get('authorization'), 'Bearer private-token');
    assert.equal(h.store.actions().length, 1); assert.equal(h.store.actions()[0]?.kind, 'plugin:xiaohongshu:favorite'); assert.equal(transport.state.favorite, true);
    const before = transport.requests.length;
    await assert.rejects(h.run('xhs_browse', { page: 2 }), /one result batch/);
    assert.equal(transport.requests.length, before);
    assert.throws(() => xiaohongshuReference(`https://evil.example/explore/${note}`));
    transport.state.failedDetail = true;
    await assert.rejects(h.run('xhs_read', { input: note }), error => !String(error).includes('private-token') && /read failed/.test(String(error)));
    assert.equal((await h.run('xhs_history', { savedOnly: true })).items[0].sourceId, read.sourceId, 'failed reads do not advance history');
    transport.state.failedDetail = false; transport.state.differentNote = true;
    await assert.rejects(h.run('xhs_read', { input: note }), /different note/);
  } finally { h.store.close(); }
});

test('missing Xiaohongshu login and missing access tokens are actionable failures, not empty successful browsing', async t => {
  fastClock(t); const transport = xhsTransport(); transport.state.loggedIn = false;
  const h = await harness(t, 'xiaohongshu', transport.fetcher);
  try {
    await assert.rejects(h.run('xhs_read', { input: note }), /access token/); assert.equal(transport.requests.length, 0);
    await assert.rejects(h.run('xhs_browse'), /not logged in/);
    assert.equal(transport.requests.length, 1); assert.equal((await h.run('xhs_history')).items.length, 0);
    transport.state.loggedIn = true;
    const read = await h.run('xhs_read', { input: `https://www.xiaohongshu.com/explore/${note}?xsec_token=from-link` });
    assert.equal(read.result.title, 'Cloud painting');
  } finally { h.store.close(); }
});

test('rate limits and cooldown survive new clients; aborted requests, redirects and oversized responses do not become readings', async () => {
  const store = new Store(':memory:'); let calls = 0;
  const options = { ...networkDefaults, requestGapMs: 0, requestsPerDay: 1 };
  const transport = (async () => { calls++; return json({ ok: true }); }) as typeof fetch;
  try {
    const client = new PlatformNetwork('bilibili', storage(store, 'bilibili'), options, transport);
    await assert.rejects(client.json('https://api.bilibili.com/test', {}, AbortSignal.abort())); assert.equal(calls, 0);
    await client.json('https://api.bilibili.com/test');
    await assert.rejects(new PlatformNetwork('bilibili', storage(store, 'bilibili'), options, transport).json('https://api.bilibili.com/test'), /budget exhausted/); assert.equal(calls, 1);
    const blocked = new PlatformNetwork('xiaohongshu', storage(store, 'xiaohongshu'), { ...options, requestsPerDay: 10 }, (async () => json({}, 429)) as typeof fetch);
    await assert.rejects(blocked.json('http://127.0.0.1:18060/api/v1/feeds/list'), /HTTP 429/);
    await assert.rejects(new PlatformNetwork('xiaohongshu', storage(store, 'xiaohongshu'), options, transport).json('http://127.0.0.1:18060/api/v1/feeds/list'), /cooling down/);
    store.setSetting('plugin:bilibili:requests', { day: '', count: 0, at: 0 });
    const redirect = new PlatformNetwork('bilibili', storage(store, 'bilibili'), { ...options, requestsPerDay: 10 }, (async (_url, init) => { assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'https://evil.example' } }); }) as typeof fetch);
    await assert.rejects(redirect.json('https://api.bilibili.com/test'), /HTTP 302/);
    const large = new PlatformNetwork('bilibili', storage(store, 'bilibili'), { ...options, requestsPerDay: 10 }, (async () => new Response('a'.repeat(4_000_001))) as typeof fetch);
    await assert.rejects(large.json('https://api.bilibili.com/test'), /size limit/);
  } finally { store.close(); }
});

test('kept items survive history eviction, local notes are not evidence, and list pagination is bounded', () => {
  const store = new Store(':memory:'), history = new ReadingHistory(storage(store, 'bilibili'));
  try {
    history.discover([{ id: 'kept', title: 'Keep this', url: 'https://example.com/keep', author: 'A' }]); history.keep('kept', true, 'My intention');
    history.discover(Array.from({ length: 240 }, (_, i) => ({ id: String(i), title: `Video ${i}`, url: `https://example.com/${i}`, author: 'B' })));
    assert.equal(history.list(false, 0).items.length, 20); assert.equal(history.list(false, 0).nextOffset, 20);
    assert.equal(history.list(true, 0).items[0]?.note, 'My intention'); assert.equal(history.list(true, 0).items[0]?.sourceId, undefined);
    assert.equal(history.get('kept')?.readAt, undefined); assert.throws(() => history.keep('invented', true), /before keeping/);
  } finally { store.close(); }
});

test('platform tools are opt-in, join the same life wake, share pause rules, and only history is available to review', async t => {
  fastClock(t); const transport = biliTransport();
  const f = fixture();
  const plugin = await loadedPlugin(t, 'bilibili', f.cfg, f.store, transport.fetcher);
  f.plugins.install([...f.plugins.installed(), plugin]); f.restart();
  try {
    assert.deepEqual(f.reviewTools.current().filter(tool => tool.name.startsWith('bili_')).map(tool => tool.name), ['bili_history']);
    f.store.setSetting('lifeEnabled', true); f.store.schedule('Some free time', 'life', Date.now() - 1000); f.store.enqueueDue();
    f.faux.setResponses([context => { assert.match(JSON.stringify(context), /Browse Bilibili/); return answer(call('bili_browse', { query: 'cloud drawing' })); }, answer(call('bili_read', { input: video })), answer('')]);
    await f.brain.run(f.store.claim(20)!);
    const source = f.store.recent(50).find(item => item.kind === 'plugin:bilibili:reading')!;
    assert.ok(source); assert.equal(f.sent.length, 0, 'browsing does not automatically share');
    await f.tools.current().find(tool => tool.name === 'remember')!.execute('memory', { kind: 'experience', title: 'Cloud drawing tutorial', content: 'I read the first 80 subtitle lines of the cloud drawing tutorial.', importance: 5, sources: [source.id] });
    await f.tools.current().find(tool => tool.name === 'update_pursuit')!.execute('pursuit', { title: 'Learn cloud drawing', progress: 'Continue the tutorial from subtitle 80 tomorrow.', fictional: false });
    f.restart();
    assert.equal(f.store.pursuits()[0]?.fictional, false); assert.ok(f.store.search('Cloud drawing tutorial', 5).length);
    f.store.schedule('Continue my reading', 'life', Date.now() - 1000); f.store.enqueueDue();
    f.faux.setResponses([context => { const text = JSON.stringify(context); assert.match(text, /Continue the tutorial from subtitle 80/); assert.ok(text.includes(new Date(source.at).toISOString()), 'the life wake knows when browsing last happened'); return answer(''); }]);
    await f.brain.run(f.store.claim(20)!);
    const held = f.tools.current().find(tool => tool.name === 'bili_browse')!;
    f.store.setSetting('paused', true); await assert.rejects(held.execute('paused', {}), /paused/);
    f.store.setSetting('paused', false);
    f.plugins.install(f.plugins.installed().filter(item => item !== plugin));
    assert.ok(!f.tools.current().some(tool => tool.name === 'bili_browse')); await assert.rejects(held.execute('old', {}), /reloaded/);
  } finally { f.store.close(); }
  const cfg = config(), store = new Store(':memory:');
  try { assert.ok(!createPlugins(cfg, store, { execute: async () => ({}) }).enabledIds().some(id => ['bilibili', 'xiaohongshu'].includes(id))); }
  finally { store.close(); }
});


test('Xiaohongshu image delivery preserves text on failure, enforces the host limit, and sends no credentials to image hosts', async t => {
  fastClock(t); const transport = xhsTransport(), h = await harness(t, 'xiaohongshu', transport.fetcher);
  try {
    transport.state.images = ['https://sns-webpic-qc.xhscdn.com/cloud.jpg', 'https://sns-webpic-qc.xhscdn.com/failed.jpg', 'https://sns-webpic-qc.xhscdn.com/omitted.jpg'];
    h.cfg.limits.maxImages = 2;
    await h.run('xhs_browse');
    const raw = await h.raw('xhs_read', { input: note });
    const read = JSON.parse((raw.content[0] as { text: string }).text);
    assert.equal(read.result.description, 'My watercolor method');
    assert.deepEqual(read.imageDelivery.attached, transport.state.images.slice(0, 1));
    assert.deepEqual(read.imageDelivery.failed.map((x: any) => x.url), transport.state.images.slice(1, 2));
    assert.deepEqual(read.imageDelivery.omitted, transport.state.images.slice(2));
    const images = raw.content.filter(item => item.type === 'image');
    assert.equal(images.length, 1); assert.equal(images[0]!.mimeType, 'image/png'); assert.ok(images[0]!.data.length > 10);
    assert.equal(h.imageRequests.length, 2);
    for (const request of h.imageRequests) { assert.equal(request.authorization, undefined); assert.equal(request.cookie, undefined); }
    assert.ok(!JSON.stringify(h.store.event(read.sourceId)).includes(images[0]!.data), 'image bytes do not enter the persisted experience');
    h.cfg.limits.maxImages = 0;
    const none = await h.run('xhs_read', { input: note });
    assert.equal(none.imageDelivery.attached.length, 0); assert.equal(none.imageDelivery.omitted.length, 3); assert.equal(h.imageRequests.length, 2);
  } finally { h.store.close(); }
});

test('the primary brain sees Xiaohongshu text and images in the response immediately after xhs_read', async t => {
  fastClock(t); await imageTransport(t); const transport = xhsTransport(), f = fixture();
  const plugin = await loadedPlugin(t, 'xiaohongshu', f.cfg, f.store, transport.fetcher);
  f.plugins.install([...f.plugins.installed(), plugin]); f.restart();
  try {
    event(f.store);
    let calls = 0;
    f.faux.setResponses([
      () => { calls++; return answer(call('xhs_read', { input: `https://www.xiaohongshu.com/explore/${note}?xsec_token=note-access-token` })); },
      context => {
        calls++;
        const result = context.messages.findLast(message => message.role === 'toolResult');
        assert.ok(result && result.role === 'toolResult'); assert.equal(result.toolName, 'xhs_read');
        assert.ok(result.content.some(item => item.type === 'image'));
        assert.ok(result.content.some(item => item.type === 'text' && item.text.includes('My watercolor method')));
        return answer('');
      },
    ]);
    await f.brain.run(f.store.claim(20)!);
    assert.equal(calls, 2, 'one model call selects the read, the next receives both text and pictures');
    assert.equal(f.sent.length, 0);
  } finally { f.store.close(); }
});

test('Xiaohongshu native favorite and unfavorite use account actions; lost receipts preserve local state and are not replayed', async t => {
  const advance = fastClock(t); const transport = xhsTransport(), h = await harness(t, 'xiaohongshu', transport.fetcher);
  try {
    await h.run('xhs_browse');
    const saved = await h.run('xhs_keep', { id: note, saved: true, note: 'Colors' });
    assert.equal(saved.confirmed, true); assert.equal(saved.localUpdated, true);
    assert.deepEqual(JSON.parse(String(transport.requests.find(r => r.url.pathname.endsWith('/favorite'))!.init?.body)), { feed_id: note, xsec_token: 'note-access-token', unfavorite: false });
    transport.state.loseFavoriteResponse = true;
    const lost = await h.run('xhs_keep', { id: note, saved: false });
    assert.equal(lost.action.outcome.status, 'unknown'); assert.equal(lost.localUpdated, false); assert.equal(transport.state.favorite, false);
    const history = (await h.run('xhs_history')).items[0];
    assert.equal('saved' in history, false); assert.equal(history.platformFavorite.saved, true);
    await h.run('xhs_keep', { id: note, saved: false });
    assert.equal(transport.requests.filter(r => r.url.pathname.endsWith('/favorite')).length, 2, 'unknown dispatch is not replayed');
    assert.ok(!JSON.stringify(h.store.actions()).includes('private-token'));
    assert.ok(!JSON.stringify(h.store.actions()).includes('note-access-token'));
    transport.state.loggedIn = false; advance(60_000);
    await assert.rejects(h.run('xhs_keep', { id: note, saved: true }), /logged in/i);
    assert.equal(h.store.actions().length, 2);
  } finally { h.store.close(); }
});

test('Bilibili favorites affect only the selected account folder, verify remote state and reconcile a lost receipt without another write', async t => {
  fastClock(t); const transport = biliTransport(), h = await harness(t, 'bilibili', transport.fetcher);
  try {
    await h.run('bili_browse');
    transport.state.loseFavoriteResponse = true;
    const lost = await h.run('bili_keep', { id: video, saved: true });
    assert.equal(lost.confirmed, false); assert.equal(lost.localUpdated, false); assert.equal(lost.action.outcome.status, 'unknown');
    assert.equal((await h.run('bili_history')).items[0].platformFavorite, undefined);
    transport.state.loseFavoriteResponse = false;
    const reconciled = await h.run('bili_keep', { id: video, saved: true });
    assert.equal(reconciled.confirmed, true); assert.equal(reconciled.unchanged, true);
    assert.equal((await h.run('bili_history')).items[0].platformFavorite.collectionId, 123);
    await h.run('bili_keep', { id: video, saved: false });
    const requests = transport.requests.filter(r => r.url.pathname.endsWith('/resource/deal'));
    assert.equal(requests.length, 2);
    const save = new URLSearchParams(String(requests[0]!.init?.body)), remove = new URLSearchParams(String(requests[1]!.init?.body));
    assert.equal(save.get('csrf'), 'private-csrf'); assert.equal(save.get('rid'), '42'); assert.equal(save.get('type'), '2');
    assert.equal(save.get('add_media_ids'), '123'); assert.equal(save.get('del_media_ids'), '');
    assert.equal(remove.get('add_media_ids'), ''); assert.equal(remove.get('del_media_ids'), '123');
    assert.equal(transport.state.favorite, false); assert.equal((await h.run('bili_history')).items[0].platformFavorite.saved, false);
    assert.ok(!JSON.stringify(h.store.actions()).includes('private-csrf')); assert.ok(!JSON.stringify(h.store.actions()).includes('private-session'));
  } finally { h.store.close(); }
});

test('Bilibili requires login and an unambiguous folder, and an unverified write never becomes a local favorite', async t => {
  fastClock(t);
  for (const scenario of ['missing-cookie', 'logged-out', 'no-default', 'configured-folder', 'unverified']) {
    const transport = biliTransport(); transport.state.loggedIn = scenario !== 'logged-out'; transport.state.defaultFolder = scenario !== 'no-default' && scenario !== 'configured-folder'; transport.state.failFavoriteConfirmation = scenario === 'unverified';
    const h = await harness(t, 'bilibili', transport.fetcher, undefined, scenario === 'configured-folder' ? { favoriteFolderId: 123 } : {}, scenario === 'missing-cookie' ? '' : undefined);
    try {
      await h.run('bili_browse');
      if (scenario === 'unverified') {
        const result = await h.run('bili_keep', { id: video, saved: true });
        assert.equal(result.action.outcome.status, 'unknown'); assert.equal(result.localUpdated, false);
        assert.equal((await h.run('bili_history')).items[0].platformFavorite, undefined);
      } else if (scenario === 'configured-folder') {
        const result = await h.run('bili_keep', { id: video, saved: true }); assert.equal(result.confirmed, true); assert.equal(result.collectionId, 123);
      } else {
        await assert.rejects(h.run('bili_keep', { id: video, saved: true }), /Cookie|login|favoriteFolderId/);
        assert.equal(h.store.actions().length, 0); assert.ok(!transport.requests.some(r => r.url.pathname.endsWith('/resource/deal')));
      }
    } finally { h.store.close(); }
  }
});

for (const platform of ['bilibili', 'xiaohongshu'] as const) {
  const prefix = platform === 'bilibili' ? 'bili' : 'xhs', id = platform === 'bilibili' ? video : note;
  const transportFor = () => platform === 'bilibili' ? biliTransport() : xhsTransport();
  const likeWrites = (transport: ReturnType<typeof transportFor>) => transport.requests.filter(r => r.url.pathname.endsWith('/like'));

  test(`${platform} likes and unlikes use explicit native state, persist across restart and remain separate from favorites`, async t => {
    fastClock(t); const transport = transportFor(), dir = mkdtempSync(join(tmpdir(), 'qiuyue-likes-'));
    let h = await harness(t, platform, transport.fetcher, new Store(join(dir, 'life.sqlite')));
    try {
      await assert.rejects(h.run(`${prefix}_like`, { id, liked: true }), /Read or discover/);
      assert.equal(transport.requests.length, 0);
      await h.run(`${prefix}_browse`);
      const liked = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(liked.confirmed, true); assert.equal(liked.localUpdated, true); assert.equal(transport.state.liked, true);
      assert.equal(h.store.actions()[0]?.kind, `plugin:${platform}:like`);
      const repeated = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(repeated.unchanged, true); assert.equal(likeWrites(transport).length, 1);
      assert.equal((await h.run(`${prefix}_history`, { savedOnly: true })).items.length, 0, 'a like is not a favorite');
      h.store.close(); h = await harness(t, platform, transport.fetcher, new Store(join(dir, 'life.sqlite')));
      const cached = (await h.run(`${prefix}_history`)).items[0];
      assert.equal(cached.platformLike.liked, true); assert.ok(cached.platformLike.checkedAt > 0);
      assert.equal(cached.platformFavorite, undefined); assert.equal(cached.readAt, undefined, 'liking is not reading');
      await h.run(`${prefix}_keep`, { id, saved: true });
      assert.equal((await h.run(`${prefix}_history`)).items[0].platformLike.liked, true);
      const unliked = await h.run(`${prefix}_like`, { id, liked: false });
      assert.equal(unliked.confirmed, true); assert.equal(transport.state.liked, false);
      const history = (await h.run(`${prefix}_history`)).items[0];
      assert.equal(history.platformLike.liked, false); assert.equal(history.platformFavorite.saved, true);
      const writes = likeWrites(transport); assert.equal(writes.length, 2);
      for (const [index, request] of writes.entries()) {
        assert.equal(request.init?.method, 'POST'); assert.equal(request.init?.redirect, 'manual');
        if (platform === 'bilibili') {
          const form = new URLSearchParams(String(request.init?.body));
          assert.equal(request.url.hostname, 'api.bilibili.com');
          assert.equal(form.get('aid'), '42'); assert.equal(form.get('like'), index === 0 ? '1' : '2'); assert.equal(form.get('csrf'), 'private-csrf');
          assert.match(new Headers(request.init?.headers).get('cookie')!, /SESSDATA=private-session/);
        } else {
          assert.deepEqual(JSON.parse(String(request.init?.body)), { feed_id: note, xsec_token: 'note-access-token', unlike: index === 1 });
          assert.equal(new Headers(request.init?.headers).get('authorization'), 'Bearer private-token');
        }
      }
      const publicData = JSON.stringify([h.store.actions(), await h.run(`${prefix}_history`)]);
      for (const secret of ['private-session', 'private-csrf', 'private-token', 'note-access-token']) assert.ok(!publicData.includes(secret));
    } finally { h.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${platform} lost like receipts survive restart, reconcile by reading and never blindly repeat a write`, async t => {
    fastClock(t); const transport = transportFor(), dir = mkdtempSync(join(tmpdir(), 'qiuyue-lost-like-'));
    let h = await harness(t, platform, transport.fetcher, new Store(join(dir, 'life.sqlite')));
    try {
      await h.run(`${prefix}_browse`); transport.state.loseLikeResponse = true;
      const lost = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(lost.action.outcome.status, 'unknown'); assert.equal(lost.localUpdated, false); assert.equal(transport.state.liked, true);
      assert.equal((await h.run(`${prefix}_history`)).items[0].platformLike, undefined);
      h.store.close(); h = await harness(t, platform, transport.fetcher, new Store(join(dir, 'life.sqlite')));
      transport.state.loseLikeResponse = false;
      const reconciled = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(reconciled.confirmed, true); assert.equal(reconciled.unchanged, true); assert.equal(likeWrites(transport).length, 1);
      transport.state.liked = false; // A later change cannot make the old unknown attempt safe to repeat.
      const blocked = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(blocked.action.reused, true); assert.equal(blocked.action.outcome.status, 'unknown'); assert.equal(blocked.localUpdated, false);
      assert.equal(likeWrites(transport).length, 1);
    } finally { h.store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${platform} malformed like state blocks dispatch and an unverified write preserves the last confirmed local state`, async t => {
    fastClock(t); const transport = transportFor(), h = await harness(t, platform, transport.fetcher);
    try {
      await h.run(`${prefix}_browse`);
      await h.run(`${prefix}_like`, { id, liked: false });
      transport.state.invalidLikeState = true;
      await assert.rejects(h.run(`${prefix}_like`, { id, liked: true }), /invalid.*like state/);
      assert.equal(likeWrites(transport).length, 0); assert.equal(h.store.actions().length, 0);
      transport.state.invalidLikeState = false; transport.state.failLikeConfirmation = true;
      const result = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(result.action.outcome.status, 'unknown'); assert.equal(result.localUpdated, false);
      assert.equal((await h.run(`${prefix}_history`)).items[0].platformLike.liked, false);
      await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(likeWrites(transport).length, 1);
    } finally { h.store.close(); }
  });

  test(`${platform} like actions respect login, pause and the shared action budget`, async t => {
    const advance = fastClock(t); const transport = transportFor(), h = await harness(t, platform, transport.fetcher);
    try {
      await h.run(`${prefix}_browse`);
      transport.state.loggedIn = false; advance(60_000);
      await assert.rejects(h.run(`${prefix}_like`, { id, liked: true }), /login|logged in/i);
      transport.state.loggedIn = true;
      h.store.setSetting('paused', true);
      const before = transport.requests.length;
      await assert.rejects(h.run(`${prefix}_like`, { id, liked: true }), /paused/);
      assert.equal(transport.requests.length, before); h.store.setSetting('paused', false);
      h.cfg.limits.actionsPerHour = 0;
      await assert.rejects(h.run(`${prefix}_like`, { id, liked: true }), /rate limit/);
      assert.equal(likeWrites(transport).length, 0); assert.equal(h.store.actions().length, 0);
    } finally { h.store.close(); }
  });

  test(`${platform} a reused success receipt cannot confirm a like that was subsequently removed`, async t => {
    fastClock(t); const transport = transportFor(), h = await harness(t, platform, transport.fetcher);
    try {
      await h.run(`${prefix}_browse`); h.thought.triggers.add(event(h.store).id);
      await h.run(`${prefix}_like`, { id, liked: true });
      await h.run(`${prefix}_like`, { id, liked: false });
      const result = await h.run(`${prefix}_like`, { id, liked: true });
      assert.equal(result.action.reused, true); assert.equal(result.action.outcome.status, 'success');
      assert.equal(result.confirmed, false); assert.equal(result.localUpdated, false); assert.equal(likeWrites(transport).length, 2);
      assert.equal((await h.run(`${prefix}_history`)).items[0].platformLike.liked, false);
    } finally { h.store.close(); }
  });
}

test('Bilibili likes require both login cookies and cool down after a risk-control response', async t => {
  fastClock(t);
  for (const credential of ['', 'SESSDATA=private-session', 'bili_jct=private-csrf']) {
    const transport = biliTransport(), h = await harness(t, 'bilibili', transport.fetcher, undefined, {}, credential);
    try {
      await h.run('bili_browse');
      await assert.rejects(h.run('bili_like', { id: video, liked: true }), /Cookie/);
      assert.equal(h.store.actions().length, 0);
    } finally { h.store.close(); }
  }
  const transport = biliTransport(), h = await harness(t, 'bilibili', transport.fetcher);
  try {
    await h.run('bili_browse'); transport.state.likeCode = -352;
    const result = await h.run('bili_like', { id: video, liked: true });
    assert.equal(result.action.outcome.status, 'unknown'); assert.equal(result.localUpdated, false);
    const before = transport.requests.length;
    await assert.rejects(h.run('bili_like', { id: video, liked: true }), /cooling down/);
    assert.equal(transport.requests.length, before);
  } finally { h.store.close(); }
});

test('Xiaohongshu likes require a private locator and validate both note identity and the action receipt', async t => {
  fastClock(t); const transport = xhsTransport(), h = await harness(t, 'xiaohongshu', transport.fetcher);
  try {
    new ReadingHistory(storage(h.store, 'xiaohongshu')).discover([{ id: note, title: 'Note', url: `https://www.xiaohongshu.com/explore/${note}`, author: 'A' }]);
    await assert.rejects(h.run('xhs_like', { id: note, liked: true }), /access token/);
    assert.equal(transport.requests.length, 0);
    await h.run('xhs_browse'); transport.state.differentNote = true;
    await assert.rejects(h.run('xhs_like', { id: note, liked: true }), /different note/);
    assert.equal(h.store.actions().length, 0);
    transport.state.differentNote = false; transport.state.wrongLikeReceipt = true;
    const result = await h.run('xhs_like', { id: note, liked: true });
    assert.equal(result.action.outcome.status, 'unknown'); assert.equal(result.localUpdated, false);
    assert.equal((await h.run('xhs_history')).items[0].platformLike, undefined);
  } finally { h.store.close(); }
});
