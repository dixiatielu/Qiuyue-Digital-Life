import type { SocialAdapter } from './snowluma.js';

type Feed = Record<string, any>;

/** The post with this feed_id among the cells of a Qzone result, such as get_qzone_public_feeds or get_qzone_home_feeds return. */
export function findFeed(value: unknown, tid: string, depth = 0): Feed | undefined {
  if (!value || typeof value !== 'object' || depth > 4) return;
  const feed = value as Feed;
  if (feed.cell_common?.feed_id === tid && feed.cell_operation) return feed;
  for (const item of Object.values(feed)) { const found = findFeed(item, tid, depth + 1); if (found) return found; }
}

/**
 * The card Qzone's share service signs for a post, which QQ sends as a json segment, through SnowLuma's get_qzone_share_ark.
 * The ark is kept exactly as signed: re-serializing it could change what the signature covers.
 * A notice is Qzone's warning, shown before sharing from a restricted space, that anyone holding the card can open the post.
 */
export async function qzoneCard(social: SocialAdapter, feed: unknown, signal?: AbortSignal): Promise<{ ark: string; notice: string | null }> {
  const share = await social.execute('get_qzone_share_ark', { feed }, signal) as { ark?: unknown; notice?: unknown } | null;
  if (typeof share?.ark !== 'string' || !share.ark) throw new Error('SnowLuma returned no share card.');
  return { ark: share.ark, notice: typeof share.notice === 'string' && share.notice ? share.notice : null };
}
/** One of your own posts, read by its tid with get_qzone_feed_detail. */
export async function ownFeed(social: SocialAdapter, tid: string, signal?: AbortSignal): Promise<Feed> {
  const detail = await social.execute('get_qzone_feed_detail', { tid }, signal) as { feed?: unknown } | null;
  if (!detail?.feed || typeof detail.feed !== 'object') throw new Error(`SnowLuma returned no Qzone post for ${tid}.`);
  return detail.feed as Feed;
}
