import { Type } from 'typebox';
import type { Config } from '../config.js';
import type { LifePlugin, OnlineActivity, PluginTool } from '../plugins.js';
import { errorResult } from '../tool-runtime.js';
import { preferJpeg } from '../web.js';
import { allowedSnowLumaAction, findSnowLumaAction, nativeToolDescription, getSnowLumaCatalog, snowlumaChat, type SnowLumaActionDefinition } from '../adapters/snowluma/catalog.js';

const string = (description: string, maxLength = 6000) => Type.String({ description, minLength: 1, maxLength });
// Normalize common ways of describing QQ actions before matching catalog text.
const toolSearchAliases: [RegExp, string][] = [
  [/private (?:message|chat)|direct message/giu, '私聊'],
  [/group members?|group users?/giu, '群成员'],
  [/delete|recall|revoke/giu, '撤回'],
  [/send/giu, '发送'],
  [/get|find|search|read|list/giu, '获取'],
  [/qzone|space|feed/giu, '空间'],
  [/groups?/giu, '群'],
  [/friends?/giu, '好友'],
  [/messages?/giu, '消息'],
  [/files?/giu, '文件'],
  [/emoji|emoticons?/giu, '表情'],
  [/forward/giu, '转发'],
  [/images?|pictures?/giu, '图片'],
  [/voice|audio/giu, '语音'],
  [/announcements?/giu, '公告'],
  [/私信|私聊消息|单聊|私发/gu, '私聊'],
  [/群友|群员/gu, '群成员'],
  [/撤销|收回/gu, '撤回'],
  [/发出|发给|发条|发一条|发个|发(?=私聊|消息)|发送/gu, '发送'],
  [/查看|查找|查询|读取/gu, '获取'],
  [/好友动态|qq空间|朋友圈/giu, '空间'],
  [/聊天记录/gu, '消息'],
];
const toolSearchConcepts = ['私聊', '群成员', '群', '好友', '消息', '发送', '撤回', '获取', '空间', '文件', '表情', '转发', '图片', '语音', '公告'];
function normalizeToolSearch(value: string): string {
  return toolSearchAliases.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value.toLowerCase());
}
/** SnowLuma uploads an image segment's bytes as they come, and QQ rejects AVIF (highway error 921), so ask Qzone's CDN for JPEG. */
function jpegImages(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jpegImages);
  if (!value || typeof value !== 'object') return value;
  const segment = value as { type?: unknown; data?: Record<string, unknown> };
  if (segment.type === 'image' && segment.data && typeof segment.data === 'object') {
    const data = { ...segment.data };
    for (const key of ['file', 'url']) if (typeof data[key] === 'string') data[key] = preferJpeg(data[key]);
    return { ...segment, data };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jpegImages(item)]));
}
const socialActions = new Set(['send_private_msg', 'send_group_msg', 'send_msg', 'send_custom_face', 'send_group_ai_record', 'set_group_reaction', 'set_msg_emoji_like', 'send_poke', 'friend_poke', 'group_poke']);
const activities: OnlineActivity[] = [
  { activity: "Browse friends' Qzone feeds", tools: ['get_qzone_feeds'] },
  { activity: "Like or comment on someone's Qzone post", tools: ['like_qzone', 'comment_qzone'] },
  { activity: 'Check comments on your own Qzone posts', tools: ['get_qzone_msg_list', 'get_qzone_msg_detail'] },
  { activity: 'Post to your Qzone', tools: ['send_qzone_msg'] },
  { activity: 'Browse and like recommended Qzone posts', tools: ['get_qzone_public_feeds', 'get_qzone_public_feed_detail', 'get_qzone_public_comments', 'get_qzone_public_replies', 'set_qzone_public_like', 'set_qzone_public_comment_like'] },
  { activity: 'Browse, like, comment on, or add to group albums', tools: ['get_group_album_list', 'get_group_album_media_list', 'set_group_album_media_like', 'do_group_album_comment', 'upload_image_to_qun_album'] },
  { activity: 'Check in to a group', tools: ['set_group_sign', 'get_group_signed_list'] },
  { activity: "Like a friend's QQ profile", tools: ['send_like'] },
  { activity: 'Start a private chat with or poke someone you know', tools: ['send_private_msg', 'friend_poke', 'send_poke'] },
  { activity: 'Change your QQ signature', tools: ['set_self_longnick'], currentValue: { tool: 'set_self_longnick', read: args => args.longNick ?? args.long_nick } },
  { activity: 'Set a custom online status', tools: ['set_diy_online_status'], currentValue: { tool: 'set_diy_online_status', read: args => args.wording } },
  { activity: 'Change your avatar, nickname, Qzone name or description, or group card', tools: ['set_qq_avatar', 'set_qq_profile', 'set_qzone_profile', 'set_group_card'] },
  { activity: 'Collect or organize saved stickers', tools: ['add_custom_face', 'modify_custom_face', 'delete_custom_face'] },
];

export function snowlumaToolsPlugin(config: Config): LifePlugin {
  const snowlumaCatalog = getSnowLumaCatalog().actions;
  for (const name of [...(config.snowluma.tools.allow === '*' ? [] : config.snowluma.tools.allow), ...config.snowluma.tools.deny]) findSnowLumaAction(name);
  return {
    nativeActions: { accounts: [{ platform: 'qq', accountId: String(config.snowluma.selfId) }], definition: name => snowlumaCatalog.find(action => action.name === name), allowed: name => allowedSnowLumaAction(findSnowLumaAction(name), config.snowluma.tools) },
    id: 'snowluma-tools', enabled: () => config.plugins['snowluma-tools'] !== false,
    tools: runtime => {
      const tool = runtime.jsonTool.bind(runtime);
      const allowed = (action: SnowLumaActionDefinition) => runtime.allowed(action.name);
      const common = new Set([
        'send_group_msg', 'send_private_msg', 'set_group_reaction', 'group_poke', 'get_msg',
        'fetch_custom_face_detail', 'send_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_msg',
        'get_qzone_feeds', 'get_qzone_msg_detail', 'send_qzone_msg', 'like_qzone', 'comment_qzone',
        'get_ai_characters', 'send_group_ai_record',
        'set_diy_online_status',
      ]);
      const quote = 'To quote a message, make the first segment {"type":"reply","data":{"id":"<messageId>"}} using the messageId of an actual message event or send receipt (negative values are valid), followed by text segments, for example [{"type":"reply","data":{"id":"-12"}},{"type":"text","data":{"text":"..."}}]. A plain string sends without a quote.';
      const usage: Record<string, string> = {
        set_diy_online_status: 'Keep wording brief, for example 听歌中. If QQ returns "set status fail", it rejected the status; choose shorter, simpler wording before another attempt. QQ does not report the specific reason for this rejection.',
        send_group_msg: quote,
        send_private_msg: quote,
        set_group_reaction: 'code is a QQ system face ID, or the code point of a Unicode emoji. Use view_face to see what a system face looks like before choosing one you do not know.',
        fetch_custom_face_detail: 'Returns saved emoji_id values, image URLs, and possibly empty descriptions. Choose based on actual content; do not guess image meanings.',
        send_custom_face: 'Use an emoji_id from an actual fetch_custom_face_detail result, add_custom_face receipt, or saved sticker an observation names. For a group pass group_id=<actual group ID> and emoji_id=<saved ID>; for a private chat use user_id instead. Specify only one target.',
        add_custom_face: 'Use an accessible image URL, base64:// data, or a file:// path on the SnowLuma server for file. Check the receipt to confirm success; after a successful save, use its returned emoji_id with modify_custom_face to add a description based on the image actually seen. If the outcome is unknown, verify it before taking further action.',
        modify_custom_face: 'Set desc to a concise description of the actual image and its suitable emotional or conversational use. Use the emoji_id returned by a successful add_custom_face or an actual fetch_custom_face_detail result; do not guess image content.',
        delete_msg: 'The message_id must come from an actual message event or send receipt; negative values may also be valid.',
        get_qzone_feeds: 'A post tid may be null. For pagination use next_cursor unchanged; do not invent a missing tid or content.',
        get_qzone_msg_detail: 'Query using the actual post tid and its owner target_uin. Omitting target_uin refers to your own Qzone. Inline replies may be incomplete.',
        send_qzone_msg: 'When ugc_right is omitted, the default is visible to everyone; 4 means friends only, 64 means only yourself, and 16 or 128 also requires target_uins. For example, use ugc_right=64 for yourself only; choose a visibility matching the sharing scope.',
        like_qzone: 'Use tid and target_uin from an actual post; omitting target_uin refers to your own Qzone. abstime may be the actual posting time.',
        send_group_ai_record: 'Sends the text as an AI voice message to the group directly; group chats only. Use a character_id from an actual get_ai_characters result unchanged. Keep the text short.',
        comment_qzone: 'tid and target_uin identify the post and its author. To reply to a top-level comment, provide both its comment_id and comment_uin (for example, comment_id="0" is valid). For a nested reply, use the parent comment ID and author and provide both target reply_uin and reply_name. Replies do not support images.',
      };
      /** One external action: recorded before it is sent and deduplicated, with an unconfirmed outcome kept as unknown (ADR-0008). */
      async function act(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const sent = runtime.resolveMedia(args) as Record<string, unknown>;
        return runtime.action(name, args, dispatch => dispatch(name, sent), signal);
      }
      const native = new Map(snowlumaCatalog.map(action => [action.name, nativeTool(action)]));
      const toolFor = (action: SnowLumaActionDefinition) => native.get(action.name)!;
      function nativeTool(action: SnowLumaActionDefinition): PluginTool {
        return {
          name: action.name, label: action.name, available: () => allowed(action),
          description: common.has(action.name)
            ? nativeToolDescription(action, usage[action.name])
            : action.summary ?? action.name,
          parameters: action.inputSchema,
          replay: 'never', executionMode: 'sequential',
          execute: async (_callId, parameters, signal) => {
            // Normalized before the action is recorded, so its record shows what was sent.
            const args = jpegImages(parameters) as Record<string, unknown>;
            runtime.check(signal);
            if (!allowed(action)) throw new Error('The operator has not enabled this SnowLuma interface.');
            let actionId: string | undefined; let reused = false; let value: unknown;
            if (action.readOnly) {
              try { value = await runtime.query(action.name, args, signal); }
              catch (error) { throw new Error(JSON.stringify({ error: errorResult(error) })); }
            } else {
              const attempt = await act(action.name, args, signal);
              const outcome = attempt.outcome; actionId = outcome.id; reused = attempt.reused;
              if (outcome.status !== 'success') throw new Error(JSON.stringify({ actionId, outcome: outcome.status, reused, error: outcome.result, instruction: 'Use inspect_actions to check the action record.' }));
              value = outcome.result;
            }
            const experience = runtime.record(`snowluma:${action.name}`, value);
            const serialized = JSON.stringify(value) ?? 'null';
            const truncated = serialized.length > 12000;
            const metadata = { sourceId: experience.sourceId, ...(actionId ? { actionId, outcome: 'success', reused } : {}), truncated };
            return {
              content: [{ type: 'text', text: truncated ? serialized.slice(0, 12000) + '\n[Result truncated; the full result is stored in the source event payload.result and can be read in chunks using read_event]' : serialized }, { type: 'text', text: `Local execution information: ${JSON.stringify(metadata)}` }],
              details: metadata,
            };
          },
        };
      }
      const discovery: PluginTool[] = [
        tool('search_snowluma_tools', 'Search SnowLuma interfaces by purpose, synonyms, or category; use an empty query to browse. Interfaces are directly available; use load_snowluma_tools for detailed usage.', Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), category: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), args => {
          const query = normalizeToolSearch(String(args.query ?? '').trim());
          const terms = query.split(/\s+/u).filter(Boolean);
          const concepts = toolSearchConcepts.filter(concept => query.includes(concept));
          const pool = snowlumaCatalog.filter(action => !args.category || args.category === action.category);
          const text = (action: SnowLumaActionDefinition) => normalizeToolSearch([action.name, action.category ?? '', action.summary ?? ''].join(' '));
          let matches = pool.filter(action => terms.every(term => text(action).includes(term)));
          if (!matches.length && concepts.length) matches = pool.filter(action => concepts.every(concept => text(action).includes(concept)));
          const offset = args.offset ?? 0; const limit = args.limit ?? 20;
          const categories = [...new Set(snowlumaCatalog.map(action => action.category).filter((category): category is string => !!category))];
          const relatedCategories = !matches.length && concepts.length ? [...new Set(snowlumaCatalog.filter(action => concepts.some(concept => text(action).includes(concept))).map(action => action.category).filter(Boolean))] : [];
          return { total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : null, categories, ...(!matches.length ? { relatedCategories, hint: 'Try shorter keywords, or clear query and specify category to browse.' } : {}), actions: matches.slice(offset, offset + limit).map(action => ({ name: action.name, summary: action.summary, category: action.category, readOnly: action.readOnly, stream: action.stream ?? false, allowed: allowed(action) })) };
        }),
        tool('load_snowluma_tools', 'View detailed usage, parameters, results, examples, and constraints for enabled SnowLuma tools by original interface name. Tools are already directly available; this query does not change the tool set.', Type.Object({ names: Type.Array(string('Original SnowLuma interface name', 100), { minItems: 1, maxItems: 8 }) }), args => {
          const actions = [...new Set<string>(args.names)].map(findSnowLumaAction);
          for (const action of actions) if (!allowed(action)) throw new Error(`The operator has not enabled this SnowLuma interface: ${action.name}`);
          return actions.map(action => ({ name: action.name, category: action.category, summary: action.summary, inputSchema: runtime.decorate(toolFor(action)).parameters, returns: action.returns, returnsSchema: action.returnsSchema, examples: action.examples, invariants: action.invariants, readOnly: action.readOnly, stream: action.stream ?? false }));
        }),
      ];
      return [...discovery, ...snowlumaCatalog.map(toolFor)];
    },
    activities: activities.map(activity => ({ ...activity, insertBefore: 'Write or reread your diary' })),
    activityInstructions: 'Use load_snowluma_tools for the parameters of unfamiliar tools.',
    experienceKinds: Object.fromEntries(snowlumaCatalog.map(action => [action.name, `snowluma:${action.name}`])),
    chatActions: [...socialActions], staleActions: [...socialActions],
    chatTarget: (_tool, args) => snowlumaChat(args),
    endsThought: tool => socialActions.has(tool),
  };
}
