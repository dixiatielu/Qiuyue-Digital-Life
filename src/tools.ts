import { Type, type TSchema } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from './config.js';
import { Store } from './store.js';
import type { SocialAdapter } from './snowluma.js';
import { definitelyFailed } from './snowluma.js';
import { errorText } from './domain.js';
import { fetchImage, preferJpeg, WebReader } from './web.js';
import { findFeed, QzoneShare, type QzonePost } from './qzone.js';
import { SnowLumaApiError } from '@snowluma/sdk';
import { allowedSnowLumaAction, findSnowLumaAction, snowlumaCatalog, type SnowLumaActionDefinition } from './snowluma-catalog.js';
import { actionSummary } from './runtime-context.js';
import { ChatRecord } from './record.js';
import { faceCaption, FaceCatalog } from './faces.js';
import type { SemanticRecall } from './recall.js';

/** reviewing: a memory_maintenance event is part of this thought. */
export interface ThoughtContext { generation: number; sources: Set<string>; triggers: Set<string>; lifeOnly: boolean; reviewing?: boolean }
export function ensureCurrent(store: Store, context: ThoughtContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const settings = store.settings();
  if (settings.paused || context.generation !== settings.generation) throw new Error('The run is paused or management state changed; a new reasoning run is required.');
  if (context.lifeOnly && !settings.lifeEnabled) throw new Error('Autonomous life is disabled.');
}
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
/** Every http(s) URL in an event's strings, with HTML's &amp; decoded, so an image named in a tool result can be viewed by its exact URL. */
function urlsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const match of value.replaceAll('&amp;', '&').matchAll(/https?:\/\/[\w\-.~:/?#@!$&()*+,;=%]+/g)) found.add(match[0]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) urlsIn(item, found);
  return found;
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
export interface ToolSet { current(): AgentTool[]; readonly faces: FaceCatalog }

export function createTools(config: Config, store: Store, social: SocialAdapter, context: () => ThoughtContext, qzonePost?: QzonePost, recall?: SemanticRecall): ToolSet {
  const web = new WebReader(config.web);
  const qzone = new QzoneShare(social, config.snowluma.selfId, qzonePost);
  const faces = new FaceCatalog(store, social);
  function tool(name: string, description: string, parameters: TSchema, execute: (args: any, signal?: AbortSignal) => Promise<unknown> | unknown): AgentTool {
    return { name, label: name, description, parameters, executionMode: 'sequential', replay: 'never', execute: async (_callId, args, signal) => {
      ensureCurrent(store, context(), signal);
      const result = await execute(args, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
    } };
  }
  function recordToolExperience(kind: string, result: unknown) {
    ensureCurrent(store, context());
    const event = store.receive({ key: `tool:${crypto.randomUUID()}`, kind, at: Date.now(), text: JSON.stringify(result), payload: { result } }, true)!;
    context().sources.add(event.id);
    return { sourceId: event.id, result };
  }
  const result: AgentTool[] = [
    {
      name: 'view_event_image', label: 'view_event_image', description: 'View an image in an original event. Use index (starting at 0) for an image in a message; use url for an image URL in any other event, such as a Qzone post in a tool result. Specify exactly one. Only read an image URL actually present in that event.',
      parameters: Type.Object({ id: string('Event ID', 100), index: Type.Optional(Type.Integer({ minimum: 0 })), url: Type.Optional(string('Image URL as it appears in the event', 2000)) }), replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        if ((args.index === undefined) === (args.url === undefined)) throw new Error('Specify exactly one of index or url.');
        const event = store.event(store.resolve(args.id));
        if (!event) throw new Error('The experience does not exist or has been deleted.');
        let url: unknown;
        if (args.url !== undefined) {
          url = String(args.url).replaceAll('&amp;', '&');
          if (!urlsIn(event.payload).has(url as string)) throw new Error('That URL does not appear in the event.');
        } else {
          const segments = event.payload.message;
          url = (Array.isArray(segments) ? segments.filter(segment => segment.type === 'image')[args.index] : undefined)?.data?.url;
          if (typeof url !== 'string') throw new Error('The image does not exist or has no readable URL.');
        }
        const result = await fetchImage(url as string, signal);
        ensureCurrent(store, context(), signal);
        context().sources.add(event.id);
        return { content: [{ type: 'text', text: `Image ${args.url !== undefined ? url : args.index} from event ${event.id}` }, { type: 'image', data: result.data.toString('base64'), mimeType: result.type }], details: {} };
      },
    },
    {
      name: 'view_face', label: 'view_face', description: "See what a QQ system face looks like, by the ID in a face segment, a reaction's emoji_id, or set_group_reaction's code. A face's name often says little about what it shows or how people use it.",
      parameters: Type.Object({ id: Type.String({ description: 'Face ID', pattern: '^\\d{1,6}$' }) }), replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        const picture = await faces.image(args.id, signal);
        ensureCurrent(store, context(), signal);
        return { content: [{ type: 'text', text: faceCaption(args.id, await faces.names(signal)) }, { type: 'image', data: picture.toString('base64'), mimeType: 'image/png' }], details: {} };
      },
    },
    tool('inspect_actions', 'View recent action outcomes; specify an id to read the full record in chunks.', Type.Object({ id: Type.Optional(string('Action ID', 100)), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), args => {
      if (args.id) {
        const action = store.actionById(args.id); if (!action) throw new Error('Action does not exist.');
        const text = JSON.stringify(action); const offset = args.offset ?? 0;
        return { id: action.id, text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null };
      }
      return store.actions().map(action => actionSummary(action, 500));
    }),
    tool('read_context', 'Read original working exchanges from before compaction or pruning in chunks.', Type.Object({ id: string('Working record ID starting with ctx:', 100), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), args => {
      const record = store.contextRecord(args.id); if (!record) throw new Error('The working record does not exist, has expired, or has been deleted.');
      for (const source of record.sources) context().sources.add(source);
      const text = JSON.stringify(record.message); const offset = args.offset ?? 0;
      return { id: record.id, text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null };
    }),
    tool('read_event', 'Read an original experience record in chunks.', Type.Object({ id: string('Event source ID', 100), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), args => {
      const event = store.event(store.resolve(args.id)); if (!event) throw new Error('The experience does not exist or has been deleted.');
      context().sources.add(event.id);
      const text = JSON.stringify(event); const offset = args.offset ?? 0;
      return { id: event.id, text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null };
    }),
    tool('recall', `Search for long-term understandings, important experiences, or personal notes${recall ? ', by meaning and by exact words such as names or QQ numbers' : ''}; historical versions are available.`, Type.Object({ query: Type.String({ maxLength: 500 }), subjects: Type.Optional(Type.Array(Type.String())), historical: Type.Optional(Type.Boolean()) }), async (args, signal) => {
      const memories = recall ? await recall.search(args.query, config.memory.recallLimit, args.subjects ?? [], args.historical ?? false, signal) : store.search(args.query, config.memory.recallLimit, args.subjects ?? [], [], args.historical ?? false);
      ensureCurrent(store, context(), signal);
      for (const memory of memories) context().sources.add(memory.id);
      return memories;
    }),
    tool('remember', 'Save experiences, understandings, diary entries, or your own development, based on real sources. Include source IDs; #xxxxxxxx refs from read_chat_record work too. Use supersedes to preserve revisions. Use fiction for permitted fictional life and note for personal diary entries and notes; set fictional when a note or other entry includes fictional daily life. For development, habit is a way of acting or expressing yourself that you keep, and practice is what the people around you do in which situations; both hold everywhere unless scope is group:<id> for what belongs to that group alone. impression is your current understanding of one person and your relationship with them, including what they want from you and how they talk with you (scope person:<qq>; one per person, revised with supersedes); what you saw in one person alone goes there, not in a habit or practice.', Type.Object({ kind: Type.Union(['experience', 'understanding', 'fiction', 'note', 'habit', 'practice', 'impression'].map(x => Type.Literal(x))), title: string('Short title or note name', 200), content: string('Specific experience, understanding, note, or development', 12000), importance: Type.Integer({ minimum: 1, maximum: 10 }), sources: Type.Array(string('Supporting event or memory ID', 100), { maxItems: 50 }), subjects: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), supersedes: Type.Optional(string('ID of the previous memory being updated', 100)), scope: Type.Optional(string('global (the default for habit and practice), group:<id>, or person:<qq> for an impression', 40)), fictional: Type.Optional(Type.Boolean({ description: 'The content includes fictional daily life' })) }), args => store.writeMemory(args, config.life.allowFiction, config.development)),
    tool('retire_memory', 'Retire a habit, practice, or impression that no longer holds. It leaves everyday use; its history remains.', Type.Object({ id: string('Memory ID', 100) }), args => store.retireMemory(args.id)),
    {
      name: 'read_chat_record', label: 'read_chat_record',
      description: "Read the complete record of a group or private chat in time order: everyone's messages, your own, reactions, recalls, and pokes, as they happened. Without from, it continues where your last review stopped, and reading on moves that point forward. from reads forward from any time. query or person instead returns the latest items containing a phrase or written by one person. Results are folded out of working context when the thought ends; read again whenever needed.",
      parameters: Type.Object({ conversation: string('group:<group ID> or private:<QQ ID>', 40), from: Type.Optional(string('ISO time with timezone to read forward from', 100)), query: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), person: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        const record = new ChatRecord(store, config.snowluma.selfId, args.conversation, await faces.names(signal));
        const limit = args.limit ?? config.development.recordLines;
        if (args.query || args.person) return { content: [{ type: 'text', text: record.matches(limit, { query: args.query, person: args.person }) }], details: {} };
        if (args.from && (!/(Z|[+-]\d{2}:\d{2})$/.test(args.from) || !Number.isFinite(Date.parse(args.from)))) throw new Error('from must be an ISO time with a timezone.');
        const mark = store.reviewMark(args.conversation);
        const from = args.from ? Date.parse(args.from) : mark;
        const page = record.page(from, limit);
        // Reading on from the review point moves it. A jump ahead skips what lies between, which only a review means to do.
        if (page.through !== undefined && (from <= mark || context().reviewing)) store.markReviewed(args.conversation, page.through);
        return { content: [{ type: 'text', text: page.text }], details: {} };
      },
    },
    tool('set_activity', 'Record or clear the current activity.', Type.Object({ activity: Type.String({ maxLength: 2000 }) }), args => { store.setActivity(args.activity, [...context().sources]); return store.settings(); }),
    tool('schedule_activity', 'Schedule a life activity or an accepted social commitment.', Type.Object({ title: string('Activity and associated people or groups', 1000), kind: Type.Union([Type.Literal('life'), Type.Literal('commitment')]), at: string('ISO time with timezone, for example 2026-10-28T09:00:00+08:00', 100) }), args => {
      const dueAt = Date.parse(args.at);
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(args.at)) throw new Error('The time must include a timezone.');
      if (args.kind === 'life' && !store.settings().lifeEnabled) throw new Error('Life mode is disabled; life activities cannot be started.');
      if (dueAt < Date.now() + config.life.minWakeMs) throw new Error('The wake interval is too short; adjust the plan.');
      return store.schedule(args.title, args.kind, dueAt, [...context().sources]);
    }),
    tool('finish_activity', 'Mark a commitment or life plan as completed or cancelled.', Type.Object({ id: string('Activity ID', 100), status: Type.Union([Type.Literal('done'), Type.Literal('cancelled')]) }), args => { store.finishWake(args.id, args.status); return store.wakes(); }),
    tool('update_pursuit', "Start something you pursue over days, such as a song you are learning, a series you follow, or a hobby project, or record where one stands now. Without id it starts a pursuit; with id it replaces that pursuit's progress. Setbacks and stalls are progress too.", Type.Object({ id: Type.Optional(string('ID of the pursuit to update', 100)), title: string('What you are pursuing', 200), progress: string('Where it stands now', 1000), fictional: Type.Boolean({ description: 'It belongs to fictional daily life' }) }), args => {
      if (!store.settings().lifeEnabled) throw new Error('Life mode is disabled; pursuits cannot be started or advanced.');
      return store.updatePursuit(args, [...context().sources], config.life.allowFiction);
    }),
    tool('finish_pursuit', 'End a pursuit: done when it is finished, dropped when you have given it up.', Type.Object({ id: string('Pursuit ID', 100), status: Type.Union([Type.Literal('done'), Type.Literal('dropped')]) }), args => { store.finishPursuit(args.id, args.status); return store.pursuits(); }),
    {
      name: 'share_qzone_feed', label: 'share_qzone_feed',
      description: "Share a Qzone post into a private or group chat as the card QQ itself sends when sharing a post: Qzone signs the card, and the send returns a receipt. For a recommended (空友爱看) post, pass its cell_common.feed_id as tid and the ID of the get_qzone_public_feeds or get_qzone_public_feed_detail result it appears in as source. For one of your own posts, pass its tid alone. Specify exactly one of user_id or group_id. Qzone warns that anyone holding a shared card can open the post, even in a restricted space, and a recommended post's card carries its author's QQ number; share only what the post's original audience permits.",
      parameters: Type.Object({ tid: string('feed_id of the post; for your own post, its tid', 100), source: Type.Optional(string('Event ID of the result listing a recommended post; omit for your own post', 100)), user_id: Type.Optional(Type.Integer({ minimum: 1 })), group_id: Type.Optional(Type.Integer({ minimum: 1 })) }),
      replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        if ((args.user_id === undefined) === (args.group_id === undefined)) throw new Error('Specify exactly one of user_id or group_id.');
        let listed: Record<string, unknown> | undefined;
        if (args.source !== undefined) {
          const event = store.event(store.resolve(args.source));
          if (!event) throw new Error('The experience does not exist or has been deleted.');
          listed = findFeed(event.payload.result, args.tid);
          if (!listed) throw new Error('That post does not appear in the event.');
          context().sources.add(event.id);
        }
        const target = args.group_id !== undefined ? { group_id: args.group_id } : { user_id: args.user_id };
        const attempt = store.beginAction(`qzone_share:${crypto.randomUUID()}`, 'share_qzone_feed', { ...target, tid: args.tid }, [...context().sources], [...context().triggers], config.limits.actionsPerHour);
        const actionId = attempt.action.id;
        if (attempt.fresh) {
          // Nothing reaches the chat before the card is sent, so an earlier failure is a definite one.
          let card: string | undefined;
          try {
            const cookies = await qzone.cookies(signal);
            card = await qzone.card(cookies, listed ?? await qzone.ownFeed(cookies, args.tid, signal), signal);
          } catch (error) { store.finishAction(actionId, 'failed', { message: errorText(error) }); }
          if (card !== undefined) {
            try { store.finishAction(actionId, 'success', { receipt: await social.execute(args.group_id !== undefined ? 'send_group_msg' : 'send_private_msg', { ...target, message: [{ type: 'json', data: { data: card } }] }, signal), card }); }
            catch (error) { store.finishAction(actionId, definitelyFailed(error) ? 'failed' : 'unknown', { error: error instanceof SnowLumaApiError ? error.response : { message: errorText(error) }, card }); }
          }
        }
        const outcome = store.actionById(actionId)!;
        if (outcome.status !== 'success') throw new Error(JSON.stringify({ actionId, outcome: outcome.status, reused: !attempt.fresh, error: outcome.result, instruction: 'Use inspect_actions to check the action record.' }));
        const experience = recordToolExperience('qzone_share', outcome.result);
        const metadata = { sourceId: experience.sourceId, actionId, outcome: 'success', reused: !attempt.fresh };
        return { content: [{ type: 'text', text: JSON.stringify(outcome.result) }, { type: 'text', text: `Local execution information: ${JSON.stringify(metadata)}` }], details: metadata };
      },
    },
    tool('read_webpage', 'Read a public webpage.', Type.Object({ url: string('Public webpage URL', 2000) }), async (args, signal) => recordToolExperience('reading', await web.read(args.url, signal))),
    tool('search_web', 'Search the web for public information.', Type.Object({ query: string('Search query, at most 128 Unicode characters', 128) }), async (args, signal) => recordToolExperience('search', await web.search(args.query, signal))),
  ];
  const allowed = (action: SnowLumaActionDefinition) => allowedSnowLumaAction(action, config.snowluma.tools);
  const common = new Set([
    'send_group_msg', 'send_private_msg', 'set_group_reaction', 'group_poke', 'get_msg',
    'fetch_custom_face_detail', 'send_custom_face', 'add_custom_face', 'modify_custom_face', 'delete_msg',
    'get_qzone_feeds', 'get_qzone_msg_detail', 'send_qzone_msg', 'like_qzone', 'comment_qzone',
    'get_ai_characters', 'send_group_ai_record',
  ]);
  const quote = 'To quote a message, make the first segment {"type":"reply","data":{"id":"<messageId>"}} using the messageId of an actual message event or send receipt (negative values are valid), followed by text segments, for example [{"type":"reply","data":{"id":"-12"}},{"type":"text","data":{"text":"..."}}]. A plain string sends without a quote.';
  const usage: Record<string, string> = {
    send_group_msg: quote,
    send_private_msg: quote,
    set_group_reaction: 'code is a QQ system face ID, or the code point of a Unicode emoji. Use view_face to see what a system face looks like before choosing one you do not know.',
    fetch_custom_face_detail: 'Returns saved emoji_id values, image URLs, and possibly empty descriptions. Choose based on actual content; do not guess image meanings.',
    send_custom_face: 'Use an emoji_id from an actual fetch_custom_face_detail result. For a group pass group_id=<actual group ID> and emoji_id=<saved ID>; for a private chat use user_id instead. Specify only one target.',
    add_custom_face: 'Use an accessible image URL, base64:// data, or a file:// path on the SnowLuma server for file. Check the receipt to confirm success; after a successful save, use its returned emoji_id with modify_custom_face to add a description based on the image actually seen. QQ keeps one copy of an image, so alreadySaved in the local execution information means it was saved before and this only moved it to the front; keep its description unless it is wrong. If the outcome is unknown, verify it before taking further action.',
    modify_custom_face: 'Set desc to a concise description of the actual image and its suitable emotional or conversational use. Use the emoji_id returned by a successful add_custom_face or an actual fetch_custom_face_detail result; do not guess image content.',
    delete_msg: 'The message_id must come from an actual message event or send receipt; negative values may also be valid.',
    get_qzone_feeds: 'A post tid may be null. For pagination use next_cursor unchanged; do not invent a missing tid or content.',
    get_qzone_msg_detail: 'Query using the actual post tid and its owner target_uin. Omitting target_uin refers to your own Qzone. Inline replies may be incomplete.',
    send_qzone_msg: 'When ugc_right is omitted, the default is visible to everyone; 4 means friends only, 64 means only yourself, and 16 or 128 also requires target_uins. For example, use ugc_right=64 for yourself only; choose a visibility matching the sharing scope.',
    like_qzone: 'Use tid and target_uin from an actual post; omitting target_uin refers to your own Qzone. abstime may be the actual posting time.',
    send_group_ai_record: 'Sends the text as an AI voice message to the group directly; group chats only. Use a character_id from an actual get_ai_characters result unchanged. Keep the text short.',
    comment_qzone: 'tid and target_uin identify the post and its author. To reply to a top-level comment, provide both its comment_id and comment_uin (for example, comment_id="0" is valid). For a nested reply, use the parent comment ID and author and provide both target reply_uin and reply_name. Replies do not support images.',
  };
  const native = new Map(snowlumaCatalog.map(action => [action.name, nativeTool(action)]));
  function nativeTool(action: SnowLumaActionDefinition): AgentTool {
    return {
      name: action.name, label: action.name,
      description: common.has(action.name)
        ? [action.summary, `SnowLuma native interface ${action.name}; ${action.readOnly ? 'read-only query' : 'may have side effects and is subject to action budgets and deduplication'}.`, ...action.invariants, action.returns, action.stream ? 'Streaming results return an array of raw data frames in arrival order.' : '', usage[action.name]].filter(Boolean).join('\n')
        : action.summary ?? action.name,
      parameters: action.inputSchema, replay: 'never', executionMode: 'sequential',
      execute: async (_callId, parameters, signal) => {
        // Normalized before the action is recorded, so its record shows what was sent.
        const args = jpegImages(parameters) as Record<string, unknown>;
        ensureCurrent(store, context(), signal);
        if (!allowed(action)) throw new Error('The operator has not enabled this SnowLuma interface.');
        let actionId: string | undefined; let reused = false; let value: unknown;
        if (action.readOnly) {
          try { value = await social.execute(action.name, args, signal); }
          catch (error) { throw new Error(JSON.stringify({ error: error instanceof SnowLumaApiError ? error.response : { message: errorText(error) } })); }
        } else {
          const attempt = store.beginAction(`snowluma:${crypto.randomUUID()}`, action.name, args, [...context().sources], [...context().triggers], config.limits.actionsPerHour);
          actionId = attempt.action.id; reused = !attempt.fresh;
          if (attempt.fresh) {
            try { store.finishAction(actionId, 'success', await social.execute(action.name, args, signal)); }
            catch (error) { store.finishAction(actionId, definitelyFailed(error) ? 'failed' : 'unknown', error instanceof SnowLumaApiError ? error.response : { message: errorText(error) }); }
          }
          const outcome = store.actionById(actionId)!;
          if (outcome.status !== 'success') throw new Error(JSON.stringify({ actionId, outcome: outcome.status, reused, error: outcome.result, instruction: 'Use inspect_actions to check the action record.' }));
          value = outcome.result;
        }
        const experience = recordToolExperience(`snowluma:${action.name}`, value);
        const serialized = JSON.stringify(value) ?? 'null';
        const truncated = serialized.length > 12000;
        const saved = action.name === 'add_custom_face' ? String((value as { emoji_id?: unknown } | null)?.emoji_id ?? '') : '';
        const alreadySaved = saved && store.stickerSaved(saved, actionId) ? { alreadySaved: true, desc: store.stickerNote(saved) ?? '' } : {};
        const metadata = { sourceId: experience.sourceId, ...(actionId ? { actionId, outcome: 'success', reused } : {}), ...alreadySaved, truncated };
        return {
          content: [{ type: 'text', text: truncated ? serialized.slice(0, 12000) + '\n[Result truncated; the full result is stored in the source event payload.result and can be read in chunks using read_event]' : serialized }, { type: 'text', text: `Local execution information: ${JSON.stringify(metadata)}` }],
          details: metadata,
        };
      },
    };
  }
  result.push(
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
      return actions.map(action => ({ name: action.name, category: action.category, summary: action.summary, inputSchema: action.inputSchema, returns: action.returns, returnsSchema: action.returnsSchema, examples: action.examples, invariants: action.invariants, readOnly: action.readOnly, stream: action.stream ?? false }));
    }),
  );
  const base = result.filter(tool => config.web.enabled || !['read_webpage', 'search_web'].includes(tool.name));
  // Sharing reads the account's Qzone cookies and sends a message, so it follows the permissions of those interfaces.
  const shareable = () => allowed(findSnowLumaAction('get_cookies')) && ['send_private_msg', 'send_group_msg'].some(name => allowed(findSnowLumaAction(name)));
  return { faces, current: () => [...base.filter(tool => tool.name !== 'share_qzone_feed' || shareable()), ...snowlumaCatalog.filter(allowed).map(action => native.get(action.name)!)] };
}
