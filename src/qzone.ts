import type { SocialAdapter } from './snowluma.js';
import { publicFetch } from './web.js';

/** Posts a JSON body to Qzone's web gateway and returns the response text. */
export type QzonePost = (url: string, body: string, headers: Record<string, string>, signal?: AbortSignal) => Promise<string>;
const post: QzonePost = async (url, body, headers, signal) => (await publicFetch(url, { method: 'POST', body, headers, timeoutMs: 15_000, maxBytes: 5_000_000, signal })).data.toString('utf8');
type Feed = Record<string, any>;

/** Qzone's g_tk: the DJB hash of p_skey (skey for older sessions), which its web services require beside the cookies. */
export function gtk(cookies: string): number {
  const key = /(?:^|;\s*)p_skey=([^;]*)/.exec(cookies)?.[1] ?? /(?:^|;\s*)skey=([^;]*)/.exec(cookies)?.[1] ?? '';
  let hash = 5381;
  for (const char of key) hash += (hash << 5) + char.charCodeAt(0);
  return hash & 0x7fffffff;
}
/** The post with this feed_id among the cells of a Qzone result, such as get_qzone_public_feeds or get_qzone_public_feed_detail return. */
export function findFeed(value: unknown, tid: string, depth = 0): Feed | undefined {
  if (!value || typeof value !== 'object' || depth > 4) return;
  const feed = value as Feed;
  if (feed.cell_common?.feed_id === tid && feed.cell_operation) return feed;
  for (const item of Object.values(feed)) { const found = findFeed(item, tid, depth + 1); if (found) return found; }
}

/**
 * Shares a post the way Qzone's own web page does: its share service signs a card for the post, which QQ then sends as a json segment.
 * SnowLuma has no interface for this service, so it is called through the same web gateway SnowLuma uses for recommended posts.
 */
export class QzoneShare {
  constructor(private social: SocialAdapter, private selfId: number, private send: QzonePost = post) {}
  async cookies(signal?: AbortSignal): Promise<string> {
    const result = await this.social.execute('get_cookies', { domain: 'qzone.qq.com' }, signal) as { cookies?: unknown } | null;
    if (typeof result?.cookies !== 'string' || !result.cookies) throw new Error('SnowLuma returned no Qzone cookies.');
    return result.cookies;
  }
  private async rpc(cookies: string, service: string, method: string, oidb: string, body: unknown, signal?: AbortSignal): Promise<Feed> {
    const [command, serviceType] = oidb.split('_');
    const text = await this.send(`https://h5.qzone.qq.com/http2rpc/gotrpc/v1/${service}/${method}?g_tk=${gtk(cookies)}`, JSON.stringify(body), {
      Cookie: cookies, 'Content-Type': 'application/json', Referer: 'https://h5.qzone.qq.com/pc-qzone/index.html', 'x-web-qua': 'V1_HT5_QZ_9.9.32_001_IDC_B',
      'x-oidb': JSON.stringify({ uint32_command: command, uint32_service_type: serviceType }),
    }, signal);
    const response = JSON.parse(text);
    if (response?.retcode !== 0 || !response.data || typeof response.data !== 'object') throw new Error(`Qzone ${method} failed: retcode=${response?.retcode} ${response?.message ?? ''}`.trim());
    return response.data;
  }
  /** One of your own posts as Qzone's web page lists it; the older interfaces SnowLuma reads them through lack what sharing needs. */
  async ownFeed(cookies: string, tid: string, signal?: AbortSignal): Promise<Feed> {
    let attach = '';
    for (let page = 0; page < 10; page++) {
      const data = await this.rpc(cookies, 'trpc.qzone.feeds_reader.FeedsReader', 'GetMainPageFeeds', '0x9794_2', { host_uid: '', host_uin: String(this.selfId), attach_info: attach, refresh_attach_info: '', feed_action_domain_type: 1 }, signal);
      const found = findFeed(data.feeds, tid);
      if (found) return found;
      if (!data.has_more || !data.attach_info) break;
      attach = data.attach_info;
    }
    throw new Error(`Post ${tid} is not among your own Qzone posts.`);
  }
  /** The signed card JSON, exactly as Qzone returns it: re-serializing it could change what the signature covers. */
  async card(cookies: string, feed: Feed, signal?: AbortSignal): Promise<string> {
    const resource = feed.cell_operation?.share_outside?.share_access_resource;
    if (!resource?.busi_id || !resource.resource_id) throw new Error('Qzone offers no share for this post.');
    // plat 1 and target 3 are what the web page's share-to-friend sends: a QQ card for any friend or group.
    const data = await this.rpc(cookies, 'trpc.qq.share.Service', 'CreateShare', '0x9409_1', { info: { busi_id: resource.busi_id, resource_id: resource.resource_id, template: 'ark_busi_select', busi_data: feed.cell_feed_transfer, plat: 1, target: 3 } }, signal);
    if (data.err?.code) throw new Error(`Qzone CreateShare failed: ${data.err.code} ${data.err.msg ?? ''}`.trim());
    if (typeof data.template_data !== 'string' || !data.template_data) throw new Error('Qzone returned no share card.');
    return data.template_data;
  }
}
