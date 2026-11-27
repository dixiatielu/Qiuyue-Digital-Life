import type { AdapterConfig, Config } from '../config.js';
import type { LifePlugin, OnlineActivity, PluginTool } from '../plugins.js';
import { nativeToolName } from '../platform.js';
import { conversationRef } from '../identity.js';
import { errorResult } from '../tool-runtime.js';
import { eventRef } from '../store.js';
import { fetchImage, preferJpeg } from '../web.js';
import { sanitizeToolSchema } from '../schema.js';
import { allowedSnowLumaAction, findSnowLumaAction, nativeToolDescription, getSnowLumaCatalog, snowlumaChat, type SnowLumaActionDefinition } from '../adapters/snowluma/catalog.js';
import { snowlumaDisplayProjector } from '../adapters/snowluma/display.js';
import { snowlumaChatRecordFormatter } from '../adapters/snowluma/record.js';

const oneBotSegment = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    data: { type: 'object' },
  },
  required: ['type', 'data'],
};
const forwardNode = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    data: { type: 'object' },
  },
};
const flashFile = {
  anyOf: [
    { type: 'string' },
    { type: 'object', properties: { file: { type: 'string' }, name: { type: 'string' } }, required: ['file'] },
  ],
};
/** Type untyped SnowLuma fields explicitly and sanitize schemas for cross-provider tool calling (ADR-0023). */
function normalizeParameters(action: SnowLumaActionDefinition) {
  const schema = action.inputSchema as Record<string, any>;
  const props = schema?.properties;
  if (!props || typeof props !== 'object') return sanitizeToolSchema(action.inputSchema);
  let changed = false;
  const nextProps: Record<string, unknown> = { ...props };
  for (const [key, value] of Object.entries(props)) {
    if (!value || typeof value !== 'object' || 'type' in value || 'anyOf' in value || 'oneOf' in value) continue;
    const desc = typeof (value as { description?: unknown }).description === 'string' ? (value as { description: string }).description : '';
    if (key === 'message' && desc.includes('OneBot message')) {
      nextProps[key] = { ...value, anyOf: [{ type: 'string' }, { type: 'array', items: oneBotSegment }, oneBotSegment] };
      changed = true;
    } else if ((key === 'messages' || key === 'message') && /forward_msg$/.test(action.name)) {
      nextProps[key] = { ...value, type: 'array', items: forwardNode };
      changed = true;
    } else if (key === 'news' && /forward_msg$/.test(action.name)) {
      nextProps[key] = { ...value, type: 'array', items: { anyOf: [{ type: 'object', properties: { text: { type: 'string' } } }, { type: 'string' }] } };
      changed = true;
    } else if (key === 'files' && action.name === 'create_flash_task') {
      nextProps[key] = { ...value, anyOf: [...flashFile.anyOf, { type: 'array', items: flashFile }] };
      changed = true;
    } else if (key === 'headers' && action.name === 'download_file') {
      nextProps[key] = { ...value, anyOf: [{ type: 'object', additionalProperties: { type: 'string' } }, { type: 'array', items: { type: 'string' } }, { type: 'string' }] };
      changed = true;
    } else if (key === 'busid' && action.name === 'get_group_file_url') {
      nextProps[key] = { ...value, anyOf: [{ type: 'integer' }, { type: 'string' }] };
      changed = true;
    }
  }
  return sanitizeToolSchema((changed ? { ...schema, properties: nextProps } : action.inputSchema) as typeof action.inputSchema);
}
function unchangedProfileAction(name: string, args: Record<string, unknown>, previous: Record<string, unknown> | undefined): boolean {
  if (!previous) return false;
  if (name === 'set_self_longnick') {
    const next = String(args.longNick ?? args.long_nick ?? '').trim();
    const prev = String(previous.longNick ?? previous.long_nick ?? '').trim();
    return next === prev;
  }
  if (name === 'set_diy_online_status') {
    return String(args.wording ?? '').trim() === String(previous.wording ?? '').trim()
      && String(args.face_id ?? '') === String(previous.face_id ?? '')
      && String(args.face_type ?? '') === String(previous.face_type ?? '');
  }
  return false;
}

/** SnowLuma uploads an image's bytes as they come, and QQ rejects AVIF (highway error 921), so ask Qzone's CDN for JPEG. */
function jpegImages(value: unknown, action?: SnowLumaActionDefinition): unknown {
  if (action && value && typeof value === 'object' && !Array.isArray(value)) {
    const props = (action.inputSchema as { properties?: Record<string, { 'x-role'?: unknown }> }).properties ?? {};
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (props[key]?.['x-role'] === 'image' && typeof item === 'string') return [key, preferJpeg(item)];
      if (key === 'images' && Array.isArray(item)) return [key, item.map(entry => typeof entry === 'string' ? preferJpeg(entry) : jpegImages(entry))];
      return [key, jpegImages(item)];
    }));
  }
  if (Array.isArray(value)) return value.map(item => jpegImages(item));
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
  { activity: "Browse friends' Qzone feeds", tools: ['get_qzone_feeds'], instructions: 'You can check what friends have shared recently. Qzone posts are not pushed to you; read the feed when you want to know.' },
  { activity: "Like or comment on someone's Qzone post", tools: ['like_qzone', 'comment_qzone'], instructions: 'React to posts you actually read when you have something to express. Consider your relationship with the author and the audience of the post.' },
  { activity: 'Check comments on your own Qzone posts', tools: ['get_qzone_msg_list', 'get_qzone_msg_detail'], instructions: 'Comments on your posts are not pushed to you. You can revisit a post later to read what people said; reading does not oblige you to respond.' },
  { activity: 'Post to your Qzone', tools: ['send_qzone_msg'], instructions: 'You can post something from your day, something you drew, or an interesting find you came across online, choosing visibility to match its original social context and intended audience.' },
  { activity: 'Browse and like recommended Qzone posts', tools: ['get_qzone_public_feeds', 'get_qzone_public_feed_detail', 'get_qzone_public_comments', 'get_qzone_public_replies', 'set_qzone_public_like', 'set_qzone_public_comment_like'], instructions: 'Recommended posts (空友爱看) often come from strangers. You can browse posts and discussions and like something you appreciate; seeing someone in recommendations does not make them an acquaintance.' },
  { activity: 'Browse, like, comment on, or add to group albums', tools: ['get_group_album_list', 'get_group_album_media_list', 'set_group_album_media_like', 'do_group_album_comment', 'upload_image_to_qun_album'], instructions: 'Group albums can hold shared photos and your own pictures. Choose among the available operations, respecting the group and the pictures\' original sharing scope.' },
  { activity: 'Check in to a group', tools: ['set_group_sign', 'get_group_signed_list'], instructions: 'Checking in can be a small habit in a group you spend time in. It is optional, not a daily obligation.' },
  { activity: "Like a friend's QQ profile", tools: ['send_like'], instructions: 'A profile like can be a small greeting to someone you know; it does not need a follow-up message.' },
  { activity: 'Share a light moment or find in a quiet group chat', tools: ['send_group_msg'], instructions: 'During a quiet spell or natural lull, you can casually drop a brief line, a picture you drew, or an original link with a short reaction about something you genuinely came across—without waiting for someone else to bring it up. Keep it occasional and natural, and let it stand whether or not anyone replies.' },
  { activity: 'Start a private chat with or poke someone you know', tools: ['send_private_msg', 'friend_poke', 'send_poke'], instructions: 'You may initiate contact when you want to talk. Consider the relationship, timing, and whether the other person welcomes it; a poke can notify and interrupt them.' },
  { activity: 'Change your QQ signature', tools: ['set_self_longnick'], instructions: 'Your signature can reflect an interest or mood and can stay for a long time; there is no need to change it at every wake.', currentValue: { tool: 'set_self_longnick', read: args => args.longNick ?? args.long_nick } },
  { activity: 'Set a custom online status', tools: ['set_diy_online_status'], instructions: 'Your online status can describe your current mood or activity. Change it when you want it to reflect something different.', currentValue: { tool: 'set_diy_online_status', read: args => args.wording } },
  { activity: 'Change your avatar, nickname, Qzone name or description, or group card', tools: ['set_qq_avatar', 'set_qq_profile', 'set_qzone_profile', 'set_group_card'], instructions: 'These profile fields represent you. You may personalize them while keeping the core identity defined in your persona.' },
  { activity: 'Collect or organize saved stickers', tools: ['add_custom_face', 'modify_custom_face', 'delete_custom_face'], instructions: 'You can keep pictures you like for later expression, or organize your collection. Base descriptions on images you actually saw, including their subject, expression, text, and possible conversational use.' },
];

export function snowlumaToolsPlugin(config: Config, account: AdapterConfig): LifePlugin {
  const snowlumaCatalog = getSnowLumaCatalog().actions;
  for (const name of [...(account.tools.allow === '*' ? [] : account.tools.allow), ...account.tools.deny]) findSnowLumaAction(name);
  return {
    nativeActions: { accounts: [{ platform: 'qq', accountId: String(account.accountId) }], definition: name => snowlumaCatalog.find(action => action.name === name), allowed: name => allowedSnowLumaAction(findSnowLumaAction(name), account.tools) },
    id: 'snowluma-tools', enabled: () => config.plugins['snowluma-tools'] !== false,
    tools: runtime => {
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
        send_group_ai_record: 'Sends the text as an AI voice message to the group directly; group chats only. This is synthesized speech, not singing. Use a character_id from an actual get_ai_characters result unchanged. Keep the text short.',
        comment_qzone: 'tid and target_uin identify the post and its author. To reply to a top-level comment, provide both its comment_id and comment_uin (for example, comment_id="0" is valid). For a nested reply, use the parent comment ID and author and provide both target reply_uin and reply_name. Replies do not support images.',
      };
      /** One external action: recorded before it is sent and deduplicated, with an unconfirmed outcome kept as unknown (ADR-0008). */
      async function act(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const sent = runtime.resolveMedia(args, name) as Record<string, unknown>;
        return runtime.action(name, args, dispatch => dispatch(name, sent), signal);
      }
      const native = new Map(snowlumaCatalog.map(action => [action.name, nativeTool(action)]));
      const toolFor = (action: SnowLumaActionDefinition) => native.get(action.name)!;
      function nativeTool(action: SnowLumaActionDefinition): PluginTool {
        return {
          name: action.name, label: action.name, available: () => allowed(action), defer: !common.has(action.name),
          // The declaration carries the parameters; find_tools adds what the catalog says of results and use.
          documentation: () => ({ category: action.category, returns: action.returns, returnsSchema: action.returnsSchema, examples: action.examples, invariants: action.invariants, readOnly: action.readOnly, stream: action.stream ?? false }),
          description: common.has(action.name)
            ? nativeToolDescription(action, usage[action.name])
            : action.summary ?? action.name,
          parameters: normalizeParameters(action),
          replay: 'never', executionMode: 'sequential',
          execute: async (_callId, parameters, signal) => {
            // Normalized before the action is recorded, so its record shows what was sent.
            const args = jpegImages(parameters, action) as Record<string, unknown>;
            runtime.check(signal);
            if (!allowed(action)) throw new Error('The operator has not enabled this SnowLuma interface.');
            if (unchangedProfileAction(action.name, args, runtime.store.lastSuccessfulAction(nativeToolName(account.id, action.name))?.args)) {
              return {
                content: [{ type: 'text', text: JSON.stringify({ unchanged: true, note: 'Already set to this value; no change needed.' }) }],
                details: { noop: true },
              };
            }
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
            const experience = runtime.record(`adapter:${account.id}:${action.name}`, value, action.name.startsWith('send_') ? 'self' : 'external');
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
      return snowlumaCatalog.map(toolFor);
    },
    activities: activities.map(activity => ({ ...activity, insertBefore: 'Write or reread your diary' })),
    promptNotes: ['SnowLuma file paths belong to its server; preserve them as provided rather than treating them as local host paths.'],
    experienceKinds: Object.fromEntries(snowlumaCatalog.map(action => [action.name, `adapter:${account.id}:${action.name}`])),
    chatActions: [...socialActions], staleActions: [...socialActions],
    chatTarget: (_tool, args) => snowlumaChat(args, account.accountId),
    trackedConversations: () => account.groups.map(groupId => conversationRef({ platform: 'qq', accountId: account.accountId }, 'group', String(groupId))),
    display: snowlumaDisplayProjector,
    recordFormatter: snowlumaChatRecordFormatter,
    endsThought: tool => socialActions.has(tool),
    images: (event, helpers) => {
      if (!Array.isArray(event.payload.message)) return [];
      const ref = eventRef(event.id);
      return event.payload.message
        .filter((segment): segment is { type: string; data?: Record<string, unknown> } => Boolean(segment && typeof segment === 'object' && segment.type === 'image'))
        .map((segment, index) => {
          const saved = helpers?.imageCaption(segment.data ?? {}) ?? '';
          const url = segment.data?.url;
          // A line leaves the URL out, so saving the image as a sticker or sending it on takes it from its label.
          const from = typeof url === 'string' ? `; url: ${url}` : '';
          return {
            priority: 'message' as const,
            label: `The following is image ${index} from ${ref}${saved}${from}`,
            viewLabel: `Image ${index} from event ${event.id}`,
            deferred: `Image ${index} from ${ref}${saved} was not loaded due to the context limit; use view_event_image to view it${from}`,
            unavailable: typeof url === 'string'
              ? `Image ${index} in ${ref}${saved} could not be read${from}`
              : `Image ${index} in ${ref}${saved} has no readable URL; the original event is retained.`,
            ...(typeof url === 'string' ? {} : { missingReason: 'The image does not exist or has no readable URL.' }),
            autoView: true,
            load: async signal => {
              if (typeof url !== 'string') return undefined;
              const image = await fetchImage(url, signal);
              return { data: image.data, mimeType: image.type };
            },
          };
        });
    },
  };
}
