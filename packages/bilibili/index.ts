import { createHash } from 'node:crypto';
import type { PluginContext, PluginDefinition, PluginCall } from '../../src/plugin-sdk.js';
import metadata from './plugin.json' with { type: 'json' };
import { registerOnlineReading, PlatformNetwork, ReadingHistory, type PluginStorage, type NetworkSettings, type OnlineReader, type ReadingEntry, type ReadingItem } from '../online-reading/index.js';
const api = 'https://api.bilibili.com';
const agent = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Bilibili's WBI permutation, also documented by Aurabot's src/bili/api.js.
const permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function signBilibili(parameters: Record<string, string | number>, img: string, sub: string, now = Date.now()) {
  const secret = permutation.map(index => (img + sub)[index]).join('').slice(0, 32);
  const values = { ...parameters, wts: Math.floor(now / 1000) };
  const query = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value).replace(/[!'()*]/g, ''))}`).join('&');
  return `${query}&w_rid=${createHash('md5').update(query + secret).digest('hex')}`;
}
const text = (value: unknown, max = 1000) => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, max);
const imageUrl = (value: unknown) => typeof value === 'string' ? value.startsWith('//') ? `https:${value}` : value : undefined;
export function bilibiliReference(input: string): { bvid?: string; aid?: string; part?: number; short?: string } {
  if (/^BV[0-9A-Za-z]{10}$/.test(input)) return { bvid: input };
  if (/^av\d+$/i.test(input)) return { aid: input.slice(2) };
  let url: URL; try { url = new URL(input); } catch { throw new Error('Use a BV/av ID or a Bilibili video URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Invalid Bilibili URL.');
  if (url.hostname === 'b23.tv' && /^\/[\da-z]+\/?$/i.test(url.pathname)) return { short: `https://b23.tv${url.pathname}` };
  if (!['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname)) throw new Error('Use a Bilibili video URL.');
  const match = /^\/video\/(BV[0-9A-Za-z]{10}|av\d+)\/?$/i.exec(url.pathname);
  if (!match) throw new Error('Only Bilibili video links are supported.');
  const part = url.searchParams.has('p') ? Number(url.searchParams.get('p')) : undefined;
  if (part !== undefined && (!Number.isSafeInteger(part) || part < 1)) throw new Error('Invalid video part.');
  return { ...(match[1]!.startsWith('BV') ? { bvid: match[1]! } : { aid: match[1]!.slice(2) }), part };
}

export class BilibiliReader implements OnlineReader {
  private signing?: { img: string; sub: string; at: number };
  private buvid?: string;
  private history: ReadingHistory;
  constructor(private network: PlatformNetwork, storage: PluginStorage, private cookie: () => string | undefined, private favoriteFolderId = 0) { this.history = new ReadingHistory(storage); }
  private headers() {
    // Do not send unrelated browser cookies, or credentials to subtitle/short-link hosts.
    const cookies = (this.cookie() ?? '').split(';').map(part => part.trim()).filter(part => /^(SESSDATA|bili_jct|DedeUserID|buvid3|buvid4|DedeUserID__ckMd5|sid)=/.test(part));
    if (this.buvid && !cookies.some(part => part.startsWith('buvid3='))) cookies.push(`buvid3=${this.buvid}`);
    return { 'User-Agent': agent, Referer: 'https://www.bilibili.com/', Cookie: cookies.join('; ') };
  }
  private async request(path: string, signal?: AbortSignal, allowGuest = false) {
    const result = await this.network.json(api + path, { headers: this.headers() }, signal);
    if ([-352, -412, -509].includes(result.code)) this.network.coolDown();
    if (result.code !== 0 && !(allowGuest && result.code === -101 && result.data?.wbi_img)) throw new Error(`Bilibili code ${Number(result.code)}${result.code === -101 ? ': login required; configure BILIBILI_COOKIE' : ''}.`);
    if (!result.data || typeof result.data !== 'object') throw new Error('Bilibili returned invalid data.');
    return result.data;
  }
  private async signed(path: string, parameters: Record<string, string | number>, signal?: AbortSignal) {
    if (!this.buvid && !/(^|;\s*)buvid3=/.test(this.cookie() ?? '')) {
      const data = await this.request('/x/frontend/finger/spi', signal);
      if (typeof data.b_3 !== 'string' || !/^[\w-]+$/.test(data.b_3)) throw new Error('Bilibili guest identifier unavailable.');
      this.buvid = data.b_3;
    }
    if (!this.signing || Date.now() - this.signing.at > 3_600_000) {
      const data = await this.request('/x/web-interface/nav', signal, true);
      const key = (url: unknown) => typeof url === 'string' ? /\/([a-f\d]{32})\./i.exec(url)?.[1] : undefined;
      const img = key(data.wbi_img?.img_url), sub = key(data.wbi_img?.sub_url);
      if (!img || !sub) throw new Error('Bilibili signing keys unavailable.');
      this.signing = { img, sub, at: Date.now() };
    }
    return this.request(`${path}?${signBilibili(parameters, this.signing.img, this.signing.sub)}`, signal);
  }
  private item(value: any): ReadingItem {
    if (!/^BV[0-9A-Za-z]{10}$/.test(value.bvid)) throw new Error('Bilibili returned an invalid video ID.');
    return { id: value.bvid, title: text(value.title, 300), url: `https://www.bilibili.com/video/${value.bvid}`, author: text(value.owner?.name ?? value.author, 100), description: text(value.desc ?? value.description, 1500), cover: imageUrl(value.pic) };
  }
  async browse(query: string | undefined, page: number, signal?: AbortSignal) {
    if (query !== undefined && !query.trim()) throw new Error('A search query must not be blank.');
    const data = query
      ? await this.signed('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: query, page, page_size: 10 }, signal)
      : await this.request(`/x/web-interface/popular?ps=10&pn=${page}`, signal);
    const list = query ? data.result : data.list;
    if (!Array.isArray(list)) throw new Error('Bilibili returned an invalid video list.');
    // Video search also includes paid-course cards (type=ketang), which have no BV ID.
    const videos = list.filter((value: any) => !value.type || value.type === 'video');
    return { items: videos.slice(0, 10).map(value => this.item(value)), more: query ? page < Number(data.numPages) : !data.no_more && list.length >= 10, mode: query ? 'search' : 'popular (not personalized recommendations)' };
  }
  async favorite(item: ReadingEntry, saved: boolean, call: PluginCall) {
    const cookies = Object.fromEntries((this.cookie() ?? '').split(';').map(part => {
      const at = part.indexOf('='); return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }));
    if (!cookies.SESSDATA || !cookies.bili_jct) throw new Error('Bilibili native favorites require a logged-in Cookie containing SESSDATA and bili_jct. Configure the plugin Cookie credential first.');
    const user = await this.request('/x/web-interface/nav', call.signal);
    if (user.isLogin !== true || !Number.isSafeInteger(user.mid) || user.mid <= 0) throw new Error('Bilibili login is unavailable; refresh the configured Cookie.');
    const video = await this.signed('/x/web-interface/wbi/view', { bvid: item.id }, call.signal);
    if (video.bvid !== item.id || !Number.isSafeInteger(video.aid) || video.aid <= 0) throw new Error('Bilibili returned a different or invalid video.');
    const path = `/x/v3/fav/folder/created/list-all?up_mid=${user.mid}&type=2&rid=${video.aid}`;
    const folderFor = (data: any) => {
      if (!Array.isArray(data.list)) throw new Error('Bilibili favorite folders unavailable.');
      const matches = data.list.filter((folder: any) => this.favoriteFolderId ? folder.id === this.favoriteFolderId : folder.title === '默认收藏夹');
      const folder = matches.length === 1 ? matches[0] : undefined;
      if (!folder || !Number.isSafeInteger(folder.id) || folder.id <= 0 || folder.mid !== user.mid || ![0, 1].includes(folder.fav_state)) throw new Error('Configure favoriteFolderId to one of this account’s favorite folders; no unambiguous default folder was found.');
      return folder;
    };
    const folder = folderFor(await this.request(path, call.signal));
    if (Boolean(folder.fav_state) === saved) return { confirmed: true, saved, collectionId: folder.id, unchanged: true };
    const action = await call.action('favorite', { id: item.id, saved, collectionId: folder.id }, async signal => {
      const body = new URLSearchParams({ rid: String(video.aid), type: '2', add_media_ids: saved ? String(folder.id) : '', del_media_ids: saved ? '' : String(folder.id), csrf: cookies.bili_jct!, platform: 'web' });
      const result = await this.network.json(api + '/x/v3/fav/resource/deal', { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal);
      if ([-352, -412, -509].includes(result.code)) this.network.coolDown();
      if (result.code !== 0) throw new Error(`Bilibili favorite request failed with code ${Number(result.code)}.`);
      const confirmed = folderFor(await this.request(path, signal));
      if (confirmed.id !== folder.id || Boolean(confirmed.fav_state) !== saved) throw new Error('Bilibili favorite state could not be confirmed after dispatch.');
      return { id: item.id, saved, collectionId: folder.id, platform: 'bilibili' };
    });
    return { confirmed: action.outcome.status === 'success', saved, collectionId: folder.id, action };
  }
  async read(input: string, previous: ReadingEntry | undefined, restart: boolean, signal?: AbortSignal) {
    let reference = bilibiliReference(input);
    if (reference.short) {
      const response = await this.network.request(reference.short, { headers: { 'User-Agent': agent } }, signal, true);
      const location = response.headers.get('location');
      if (!location) throw new Error('Bilibili short link did not resolve to a video.');
      reference = bilibiliReference(new URL(location, reference.short).href);
      if (reference.short) throw new Error('Bilibili short link did not resolve to a video.');
    }
    const data = await this.signed('/x/web-interface/wbi/view', reference.bvid ? { bvid: reference.bvid } : { aid: reference.aid! }, signal);
    const item = this.item(data);
    previous ??= this.history.get(item.id);
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const part = reference.part ?? (restart ? undefined : previous?.cursor?.part) ?? 1;
    const page = pages.find((page: any) => page.page === part);
    if (!page || !Number.isSafeInteger(page.cid) || !Number.isSafeInteger(data.aid)) throw new Error('The requested video part is unavailable.');
    const warnings: string[] = [];
    const optional = async <T>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
      try { return await work(); } catch (error) { signal?.throwIfAborted(); warnings.push(`${label}: ${error instanceof Error ? error.message : 'unavailable'}`); return undefined; }
    };
    const subtitles = await optional('subtitles', async () => {
      const player = await this.signed('/x/player/wbi/v2', { bvid: item.id, cid: page.cid }, signal);
      if (player.need_login_subtitle === true) throw new Error('Subtitle access requires login.');
      const list = player.subtitle?.subtitles;
      if (!Array.isArray(list) || !list.length) return { status: 'not_available', lines: [], total: 0, language: null };
      const selected = list.find((entry: any) => /^zh/.test(entry.lan)) ?? list[0];
      const url = new URL(imageUrl(selected.subtitle_url) ?? '');
      if (url.protocol !== 'https:' || !/(^|\.)hdslb\.com$/.test(url.hostname) || url.username || url.password || url.port) throw new Error('Unexpected subtitle host.');
      const body = await this.network.json(url.href, { headers: { 'User-Agent': agent } }, signal);
      if (!Array.isArray(body.body)) throw new Error('Invalid subtitle data.');
      const offset = !restart && previous?.cursor?.part === part ? previous.cursor.subtitleOffset ?? 0 : 0;
      let length = 0;
      const lines: { from: number; to: number; text: string }[] = [];
      for (const entry of body.body.slice(offset, offset + 80)) {
        if (!Number.isFinite(entry.from) || !Number.isFinite(entry.to) || typeof entry.content !== 'string') throw new Error('Invalid subtitle line.');
        // Reject an anomalous overlong line instead of advancing past words never returned.
        if (entry.content.length > 10_000) throw new Error('A subtitle line exceeds the reading limit.');
        const content = entry.content; if (length + content.length > 10_000) break;
        lines.push({ from: entry.from, to: entry.to, text: content }); length += content.length;
      }
      return { status: 'available', language: text(selected.lan_doc ?? selected.lan, 80), offset, lines, total: body.body.length };
    });
    const comments = await optional('comments', async () => {
      const result = await this.signed('/x/v2/reply/wbi/main', { type: 1, oid: data.aid, mode: 3, plat: 1, web_location: 1315875 }, signal);
      if (result.replies !== null && !Array.isArray(result.replies)) throw new Error('Invalid comments data.');
      return (result.replies ?? []).slice(0, 8).map((entry: any) => ({ id: String(entry.rpid_str ?? entry.rpid), author: text(entry.member?.uname, 100), text: text(entry.content?.message, 1000) }));
    });
    const offset = subtitles?.status === 'available' ? (subtitles.offset ?? 0) + subtitles.lines.length : (!restart && previous?.cursor?.part === part ? previous.cursor.subtitleOffset ?? 0 : 0);
    const complete = subtitles?.status === 'available' && subtitles.total > 0 && offset >= subtitles.total;
    const nextPart = complete && part < pages.length ? part + 1 : part;
    return {
      item, cursor: { part: nextPart, subtitleOffset: nextPart === part ? offset : 0 },
      content: {
        perception: 'Video description, available subtitle text and a sample of comments. No video frames or audio were perceived. A cover URL is not a viewed image; use view_event_image with this result sourceId and URL to inspect it.',
        part, partTitle: text(page.part, 300), totalParts: pages.length, durationSeconds: page.duration,
        parts: pages.slice(0, 100).map((entry: any) => ({ part: entry.page, title: text(entry.part, 200), url: `${item.url}?p=${entry.page}` })),
        subtitles: subtitles ?? { status: 'unavailable' }, comments: comments ?? null, commentsAreSample: true, warnings,
        partReadingComplete: complete, reachedLastPart: part === pages.length,
      },
    };
  }
}

export function setup(ctx: PluginContext) {
  const options = ctx.settings as NetworkSettings & { cookieEnv: string; favoriteFolderId: number };
  const reader = new BilibiliReader(new PlatformNetwork(ctx.id, ctx.storage, options), ctx.storage, () => ctx.credential(options.cookieEnv), options.favoriteFolderId);
  registerOnlineReading(ctx, 'bili', reader, {
    browse: 'Find Bilibili videos by your own query, or omit query to browse popular videos. Popular is not a personalized feed.',
    read: 'Read a Bilibili BV/av ID, video URL or b23.tv link: description, one chunk of subtitles and a sample of comments. This does not play or listen to the video. Cover images can be inspected with view_event_image using the returned sourceId and cover URL.',
    activity: 'Browse Bilibili for something that interests you, or continue something kept in bili_history; you may stop or keep it to yourself',
  });
}

export default { ...metadata, apiVersion: 2, setup } satisfies PluginDefinition;
