import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { Config } from './config.js';
import type { Action, EnvironmentEvent, Memory } from './domain.js';
import { Store, type RevisionReach } from './store.js';
import { ActionNotDispatchedError, definitelyFailed, nativeErrorResult, nativeToolName, type NativeActionDefinition } from './platform.js';
import type { AdapterInfo } from './plugin-sdk.js';
import { fetchImage } from './web.js';
import { mediaModality, mediaSeconds, type ContentBlock, type MediaContent } from './media.js';

export interface ToolImage {
  label: string;
  /** Optional alternate label used when viewed explicitly via view_event_image; defaults to label. */
  viewLabel?: string;
  unavailable: string;
  deferred: string;
  autoView: boolean;
  /** Plugin-produced pictures ('primary', default) are seen before incoming chat images ('message'). */
  priority?: 'primary' | 'message';
  /** If set, explicit lookup via resolveEventImage fails synchronously with this reason (e.g. missing URL). */
  missingReason?: string;
  load(signal?: AbortSignal): { data: Buffer; mimeType: string } | undefined | Promise<{ data: Buffer; mimeType: string } | undefined>;
  onShown?(): void;
}
/** A voice message, an audio file, or a video in an event, described before any of it is fetched (ADR-0029). */
export interface ToolMedia {
  kind: 'voice' | 'audio' | 'video';
  /** Where the platform says so; otherwise the bytes are asked once they are loaded. */
  seconds?: number;
  bytes?: number;
  /** If set, the media cannot be fetched at all, as when its message carries no address for it. */
  missingReason?: string;
  /** Fetch it in a form a model takes, refusing anything larger than `maxBytes`. */
  load(maxBytes: number, signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string; seconds?: number }>;
}
export const mediaLabel = (source: Pick<ToolMedia, 'kind'>, index: number, from: string) => `${source.kind} ${index} from ${from}`;
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;
/** Fetch one piece of media within the operator's limits, as the block a model perceives. */
export async function loadEventMedia(limits: { maxMediaBytes: number; maxMediaSeconds: number }, source: ToolMedia, signal?: AbortSignal): Promise<MediaContent> {
  if (source.missingReason) throw new Error(source.missingReason);
  const tooLarge = (bytes: number) => new Error(`This ${source.kind} is ${megabytes(bytes)}; at most ${megabytes(limits.maxMediaBytes)} can be perceived.`);
  const tooLong = (seconds: number) => new Error(`This ${source.kind} runs ${Math.round(seconds)}s; at most ${limits.maxMediaSeconds}s can be perceived.`);
  if (source.bytes !== undefined && source.bytes > limits.maxMediaBytes) throw tooLarge(source.bytes);
  if (source.seconds !== undefined && source.seconds > limits.maxMediaSeconds) throw tooLong(source.seconds);
  const loaded = await source.load(limits.maxMediaBytes, signal);
  if (loaded.data.byteLength > limits.maxMediaBytes) throw tooLarge(loaded.data.byteLength);
  const modality = mediaModality(loaded.mimeType);
  if (modality !== 'audio' && modality !== 'video') throw new Error(`Unsupported media format: ${loaded.mimeType || 'unknown'}.`);
  const seconds = loaded.seconds ?? source.seconds ?? mediaSeconds(loaded.data, loaded.mimeType);
  if (seconds !== undefined && seconds > limits.maxMediaSeconds) throw tooLong(seconds);
  return { type: 'media', mimeType: loaded.mimeType, data: loaded.data.toString('base64'), ...(seconds === undefined ? {} : { seconds: Math.round(seconds * 10) / 10 }) };
}
export interface ToolExtensions {
  resolveMedia(value: unknown, actionName?: string): unknown;
  decorate(original: AgentTool, runtime: ToolRuntime): AgentTool;
  nativeDefinition(name: string): NativeActionDefinition;
  nativeAllowed(name: string): boolean;
  hasNativeAllowed(name: string): boolean;
  nativeExecute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | undefined;
  adapters(): readonly AdapterInfo[];
  chatTarget(tool: string, args: unknown, staleOnly?: boolean): string | undefined;
  images(event: EnvironmentEvent): ToolImage[];
  media(event: EnvironmentEvent): ToolMedia[];
}
const emptyExtensions: ToolExtensions = {
  resolveMedia: value => value,
  decorate: original => original,
  nativeDefinition: name => { throw new Error(`Unknown native interface: ${name}`); },
  nativeAllowed: name => { throw new Error(`Unknown native interface: ${name}`); },
  hasNativeAllowed: () => false,
  nativeExecute: () => undefined,
  adapters: () => [],
  chatTarget: () => undefined,
  images: () => [],
  media: () => [],
};

/** Every http(s) URL in an event's strings, with HTML's &amp; decoded, so an image named in a tool result can be viewed or referenced by its exact URL. */
export function urlsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') for (const match of value.replaceAll('&amp;', '&').matchAll(/https?:\/\/[\w\-.~:/?#@!$&()*+,;=%]+/g)) found.add(match[0]);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) urlsIn(item, found);
  return found;
}

export interface ResolvedEventImage {
  event: EnvironmentEvent;
  label: string;
  url?: string;
  unavailable: string;
  load(signal?: AbortSignal): Promise<{ data: Buffer; mimeType: string }>;
  onShown?(): void;
}

/** Validate and resolve an image inside an event (plugin/adapter-provided or exact URL in payload), deferring any network read to load(). */
export function resolveEventImage(
  store: Store,
  plugins: Pick<ToolExtensions, 'images'>,
  args: { id: string; index?: number; url?: string },
  loadUrl: typeof fetchImage = fetchImage,
): ResolvedEventImage {
  if ((args.index === undefined) === (args.url === undefined)) throw new Error('Specify exactly one of index or url.');
  if (args.index !== undefined && (!Number.isSafeInteger(args.index) || args.index < 0)) throw new Error('Image index must be a non-negative integer.');
  const event = store.event(store.resolve(args.id));
  if (!event) throw new Error('The experience does not exist or has been deleted.');
  if (args.index !== undefined) {
    const provided = plugins.images(event)[args.index];
    if (!provided) throw new Error('The image does not exist or has no readable URL.');
    if (provided.missingReason) throw new Error(provided.missingReason);
    return {
      event, label: provided.viewLabel ?? provided.label, unavailable: provided.unavailable, onShown: provided.onShown,
      load: async signal => {
        const picture = await provided.load(signal);
        if (!picture) throw new Error(provided.unavailable);
        return picture;
      },
    };
  }
  const url = String(args.url).replaceAll('&amp;', '&');
  if (!urlsIn(event.payload).has(url)) throw new Error('That URL does not appear in the event.');
  return {
    event, url, label: `Image ${url} from event ${event.id}`, unavailable: 'The image could not be read.',
    load: async signal => {
      const result = await loadUrl(url, signal);
      return { data: result.data, mimeType: result.type };
    },
  };
}

/** Find one piece of media inside an event, deferring any network read to load(). */
export function resolveEventMedia(store: Store, plugins: Pick<ToolExtensions, 'media'>, args: { id: string; index?: number }): { event: EnvironmentEvent; index: number; source: ToolMedia } {
  const index = args.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Media index must be a non-negative integer.');
  const event = store.event(store.resolve(args.id));
  if (!event) throw new Error('The experience does not exist or has been deleted.');
  const source = plugins.media(event)[index];
  if (!source) throw new Error('That event has no voice message, audio, or video at this index.');
  return { event, index, source };
}

/** A review hands revisions affecting unfinished matters back to the conversations (ADR-0012). */
export interface ThoughtContext { generation: number; sources: Set<string>; triggers: Set<string>; lifeOnly: boolean; reviewing?: boolean; /** A review that goes back over old memories (ADR-0027). */ revisiting?: boolean; handedOn?: { memory: Memory; reach: RevisionReach }[] }
export function ensureCurrent(store: Store, context: ThoughtContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const settings = store.settings();
  if (settings.paused || context.generation !== settings.generation) throw new Error('The run is paused or management state changed; a new reasoning run is required.');
  if (context.lifeOnly && !settings.lifeEnabled) throw new Error('Autonomous life is disabled.');
}
export const errorResult = nativeErrorResult;
/** What a tool learns of its action: the receipt, not the ledger row, whose source list alone can run to tens of kilobytes. */
const receipt = ({ id, status, result }: Action) => ({ id, status, result });
/** What a tool answers with. Pi's result type knows text and images; audio, video and documents pass through its loop as they are (ADR-0029). */
export type ToolResult = Omit<AgentToolResult<any>, 'content'> & { content: ContentBlock[] };
export const jsonResult = (result: unknown): AgentToolResult<any> => ({ content: [{ type: 'text', text: JSON.stringify(result) }], details: {} });

/** Shared execution rules for built-in and plugin tools. Plugins never create their own action receipts. */
export class ToolRuntime {
  constructor(readonly config: Config, readonly store: Store, readonly context: () => ThoughtContext, private extensions: ToolExtensions = emptyExtensions, private namespace?: string) {}
  scoped(instance: string) { return new ToolRuntime(this.config, this.store, this.context, this.extensions, instance); }
  private name(name: string) { return this.namespace ? nativeToolName(this.namespace, name) : name; }
  private dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const result = this.extensions.nativeExecute(this.name(name), args, signal);
    if (!result) throw new ActionNotDispatchedError(`Unknown native interface: ${name}`);
    return result;
  }
  adapters() { return this.extensions.adapters(); }
  resolveMedia(value: unknown, actionName?: string): unknown { return this.extensions.resolveMedia(value, actionName ? this.name(actionName) : undefined); }
  resolveEventImage(args: { id: string; index?: number; url?: string }): ResolvedEventImage { return resolveEventImage(this.store, this.extensions, args); }
  resolveEventMedia(args: { id: string; index?: number }) { return resolveEventMedia(this.store, this.extensions, args); }
  decorate(tool: AgentTool): AgentTool {
    const decorated = this.extensions.decorate({ ...tool, name: this.name(tool.name) }, this);
    return { ...decorated, name: tool.name };
  }
  check(signal?: AbortSignal) { ensureCurrent(this.store, this.context(), signal); }
  allowed(name: string) { return this.extensions.nativeAllowed(this.name(name)); }
  hasAllowed(name: string) { return this.extensions.hasNativeAllowed(this.name(name)); }
  definition(name: string) {
    const definition = this.extensions.nativeDefinition(this.name(name));
    if (!definition) throw new Error(`Unknown native interface: ${name}`);
    return definition;
  }
  tool(name: string, description: string, parameters: TSchema, execute: (args: any, signal?: AbortSignal) => Promise<ToolResult> | ToolResult): AgentTool {
    return { name, label: name, description, parameters, executionMode: 'sequential', replay: 'never', execute: async (_callId, args, signal) => {
      this.check(signal);
      return await execute(args, signal) as AgentToolResult<any>;
    } };
  }
  jsonTool(name: string, description: string, parameters: TSchema, execute: (args: any, signal?: AbortSignal) => Promise<unknown> | unknown): AgentTool {
    return this.tool(name, description, parameters, async (args, signal) => jsonResult(await execute(args, signal)));
  }
  record(kind: string, result: unknown, origin?: 'self' | 'external') {
    this.check();
    const event = this.store.receive({ key: `tool:${crypto.randomUUID()}`, kind, at: Date.now(), text: JSON.stringify(result), payload: { result, ...(origin ? { origin } : {}) } }, true)!;
    this.context().sources.add(event.id);
    return { sourceId: event.id, result };
  }
  async query(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    this.check(signal);
    if (!this.allowed(name)) throw new Error('The operator has not enabled this native interface.');
    const result = await this.dispatch(name, args, signal);
    this.check(signal);
    return result;
  }
  /** Non-QQ actions use the same ledger and budget; a dispatched failure cannot be assumed safe to repeat. */
  async externalAction(name: string, args: Record<string, unknown>, dispatch: () => Promise<unknown>, signal?: AbortSignal) {
    this.check(signal);
    const attempt = this.store.beginAction(`${this.name(name)}:${crypto.randomUUID()}`, this.name(name), args, [...this.context().sources], [...this.context().triggers], this.config.limits.actionsPerHour, this.extensions.chatTarget?.(this.name(name), args));
    if (attempt.fresh) {
      let dispatched = false;
      try { this.check(signal); dispatched = true; this.store.finishAction(attempt.action.id, 'success', await dispatch()); }
      // A callback that gave up before sending anything says so; whatever else it throws may follow a request that went out (ADR-0008).
      catch (error) { this.store.finishAction(attempt.action.id, dispatched && (error as { dispatched?: unknown } | null)?.dispatched !== false ? 'unknown' : 'failed', errorResult(error)); }
    }
    return { outcome: receipt(this.store.actionById(attempt.action.id)!), reused: !attempt.fresh };
  }
  /** Preparation may read through query; only dispatch can perform the recorded external action. */
  async action(name: string, args: Record<string, unknown>, perform: (dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>, signal?: AbortSignal, failure = errorResult, conversation?: string) {
    this.check(signal);
    const target = () => conversation ?? this.extensions.chatTarget?.(this.name(name), args);
    const attempt = this.store.beginAction(`${this.name(name)}:${crypto.randomUUID()}`, this.name(name), args, [...this.context().sources], [...this.context().triggers], this.config.limits.actionsPerHour, target());
    if (attempt.fresh) {
      let dispatched: string | undefined;
      try {
        const result = await perform(async (action, parameters) => {
          this.check(signal);
          if (!this.allowed(action)) throw new Error('The operator has not enabled this native interface.');
          dispatched = this.definition(action).name;
          return this.dispatch(action, parameters, signal);
        });
        this.store.finishAction(attempt.action.id, 'success', result, target());
      } catch (error) {
        this.store.finishAction(attempt.action.id, dispatched === undefined || definitelyFailed(error, dispatched) ? 'failed' : 'unknown', failure(error));
      }
    }
    return { outcome: receipt(this.store.actionById(attempt.action.id)!), reused: !attempt.fresh };
  }
}
