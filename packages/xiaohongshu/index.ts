import type { PluginContext, PluginDefinition, PluginCall } from '../../src/plugin-sdk.js';
import metadata from './plugin.json' with { type: 'json' };
import { registerOnlineReading, PlatformNetwork, ReadingHistory, type PluginStorage, type NetworkSettings, type OnlineReader, type ReadingEntry, type ReadingItem } from '../online-reading/index.js';
const text = (value: unknown, max = 1000) => String(value ?? '').slice(0, max);
const idPattern = /^[a-f\d]{24}$/i;
function picture(image: any): string | undefined {
  const value = image?.urlDefault || image?.infoList?.find((entry: any) => entry.imageScene === 'WB_DFT')?.url || image?.url || image?.urlPre;
  if (typeof value !== 'string') return;
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch { /* no usable image */ }
}
export function xiaohongshuReference(input: string): { id: string; token?: string } {
  if (idPattern.test(input)) return { id: input };
  let url: URL; try { url = new URL(input); } catch { throw new Error('Use a Xiaohongshu note ID or full note URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('Use a full xiaohongshu.com note URL. Short links are not supported.');
  const match = /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i.exec(url.pathname);
  if (!match) throw new Error('Use a Xiaohongshu note URL.');
  return { id: match[1]!, token: url.searchParams.get('xsec_token') ?? undefined };
}

/** The operator owns this service endpoint; note URLs never determine where credentials are sent. */
export class XiaohongshuReader implements OnlineReader {
  private history: ReadingHistory;
  private loggedInUntil = 0;
  private base: string;
  constructor(private network: PlatformNetwork, storage: PluginStorage, baseUrl: string, private token: () => string | undefined) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('xiaohongshu.baseUrl must be an HTTP/HTTPS service URL without credentials, query or fragment.');
    this.base = url.href.replace(/\/$/, ''); this.history = new ReadingHistory(storage);
  }
  private async request(path: string, signal?: AbortSignal, body?: unknown) {
    const token = this.token();
    const result = await this.network.json(`${this.base}/api/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal);
    if (result.success !== true || !result.data || typeof result.data !== 'object') {
      this.loggedInUntil = 0;
      // Provider details can contain cookies or request URLs. Keep them out of model context and logs.
      throw new Error('Xiaohongshu read failed; check service login and availability. No automatic retry.');
    }
    return result.data;
  }
  private async login(signal?: AbortSignal) {
    if (Date.now() < this.loggedInUntil) return;
    const status = await this.request('login/status', signal);
    if (status.is_logged_in !== true) throw new Error('Xiaohongshu is not logged in. Log into the configured xiaohongshu-mcp service first.');
    this.loggedInUntil = Date.now() + 60_000;
  }
  private item(id: string, note: any, token?: string): ReadingItem {
    if (!idPattern.test(id)) throw new Error('Xiaohongshu returned an invalid note ID.');
    return { id, title: text(note.title ?? note.displayTitle, 300), author: text(note.user?.nickname ?? note.user?.nickName, 100),
      url: `https://www.xiaohongshu.com/explore/${id}`, description: text(note.desc, 2000), cover: picture(note.cover ?? note.imageList?.[0]),
      ...(token ? { locator: { token } } : {}),
    };
  }
  async browse(query: string | undefined, page: number, signal?: AbortSignal) {
    if (page !== 1) throw new Error('This Xiaohongshu service provides one result batch, not paginated feeds. Search for another topic instead.');
    if (query !== undefined && !query.trim()) throw new Error('A search query must not be blank.');
    await this.login(signal);
    const data = await this.request(query ? `feeds/search?keyword=${encodeURIComponent(query)}` : 'feeds/list', signal);
    if (!Array.isArray(data.feeds)) throw new Error('Xiaohongshu returned an invalid feed list.');
    const notes = data.feeds.filter((entry: any) => entry.modelType === 'note' && entry.noteCard);
    return { items: notes.slice(0, 10).map((entry: any) => this.item(entry.id, entry.noteCard, entry.xsecToken)), more: false, mode: query ? 'search sample' : 'recommendation sample' };
  }
  async favorite(item: ReadingEntry, saved: boolean, call: PluginCall) {
    const token = item.locator?.token;
    if (!token) throw new Error('Discover this note again to obtain its current access token before favoriting.');
    await this.login(call.signal);
    const action = await call.action('favorite', { id: item.id, saved }, async signal => {
      const result = await this.request('feeds/favorite', signal, { feed_id: item.id, xsec_token: token, unfavorite: !saved });
      if (result.success !== true || result.feed_id !== item.id) throw new Error('Xiaohongshu did not confirm the requested favorite action.');
      return { id: item.id, saved, platform: 'xiaohongshu' };
    });
    return { confirmed: action.outcome.status === 'success', saved, action };
  }
  async read(input: string, previous: ReadingEntry | undefined, _restart: boolean, signal?: AbortSignal) {
    const reference = xiaohongshuReference(input);
    previous ??= this.history.get(reference.id);
    const token = reference.token || previous?.locator?.token;
    if (!token) throw new Error('This note needs a current access token. Discover it with xhs_browse first, or supply its full URL including xsec_token.');
    await this.login(signal);
    const result = await this.request('feeds/detail', signal, { feed_id: reference.id, xsec_token: token, load_all_comments: false });
    const data = result.data;
    if (!data?.note || data.note.noteId !== reference.id || typeof data.note.desc !== 'string') throw new Error('Xiaohongshu returned an invalid or different note.');
    const images = (Array.isArray(data.note.imageList) ? data.note.imageList : []).map(picture).filter((url: unknown): url is string => typeof url === 'string');
    const comments = Array.isArray(data.comments?.list) ? data.comments.list.slice(0, 8).map((entry: any) => ({
      id: text(entry.id, 100), author: text(entry.userInfo?.nickname, 100), text: text(entry.content, 1000),
      replies: (Array.isArray(entry.subComments) ? entry.subComments : []).slice(0, 2).map((reply: any) => ({ author: text(reply.userInfo?.nickname, 100), text: text(reply.content, 600) })),
    })) : null;
    return { item: this.item(reference.id, data.note, token), imageUrls: images.slice(0, 20), content: {
      perception: 'Note text and a sample of comments, with available images attached in this same tool response. Only URLs listed in imageDelivery.attached were delivered as images; failed or omitted images have not been perceived. Use view_event_image for those only if needed. Videos and Live Photos have not been played or heard.',
      text: text(data.note.desc, 12_000), textTruncated: data.note.desc.length > 12_000,
      noteType: text(data.note.type, 50), images: images.slice(0, 20), totalImages: images.length,
      comments, commentsAreSample: true, commentsHaveMore: data.comments?.hasMore ?? null,
    } };
  }
}

export function setup(ctx: PluginContext) {
  const options = ctx.settings as NetworkSettings & { baseUrl: string; tokenEnv: string };
  const reader = new XiaohongshuReader(new PlatformNetwork(ctx.id, ctx.storage, options), ctx.storage, options.baseUrl, () => ctx.credential(options.tokenEnv));
  registerOnlineReading(ctx, 'xhs', reader, {
    browse: 'Browse Xiaohongshu recommendations or search for a topic. This service returns one bounded batch; only page 1 is supported.',
    read: 'Read a discovered Xiaohongshu note ID or full URL: text, sampled comments and actual images together in one response. imageDelivery identifies attached, failed and omitted images; no extra viewing call is needed for attached images. Reading text is not watching a video.',
    activity: 'Browse Xiaohongshu pictures and notes that interest you, or revisit something kept in xhs_history; you may stop or keep it to yourself',
  });
}

export default { ...metadata, apiVersion: 2, setup } satisfies PluginDefinition;
