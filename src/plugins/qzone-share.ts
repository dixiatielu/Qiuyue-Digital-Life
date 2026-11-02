import { Type } from 'typebox';
import type { SocialAdapter } from '../snowluma.js';
import type { Config } from '../config.js';
import type { LifePlugin } from '../plugins.js';
import { errorResult } from '../tool-runtime.js';
import { allowedSnowLumaAction, findSnowLumaAction } from '../snowluma-catalog.js';

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

export function qzoneSharePlugin(config: Config): LifePlugin {
  const allowed = (name: string) => allowedSnowLumaAction(findSnowLumaAction(name), config.snowluma.tools);
  return {
    id: 'qzone-share',
    tools: runtime => [runtime.tool('share_qzone_feed', "Share a Qzone post into a private or group chat as the card QQ itself sends when sharing a post: Qzone signs the card, and the send returns a receipt. For a post listed in a Qzone result, such as a recommended (空友爱看) post from get_qzone_public_feeds or a post from get_qzone_home_feeds, pass its cell_common.feed_id as tid and the ID of that result as source. For one of your own posts, pass its tid alone. Specify exactly one of user_id or group_id. Qzone warns that anyone holding a shared card can open the post, even in a restricted space, and a recommended post's card carries its author's QQ number; share only what the post's original audience permits. A notice in the result is Qzone's warning for this post.", Type.Object({ tid: Type.String({ description: 'feed_id of the post; for your own post, its tid', minLength: 1, maxLength: 100 }), source: Type.Optional(Type.String({ description: 'Event ID of the result listing the post; omit for your own post', minLength: 1, maxLength: 100 })), user_id: Type.Optional(Type.Integer({ minimum: 1 })), group_id: Type.Optional(Type.Integer({ minimum: 1 })) }), async (args, signal) => {
      if ((args.user_id === undefined) === (args.group_id === undefined)) throw new Error('Specify exactly one of user_id or group_id.');
      let listed: Feed | undefined;
      if (args.source !== undefined) {
        const event = runtime.store.event(runtime.store.resolve(args.source));
        if (!event) throw new Error('The experience does not exist or has been deleted.');
        listed = findFeed(event.payload.result, args.tid);
        if (!listed) throw new Error('That post does not appear in the event.');
        runtime.context().sources.add(event.id);
      }
      const target = args.group_id !== undefined ? { group_id: args.group_id } : { user_id: args.user_id };
      const social: SocialAdapter = { execute: (name, parameters, signal) => runtime.query(name, parameters, signal) };
      let share: Awaited<ReturnType<typeof qzoneCard>> | undefined;
      const { outcome, reused } = await runtime.action('share_qzone_feed', { ...target, tid: args.tid }, async dispatch => {
        share = await qzoneCard(social, listed ?? await ownFeed(social, args.tid, signal), signal);
        const { ark: card, notice } = share;
        return { receipt: await dispatch(args.group_id !== undefined ? 'send_group_msg' : 'send_private_msg', { ...target, message: [{ type: 'json', data: { data: card } }] }), card, ...(notice ? { notice } : {}) };
      }, signal, error => share === undefined ? errorResult(error) : { error: errorResult(error), card: share.ark, ...(share.notice ? { notice: share.notice } : {}) });
      if (outcome.status !== 'success') throw new Error(JSON.stringify({ actionId: outcome.id, outcome: outcome.status, reused, error: outcome.result, instruction: 'Use inspect_actions to check the action record.' }));
      const experience = runtime.record('qzone_share', outcome.result);
      const metadata = { sourceId: experience.sourceId, actionId: outcome.id, outcome: 'success', reused };
      return { content: [{ type: 'text', text: JSON.stringify(outcome.result) }, { type: 'text', text: `Local execution information: ${JSON.stringify(metadata)}` }], details: metadata };
    })],
    enabled: () => config.plugins['qzone-share'] !== false && allowed('get_qzone_share_ark') && ['send_private_msg', 'send_group_msg'].some(allowed),
    activities: [{ activity: 'Share a Qzone post with someone or a group', tools: ['share_qzone_feed'] }],
    experienceKinds: { share_qzone_feed: 'qzone_share' },
    chatActions: ['share_qzone_feed'],
  };
}
