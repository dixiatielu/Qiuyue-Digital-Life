import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from './config.js';
import { Store } from './store.js';
import type { SocialAdapter } from './platform.js';
import { fetchImage } from './web.js';
import { actionSummary } from './runtime-context.js';
import { ChatRecord } from './record.js';
import type { SemanticRecall } from './recall.js';
import { PluginHost } from './plugins.js';
import { createPlugins } from './plugins/index.js';
import { ensureCurrent, ToolRuntime, type ThoughtContext } from './tool-runtime.js';
export { ensureCurrent, type ThoughtContext } from './tool-runtime.js';

const string = (description: string, maxLength = 6000) => Type.String({ description, minLength: 1, maxLength });
/** Every http(s) URL in an event's strings, with HTML's &amp; decoded, so an image named in a tool result can be viewed by its exact URL. */
function urlsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const match of value.replaceAll('&amp;', '&').matchAll(/https?:\/\/[\w\-.~:/?#@!$&()*+,;=%]+/g)) found.add(match[0]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) urlsIn(item, found);
  return found;
}
export interface ToolSet { current(): AgentTool[]; readonly plugins: PluginHost }
/** A review reads what happened and keeps what it learns, and schedules a commitment it finds still owed; it sends nothing, and activity and life plans stay with the conversations (ADR-0012). */
const reviewTools = new Set(['read_chat_record', 'read_event', 'view_event_image', 'recall', 'inspect_actions', 'remember', 'retire_memory', 'schedule_activity']);
export function forReview(tools: ToolSet): ToolSet {
  return { plugins: tools.plugins, current: () => tools.current().filter(tool => reviewTools.has(tool.name) || tools.plugins.reviewAllowed(tool.name)) };
}

export function createTools(config: Config, store: Store, social: SocialAdapter, context: () => ThoughtContext, recall?: SemanticRecall, plugins = createPlugins(config, store, social, recall)): ToolSet {
  const runtime = new ToolRuntime(config, store, social, context, plugins);
  const tool = runtime.jsonTool.bind(runtime);
  const withPlugins = plugins.bind(runtime);
  const result: AgentTool[] = [
    {
      name: 'view_event_image', label: 'view_event_image', description: 'View an image in an original event. Use index (starting at 0) for an image in a message, or index 0 for the picture of a drawing event; use url for an image URL in any other event, such as a Qzone post in a tool result. Specify exactly one. Only read an image URL actually present in that event.',
      parameters: Type.Object({ id: string('Event ID', 100), index: Type.Optional(Type.Integer({ minimum: 0 })), url: Type.Optional(string('Image URL as it appears in the event', 2000)) }), replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        if ((args.index === undefined) === (args.url === undefined)) throw new Error('Specify exactly one of index or url.');
        const event = store.event(store.resolve(args.id));
        if (!event) throw new Error('The experience does not exist or has been deleted.');
        const provided = args.index !== undefined ? plugins.images(event)[args.index] : undefined;
        if (provided) {
          const picture = await provided.load(signal);
          if (!picture) throw new Error(provided.unavailable);
          ensureCurrent(store, context(), signal);
          context().sources.add(event.id);
          provided.onShown?.();
          return { content: [{ type: 'text', text: provided.label }, { type: 'image', data: picture.data.toString('base64'), mimeType: picture.mimeType }], details: {} };
        }
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
    tool('remember', 'Save experiences, understandings, diary entries, or your own development, based on real sources. Include source IDs; #xxxxxxxx refs from read_chat_record work too. Use supersedes to preserve revisions. Use fiction for permitted fictional life and note for personal diary entries and notes; set fictional when a note or other entry includes fictional daily life. For development, habit is a way of acting or expressing yourself that you keep, and practice is what the people around you do in which situations; both hold everywhere unless scope is group:<id> for what belongs to that group alone. impression is your current understanding of one person and your relationship with them, including what they want from you and how they talk with you (scope person:<qq>; one per person, revised with supersedes); what you saw in one person alone goes there, not in a habit or practice. The result of a revision lists the memories that rested on the old version and left everyday recall with it (withdrawn), and the plans, pursuits, or activity under way that cite it (cites); revise or finish those that no longer hold.', Type.Object({ kind: Type.Union(['experience', 'understanding', 'fiction', 'note', 'habit', 'practice', 'impression'].map(x => Type.Literal(x))), title: string('Short title or note name', 200), content: string('Specific experience, understanding, note, or development', 12000), importance: Type.Integer({ minimum: 1, maximum: 10 }), sources: Type.Array(string('Supporting event or memory ID', 100), { maxItems: 50 }), subjects: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), supersedes: Type.Optional(string('ID of the previous memory being updated', 100)), scope: Type.Optional(string('global, conversation:<canonical conversation reference>, or person:<canonical person reference>; legacy group:<id> and person:<qq> are accepted.', 1024)), fictional: Type.Optional(Type.Boolean({ description: 'The content includes fictional daily life' })) }), args => {
      // What it wrote is in the call; what the revision reached is all the result adds.
      const reach = args.supersedes ? store.revisionReach(args.supersedes) : undefined;
      const memory = store.writeMemory(args, config.life.allowFiction, config.development);
      // A review cannot revise what is under way, so the conversations hear of what cites the old version, all at once when the review ends.
      const handedOn = context().reviewing && reach?.cites.length;
      if (handedOn) (context().handedOn ??= []).push({ memory, reach });
      return { id: memory.id, kind: memory.kind, ...(memory.scope ? { scope: memory.scope } : {}), ...(memory.supersedes ? { supersedes: memory.supersedes } : {}), ...(memory.fictional ? { fictional: true } : {}), ...(reach?.withdrawn.length ? { withdrawn: reach.withdrawn } : {}), ...(reach?.cites.length ? { cites: reach.cites } : {}), ...(handedOn ? { citesHandedOn: 'Your conversations hear of these when this review ends and revise or finish them; a review cannot.' } : {}) };
    }),
    tool('retire_memory', 'Retire a habit, practice, or impression that no longer holds. It leaves everyday use; its history remains.', Type.Object({ id: string('Memory ID', 100) }), args => store.retireMemory(args.id)),
    {
      name: 'read_chat_record', label: 'read_chat_record',
      description: "Read the complete record of a group or private chat in time order: everyone's messages, your own, reactions, recalls, and pokes, as they happened. Without from, it starts where your last review stopped; only a review's reading moves that point forward. from reads forward from any time. query or person instead returns the latest items containing a phrase or written by one person. Results are folded out of working context when the thought ends; read again whenever needed. It looks back over what happened; new messages come to you as observations by themselves, so it is not a way to watch for them.",
      parameters: Type.Object({ conversation: string('Conversation reference from an event; platform:account:group|private|channel|thread:id. Legacy group:<id> and private:<id> remain readable.', 1024), from: Type.Optional(string('ISO time with timezone to read forward from', 100)), query: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), person: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.String({ description: 'Use self for your own actions, or a canonical person reference from an event', maxLength: 1024 })])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        const record = new ChatRecord(store, config.snowluma.selfId, args.conversation, await plugins.emojiNames(undefined, signal), undefined, action => plugins.actionCaption(action));
        const limit = args.limit ?? config.development.recordLines;
        if (args.query || args.person) return { content: [{ type: 'text', text: record.matches(limit, { query: args.query, person: args.person }) }], details: {} };
        if (args.from && (!/(Z|[+-]\d{2}:\d{2})$/.test(args.from) || !Number.isFinite(Date.parse(args.from)))) throw new Error('from must be an ISO time with a timezone.');
        const mark = store.reviewMark(args.conversation);
        const from = args.from ? Date.parse(args.from) : mark;
        const page = record.page(from, limit);
        // Only a review moves the review point, a jump ahead included, since skipping is its choice; a conversation looking back would make it skip lines unread (ADR-0012).
        if (page.through !== undefined && context().reviewing) store.markReviewed(args.conversation, page.through);
        // Reading on past the end would only wait for what comes anyway, which is how a conversation falls into polling.
        const caughtUp = page.next === undefined && !context().reviewing;
        return { content: [{ type: 'text', text: caughtUp ? `${page.text}\nNewer messages come to you by themselves; you need not read again to wait for them. If you just want to read along, as people lurk (潜水) in a group, reply empty.` : page.text }], details: {} };
      },
    },
    tool('set_activity', 'Record or clear the current activity.', Type.Object({ activity: Type.String({ maxLength: 2000 }) }), args => { store.setActivity(args.activity, [...context().sources]); return store.settings(); }),
    tool('schedule_activity', 'Schedule a life activity or an accepted social commitment.', Type.Object({ title: string('Activity and associated people or groups', 1000), kind: Type.Union([Type.Literal('life'), Type.Literal('commitment')]), at: string('ISO time with timezone, for example 2026-10-28T09:00:00+08:00', 100), rest: Type.Optional(Type.Boolean({ description: 'You rest until this activity, as when going to sleep or taking a nap: no free-time wake comes before it, and group chat reaches you only where someone mentions, replies to, or pokes you' })) }), args => {
      const dueAt = Date.parse(args.at);
      if (!/(Z|[+-]\d{2}:\d{2})$/.test(args.at)) throw new Error('The time must include a timezone.');
      if (context().reviewing && (args.kind !== 'commitment' || args.rest)) throw new Error('A review schedules only commitments it finds still owed; life plans and rest belong to your conversations.');
      if (args.kind === 'life' && !store.settings().lifeEnabled) throw new Error('Life mode is disabled; life activities cannot be started.');
      if (dueAt < Date.now() + config.life.minWakeMs) throw new Error('The wake interval is too short; adjust the plan.');
      return store.schedule(args.title, args.kind, dueAt, [...context().sources], args.rest);
    }),
    tool('finish_activity', 'End a commitment or life plan: use status="done" when finished or "cancelled" when cancelled. "completed" is accepted as an alias of "done".', Type.Object({ id: string('Activity ID', 100), status: Type.Union([Type.Literal('done'), Type.Literal('cancelled'), Type.Literal('completed')]) }), args => { store.finishWake(args.id, args.status === 'completed' ? 'done' : args.status); return store.wakes(); }),
    tool('update_pursuit', "Start something you pursue over days, such as a song you are learning, a series you follow, or a hobby project, or record where one stands now. Without id it starts a pursuit; with id it replaces that pursuit's progress. Setbacks and stalls are progress too.", Type.Object({ id: Type.Optional(string('ID of the pursuit to update', 100)), title: string('What you are pursuing', 200), progress: string('Where it stands now', 1000), fictional: Type.Boolean({ description: 'It belongs to fictional daily life' }) }), args => {
      if (!store.settings().lifeEnabled) throw new Error('Life mode is disabled; pursuits cannot be started or advanced.');
      return store.updatePursuit(args, [...context().sources], config.life.allowFiction);
    }),
    tool('finish_pursuit', 'End a pursuit: done when it is finished, dropped when you have given it up.', Type.Object({ id: string('Pursuit ID', 100), status: Type.Union([Type.Literal('done'), Type.Literal('dropped')]) }), args => { store.finishPursuit(args.id, args.status); return store.pursuits(); }),
  ];
  return { plugins, current: () => withPlugins(result) };
}
