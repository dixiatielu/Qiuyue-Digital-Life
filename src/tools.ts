import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from './config.js';
import { Store, entryTitle } from './store.js';
import type { EnvironmentEvent } from './domain.js';
import { fetchImage } from './web.js';
import { actionSummary } from './runtime-context.js';
import { ChatRecord } from './record.js';
import type { SemanticRecall } from './recall.js';
import { PluginHost, type PluginTool } from './plugins.js';
import { createPlugins } from './plugins/index.js';
import { ensureCurrent, ToolRuntime, type ThoughtContext } from './tool-runtime.js';
import { validatedMemoryTool } from './memory-tool.js';
import { loadsToolsOnDemand, type ModelOwner } from './model.js';
export { ensureCurrent, type ThoughtContext } from './tool-runtime.js';

const string = (description: string, maxLength = 6000) => Type.String({ description, minLength: 1, maxLength });
/** Every http(s) URL in an event's strings, with HTML's &amp; decoded, so an image named in a tool result can be viewed by its exact URL. */
function urlsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const match of value.replaceAll('&amp;', '&').matchAll(/https?:\/\/[\w\-.~:/?#@!$&()*+,;=%]+/g)) found.add(match[0]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) urlsIn(item, found);
  return found;
}
export const FIND_TOOLS = 'find_tools';
export interface ToolSet {
  /** Every enabled tool: what the digital life may do. */
  current(): AgentTool[];
  /** What a model call declares. Where a tool can be declared mid-conversation, the deferred tools not yet loaded are left out (ADR-0023); elsewhere this is current(). */
  declared(): AgentTool[];
  /** The deferred tools, loaded or not, as the instructions list them. Empty where nothing is deferred. */
  deferred(): { name: string; summary: string }[];
  readonly loading: {
    /** Whether seldom-used tools wait to be asked for. */
    readonly enabled: boolean;
    /** Take what a working context declares as what is loaded: nothing for a new one, its declared tools for a restored one. */
    restore(declared: Iterable<string>): void;
    /** Load one deferred tool; false when it is not one or is loaded already. */
    add(name: string): boolean;
  };
  /** The same tools narrowed to those a filter keeps, loading on their own for the model that will use them. */
  only(keep: (tool: AgentTool) => boolean, owner: ModelOwner): ToolSet;
  readonly plugins: PluginHost;
}
/** A review reads what happened and keeps what it learns, and schedules a commitment it finds still owed; it sends nothing, and activity and life plans stay with the conversations (ADR-0012). */
const reviewTools = new Set(['read_chat_record', 'read_context', 'read_event', 'view_event_image', 'recall', 'inspect_actions', 'remember', 'retire_memory', 'schedule_activity', FIND_TOOLS]);
export function forReview(tools: ToolSet): ToolSet {
  return tools.only(tool => reviewTools.has(tool.name) || tools.plugins.reviewAllowed(tool.name), 'review');
}

export function createTools(config: Config, store: Store, context: () => ThoughtContext, recall?: SemanticRecall, plugins = createPlugins(config, store, recall)): ToolSet {
  /** What bounds her own writes; operator corrections pass none. */
  const limits = { ...config.development, experienceChars: config.memory.experienceChars };
  const runtime = new ToolRuntime(config, store, context, plugins);
  const tool = runtime.jsonTool.bind(runtime);
  const withPlugins = plugins.bind(runtime);
  const builtins: AgentTool[] = [
    {
      name: 'view_event_image', label: 'view_event_image', description: 'View an image in an original event. Use index (starting at 0) for an image in a message, or index 0 for a generated image in a drawing event; use url for an image URL in any other event, such as a Qzone post in a tool result. Specify exactly one. Only read an image URL actually present in that event.',
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
    tool('recall', `Search for long-term understandings, important experiences, or personal notes${recall ? ', by meaning and by exact words such as names or QQ numbers' : ''}; historical versions are available. Or read without searching: id reads one memory in full, such as one runtime_data lists by title, and scope reads everything you keep in one place, person:<canonical person ref> for all you know of someone.`, Type.Object({ query: Type.Optional(Type.String({ maxLength: 500 })), id: Type.Optional(string('ID of one memory to read in full', 100)), scope: Type.Optional(string('person:<canonical person ref>, conversation:<canonical conversation ref>, or global', 1024)), subjects: Type.Optional(Type.Array(Type.String())), historical: Type.Optional(Type.Boolean()) }), async (args, signal) => {
      const one = args.id ? store.memory(args.id) : undefined;
      if (args.id && !one) throw new Error('That memory does not exist or has been forgotten.');
      if (!args.id && !args.scope && !args.query?.trim()) throw new Error('Give a query to search for, an id to read, or a scope to read.');
      const memories = one ? [one] : args.scope ? store.development([args.scope]) : recall ? await recall.search(args.query, config.memory.recallLimit, args.subjects ?? [], args.historical ?? false, signal) : store.search(args.query, config.memory.recallLimit, args.subjects ?? [], args.historical ?? false);
      ensureCurrent(store, context(), signal);
      for (const memory of memories) context().sources.add(memory.id);
      store.noteRecalled('deliberate', memories.map(memory => ({ id: memory.id })), context().reviewing ? { reviewing: true } : {});
      return memories;
    }),
    validatedMemoryTool(tool('remember', `Supply kind and content. In a conversation that is enough to keep something as it is said: sources default to the messages in front of you, title to the opening of the content, and importance to 5; give any of them yourself when it should be otherwise. A memory review gives its sources itself. Content budgets: an experience tells one thing that happened in at most ${config.memory.experienceChars} characters, under a title that names it, with the events of that thing as its sources; a habit, practice, or impression entry says one thing in at most ${config.development.entryChars} characters, and the entries of one kind in one scope, or about one person, share ${config.development.scopeChars}, excluding the version replaced with supersedes. Characters are Unicode code points, including spaces and punctuation. Keep some room below the limit. Of what you keep about a person, the entries you gave the most importance come with each thought, up to ${config.development.personChars} characters, and the others are listed by title, so give each a title you would look for it by. An impression entry says one thing about a person or about the two of you, such as a trait, a preference, who a nickname means, where they live, or what they asked of you; save detailed episodes as experiences. Save experiences, understandings, diary entries, or your own development, based on real sources. For every memory kind, put supporting source IDs only in the sources field. Never put source IDs or references such as #xxxxxxxx in content. Copy IDs into sources exactly as read; short #xxxxxxxx references from read_chat_record are valid there without expansion. Never reconstruct a full ID or invent one. Use supersedes to preserve revisions. Use fiction for permitted fictional life and note for personal diary entries and notes; set fictional when a note or other entry includes fictional daily life. For development, habit is a way of acting or expressing yourself that you keep, and practice is what the people around you do in which situations; both hold everywhere unless scope is conversation:<canonical ref> for what belongs to that group alone. impression is your current understanding of one person and your relationship with them, including what they want from you and how they talk with you (scope person:<platform>:user:<id>; several entries per person, each revised alone with supersedes); what you saw in one person alone goes there, not in a habit or practice. Each habit, practice, or thing you know of a person is an entry of its own, so that it can be revised, checked against its evidence, and retired alone: to change one, supersede that entry with the evidence for the change and leave the others as they are. The result of a revision lists the memories that rested on the old version and left everyday recall with it (withdrawn), and the plans, pursuits, or activity under way that cite it (cites); revise or finish those that no longer hold.`, Type.Object({ kind: Type.Union(['experience', 'understanding', 'fiction', 'note', 'habit', 'practice', 'impression'].map(x => Type.Literal(x))), title: Type.Optional(string('Short title you would look for it by; the opening of the content when left out', 200)), content: string(`Evidence-backed content. For every memory kind, keep source IDs and #xxxxxxxx references out of this content; put them only in sources. Experience: at most ${config.memory.experienceChars} Unicode code points. Habit, practice, or impression: at most ${config.development.entryChars} per entry and ${config.development.scopeChars} in total per kind and scope. Other kinds: 12000.`, 12000), importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: '5 when left out' })), sources: Type.Optional(Type.Array(string('Supporting event or memory ID, copied exactly; short #xxxxxxxx references are accepted here. Left out in a conversation, the messages in front of you.', 100), { maxItems: 50 })), subjects: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })), supersedes: Type.Optional(string('ID of the previous memory being updated', 100)), scope: Type.Optional(string('global, conversation:<canonical conversation reference>, or person:<canonical person reference>.', 1024)), fictional: Type.Optional(Type.Boolean({ description: 'The content includes fictional daily life' })) }), args => {
      // What it wrote is in the call; what the revision reached is all the result adds.
      const reach = args.supersedes ? store.revisionReach(args.supersedes) : undefined;
      // Kept as it is said, a memory rests on what the thought is looking at: of those events, the ones from the person or chat it is about, or all of them (ADR-0028).
      const defaulted: string[] = [];
      if (!args.sources?.length && !context().reviewing) {
        const inView = [...context().triggers].map(eventId => store.event(eventId)).filter((event): event is EnvironmentEvent => event !== undefined);
        const scope = typeof args.scope === 'string' ? args.scope : '';
        const about = inView.filter(event => scope.startsWith('person:') ? event.source?.actor === scope.slice('person:'.length) : scope.startsWith('conversation:') ? event.source?.conversation === scope.slice('conversation:'.length) : true);
        args.sources = (about.length ? about : inView).map(event => event.id); defaulted.push('sources');
      }
      if (!args.sources) args.sources = [];
      if (typeof args.title !== 'string' || !args.title.trim()) { args.title = entryTitle(String(args.content ?? '')); defaulted.push('title'); }
      if (args.importance === undefined || args.importance === null) { args.importance = 5; defaulted.push('importance'); }
      // Going back over an old memory changes how it is kept more often than what it says: what rested on it stays, and the conversations are not woken for it (ADR-0027).
      const revisiting = context().revisiting === true;
      const memory = store.writeMemory(args, config.life.allowFiction, limits, revisiting);
      // What a review writes while going back over memories has just been checked against the record.
      if (revisiting) store.markRevisited([memory.id]);
      // Where each memory was written, and how much of it was left to defaults, shows whether things are kept as they are said.
      store.log('remembered', { id: memory.id, kind: memory.kind, where: context().reviewing ? 'review' : 'conversation', ...(defaulted.length ? { defaulted } : {}) });
      // A review cannot revise what is under way, so the conversations hear of what cites the old version, all at once when the review ends.
      const handedOn = context().reviewing && !revisiting && reach?.cites.length;
      if (handedOn) (context().handedOn ??= []).push({ memory, reach });
      return { id: memory.id, kind: memory.kind, ...(memory.scope ? { scope: memory.scope } : {}), ...(memory.supersedes ? { supersedes: memory.supersedes } : {}), ...(memory.fictional ? { fictional: true } : {}), ...(reach?.withdrawn.length ? revisiting ? { stillRestingOnOldVersion: reach.withdrawn } : { withdrawn: reach.withdrawn } : {}), ...(reach?.cites.length ? { cites: reach.cites } : {}), ...(handedOn ? { citesHandedOn: 'Your conversations hear of these when this review ends and revise or finish them; a review cannot.' } : {}) };
    }), store, limits),
    tool('retire_memory', 'Retire a habit, practice, or impression that no longer holds. It leaves everyday use; its history remains.', Type.Object({ id: string('Memory ID', 100) }), args => store.retireMemory(args.id)),
    {
      name: 'read_chat_record', label: 'read_chat_record',
      description: "Read the complete record of a group or private chat in time order: everyone's messages, your own, reactions, recalls, and pokes, as they happened. Without from, it starts where your last review stopped; only a review's reading moves that point forward. from reads forward from any time. query or person instead returns the latest items containing a phrase or written by one person. Results are folded out of working context when the thought ends; read again whenever needed. It looks back over what happened; new messages come to you as observations by themselves, so it is not a way to watch for them.",
      parameters: Type.Object({ conversation: string('Conversation reference from an event; platform:account:group|private|channel|thread:id. ', 1024), from: Type.Optional(string('ISO time with timezone to read forward from', 100)), query: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), person: Type.Optional(Type.String({ description: 'Use self for your own actions, or a canonical person reference from an event', maxLength: 1024 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      replay: 'never', executionMode: 'sequential',
      execute: async (_callId, args: any, signal) => {
        ensureCurrent(store, context(), signal);
        const record = new ChatRecord(store, args.conversation, await plugins.emojiNames(undefined, signal), undefined, action => plugins.actionCaption(action));
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
        return { content: [{ type: 'text', text: caughtUp ? `${page.text}\nNewer messages come to you by themselves; you need not read again to wait for them. If you just want to read along, as people lurk (潜水) in a group, end your thought without a tool call.` : page.text }], details: {} };
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
  return view(() => true, 'main');

  /** One thinking process's hold on the tools: what it may use, and which of the deferred ones it has loaded. */
  function view(visible: (tool: AgentTool) => boolean, owner: ModelOwner): ToolSet {
    const enabled = loadsToolsOnDemand(config, owner);
    const loaded = new Set<string>();
    const all = () => withPlugins(builtins, [finder]).filter(visible);
    /** The instructions name each activity's tools, and a model calls a tool it has been told of by name without asking for it first, so those are never deferred. */
    const deferrable = (tools: AgentTool[]) => {
      if (!enabled) return new Set<string>();
      const named = new Set(plugins.activities().flatMap(activity => activity.tools));
      return new Set(tools.filter(tool => (tool as PluginTool).defer && !named.has(tool.name)).map(tool => tool.name));
    };
    const add = (name: string) => enabled && !loaded.has(name) && deferrable(all()).has(name) && !!loaded.add(name);
    const finder = tool(FIND_TOOLS, enabled
      ? 'Make tools listed in your instructions as loaded on demand callable, and read any tool\'s detailed documentation: results, examples, and constraints. Pass every name you need at once. A tool loaded here is callable from your next step and stays available.'
      : 'Read a tool\'s detailed documentation by name: results, examples, and constraints. Every tool is already callable.',
    Type.Object({ names: Type.Array(string('Tool name', 100), { minItems: 1, maxItems: 8 }) }), args => {
      const tools = all();
      const found: Record<string, unknown>[] = []; const unknown: { name: string; similar: string[] }[] = [];
      for (const asked of new Set<string>(args.names)) {
        // A native operation may be asked for without its account's prefix where only one account offers it.
        const bare = tools.filter(item => item.name.endsWith(`__${asked}`));
        const match = tools.find(item => item.name === asked) ?? (bare.length === 1 ? bare[0] : undefined);
        if (!match) {
          const word = asked.toLowerCase().replace(/^.*__/, '');
          unknown.push({ name: asked, similar: tools.filter(item => item.name.toLowerCase().includes(word)).slice(0, 5).map(item => item.name) });
          continue;
        }
        const documentation = (match as PluginTool).documentation?.();
        found.push({ name: match.name, status: add(match.name) ? 'loaded' : 'available', description: match.description, ...(documentation === undefined ? {} : { documentation }) });
      }
      return {
        tools: found,
        ...(unknown.length ? { unknown, hint: 'An unknown tool does not exist or the operator has not enabled it.' } : {}),
        ...(found.some(item => item.status === 'loaded') ? { note: 'Loaded tools are callable from your next step and stay available.' } : {}),
      };
    });
    return {
      plugins, current: all,
      declared: () => { const tools = all(); const waiting = deferrable(tools); return tools.filter(item => !waiting.has(item.name) || loaded.has(item.name)); },
      deferred: () => { const tools = all(); const waiting = deferrable(tools); return tools.filter(item => waiting.has(item.name)).map(item => ({ name: item.name, summary: item.description.split('\n', 1)[0]!.slice(0, 120) })); },
      loading: {
        enabled, add,
        restore: declared => { const waiting = deferrable(all()); loaded.clear(); for (const name of declared) if (waiting.has(name)) loaded.add(name); },
      },
      only: (keep, reviewer) => view(item => visible(item) && keep(item), reviewer),
    };
  }
}
