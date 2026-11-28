import type { NativeActionDefinition } from './platform.js';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Action, EnvironmentEvent, MemoryKind } from './domain.js';
import type { ThoughtContext, ToolImage, ToolRuntime } from './tool-runtime.js';
import type { Store } from './store.js';
import type { DisplayProjector } from './display-message.js';
import type { ChatRecordFormatter } from './record-format.js';
import { waitFor } from './async.js';
import type { AdapterMediaAsset, UserActivity } from './plugin-sdk.js';
import type { ActivityPrompt } from './prompts.js';
import { sanitizeToolSchema } from './schema.js';
export type { ActivityPrompt } from './prompts.js';

export interface OnlineActivity extends UserActivity {
  memoryKind?: MemoryKind;
  insertBefore?: string;
  currentValue?: { tool: string; read(args: Record<string, unknown>): unknown };
}
function availableActivities(activities: OnlineActivity[], available: ReadonlySet<string>) {
  return activities.map(item => ({ ...item, tools: item.tools.filter(name => available.has(name)) })).filter(item => item.tools.length);
}
export interface PluginTool extends AgentTool {
  insertBefore?: string; available?(): boolean;
  /** Seldom used. Where a tool can be declared to the model mid-conversation, it is listed by name and declared when the model asks for it (ADR-0023); elsewhere it is declared from the start like any other. */
  defer?: boolean;
  /** What find_tools adds to the declaration when asked about this tool: results, examples, constraints, or parameter prose the declaration leaves out. */
  documentation?(): unknown;
}
export type PluginImage = ToolImage;
export interface ImageHelpers {
  imageCaption(image: Record<string, unknown>): string;
}
export interface ResolvedMedia extends AdapterMediaAsset {
  readonly data: Buffer;
}
export type MediaEncoder = (media: ResolvedMedia) => unknown;
export const encodeBase64Uri: MediaEncoder = media => `base64://${media.data.toString('base64')}`;
/** One complete capability: tools and the hooks required to take part in the digital life's experiences. */
export interface LifePlugin {
  id: string;
  /** User plugins bump this when their observation/meaning contract changes without changing tool declarations. */
  contextVersion?: string;
  /** Exclusive platform consumers need a restart instead of overlapping reload lifetimes. */
  requiresRestart?: boolean;
  /** A platform account the operator configured. The daemon does not start without it, where an optional plugin that fails is only left out. */
  essential?: boolean;
  enabled?(): boolean;
  tools(runtime: ToolRuntime): PluginTool[];
  nativeActions?: { accounts?: readonly import('./identity.js').PlatformIdentity[]; instances?: readonly import('./plugin-sdk.js').AdapterInfo[]; definition(name: string): NativeActionDefinition | undefined; allowed(name: string): boolean; execute?(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>; encodeMedia?(name: string, media: ResolvedMedia): unknown };
  reviewTools?: string[];
  emojiNames?(events?: EnvironmentEvent[], signal?: AbortSignal): Record<string, string> | Promise<Record<string, string>>;
  knownEmojiNames?(): Record<string, string>;
  supplementalImages?(events: EnvironmentEvent[], thought: ThoughtContext): PluginImage[];
  imageViewer?(label: string): string | undefined;
  /** Enhance a registered tool in place; its name and the original execution rules remain intact. */
  decorateTool?(tool: AgentTool, runtime: ToolRuntime): AgentTool;
  observation?(events: EnvironmentEvent[], thought: ThoughtContext): string[];
  imageCaption?(image: Record<string, unknown>): string | undefined;
  actionCaption?(action: Action): string | undefined;
  endsThought?(tool: string, details: unknown): boolean;
  activities?: OnlineActivity[];
  /** Brief platform-specific guidance injected into system instructions while this plugin is enabled. */
  promptNotes?: string[];
  experienceKinds?: Record<string, string>;
  chatActions?: string[];
  staleActions?: string[];
  chatTarget?(tool: string, args: unknown): string | undefined;
  /** Group or channel conversations tracked for life-wake quietness awareness (ADR-0014). */
  trackedConversations?(store: Store): string[];
  images?(event: EnvironmentEvent, helpers?: ImageHelpers): PluginImage[];
  resolveMedia?(value: string): string | ResolvedMedia | undefined;
  /** Map a plugin-owned media reference (e.g. drawing:<uuid>) to a browser-safe relative preview URL. */
  mediaPreviewUrl?(value: string): string | undefined;
  /** Optional inert display projector for live monitoring (Monitor / WebUI / TUI). */
  display?: DisplayProjector;
  /** Optional conversation record formatter for chat records and observations. */
  recordFormatter?: ChatRecordFormatter;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Stop scheduling background work while a replacement is prepared; return a resume function. */
  quiesce?(): () => void;
  idle?(): Promise<void>;
  /** Operator-only commands, dispatched by the daemon; never exposed as model tools. */
  manage?(command: string, args: Record<string, any>): unknown;
}

export class PluginHost {
  private started = false;
  private stopping?: Promise<void>;
  private validators: ((plugins: readonly LifePlugin[]) => void)[] = [];
  constructor(private plugins: readonly LifePlugin[] = []) {
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
      ids.add(plugin.id);
    }
    this.validate(plugins);
  }
  private enabled(plugin: LifePlugin) { return plugin.enabled?.() ?? true; }
  installed(): readonly LifePlugin[] { return this.plugins; }
  validate(plugins: readonly LifePlugin[]) {
    const accounts = new Set<string>();
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
      ids.add(plugin.id);
    }
    for (const plugin of plugins) for (const account of plugin.nativeActions?.accounts ?? []) { const key = `${account.platform}:${account.accountId}`; if (accounts.has(key)) throw new Error(`Duplicate platform account: ${key}`); accounts.add(key); }
    for (const validate of this.validators) validate(plugins);
  }
  /** The caller has drained both brains and started the candidates before this synchronous commit. */
  install(plugins: readonly LifePlugin[]) { this.validate(plugins); this.plugins = plugins; }
  nativeDefinition(name: string): NativeActionDefinition {
    for (const plugin of this.plugins) { const definition = plugin.nativeActions?.definition(name); if (definition) return definition; }
    throw new Error(`Unknown native interface: ${name}`);
  }
  /** Whether a tool is a native operation that only reads; false for any other tool. */
  readOnlyNative(name: string): boolean {
    for (const plugin of this.plugins) { const definition = plugin.nativeActions?.definition(name); if (definition) return definition.readOnly; }
    return false;
  }
  adapters(): import('./plugin-sdk.js').AdapterInfo[] {
    return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.nativeActions?.instances ?? []);
  }
  nativeAllowed(name: string): boolean {
    for (const plugin of this.plugins) if (plugin.nativeActions?.definition(name)) return (!plugin.nativeActions.execute || this.enabled(plugin)) && plugin.nativeActions.allowed(name);
    throw new Error(`Unknown native interface: ${name}`);
  }
  hasNativeAllowed(name: string): boolean {
    for (const plugin of this.plugins) if (plugin.nativeActions?.definition(name)) return (!plugin.nativeActions.execute || this.enabled(plugin)) && plugin.nativeActions.allowed(name);
    return false;
  }
  nativeExecute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> | undefined {
    for (const plugin of this.plugins) if (plugin.nativeActions?.definition(name) && plugin.nativeActions.execute) {
      if (!this.enabled(plugin)) throw new Error(`Adapter ${plugin.id} is disabled.`);
      return plugin.nativeActions.execute(name, args, signal);
    }
  }
  enabledIds(): string[] { return this.plugins.filter(plugin => this.enabled(plugin)).map(plugin => plugin.id); }
  manage(id: string, command: string, args: Record<string, any>) {
    const plugin = this.plugins.find(plugin => plugin.id === id);
    if (this.stopping || !plugin || !this.enabled(plugin) || !plugin.manage) throw new Error(`Plugin ${id} is unavailable for management.`);
    return plugin.manage(command, args);
  }
  /** Bind once per thinking process; the primary process and review share plugin lifetimes, not thought state. */
  bind(runtime: ToolRuntime): (builtins: AgentTool[], following?: AgentTool[]) => AgentTool[] {
    const cache = new WeakMap<LifePlugin, PluginTool[]>();
    const register = (plugin: LifePlugin) => {
      let tools = cache.get(plugin);
      if (tools) return { plugin, tools };
      tools = plugin.tools(runtime).map(tool => ({ ...tool, parameters: sanitizeToolSchema(tool.parameters), execute: async (...args: Parameters<AgentTool['execute']>) => {
        runtime.check(args[2]);
        if (this.stopping) throw new Error('The program is shutting down; plugin tools are unavailable.');
        if (!this.plugins.includes(plugin)) throw new Error(`Plugin ${plugin.id} was reloaded; this tool belongs to an old version.`);
        if (!this.enabled(plugin)) throw new Error(`Plugin ${plugin.id} is disabled or its required interfaces are unavailable.`);
        if (tool.available && !tool.available()) throw new Error('The operator has not enabled this tool.');
        return tool.execute(...args);
      } }));
      cache.set(plugin, tools);
      return { plugin, tools };
    };
    // Reject conflicts even when a plugin is disabled, before any tool can execute.
    const build = (plugins: readonly LifePlugin[], builtins: AgentTool[], following: AgentTool[]) => {
      const registered = plugins.map(register);
      const names = new Set<string>();
      for (const tool of [...builtins, ...registered.flatMap(item => item.tools), ...following]) {
        if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
        names.add(tool.name);
      }
      const additions = registered.filter(item => this.enabled(item.plugin)).flatMap(item => item.tools).filter(tool => tool.available?.() ?? true);
      const ordered: AgentTool[] = [...builtins, ...additions, ...following];
      for (const tool of additions) if (tool.insertBefore && tool.insertBefore !== tool.name && ordered.some(item => item.name === tool.insertBefore)) {
        ordered.splice(ordered.findIndex(item => item === tool), 1);
        ordered.splice(ordered.findIndex(item => item.name === tool.insertBefore), 0, tool);
      }
      // A decorator builds its own tool object; whether the tool is deferred and what documents it stay with the plugin that offers it.
      return ordered.map(tool => {
        const decorated: PluginTool = this.decorate(tool, runtime, plugins); const { defer, documentation }: PluginTool = tool;
        return decorated.defer === defer && decorated.documentation === documentation ? decorated : { ...decorated, defer, documentation };
      });
    };
    let base: AgentTool[] = [], after: AgentTool[] = [];
    this.validators.push(plugins => { build(plugins, base, after); });
    return (builtins, following = []) => { base = builtins; after = following; return build(this.plugins, builtins, following); };
  }
  decorate(original: AgentTool, runtime: ToolRuntime, plugins = this.plugins): AgentTool {
    let result = original;
    for (const plugin of plugins) if (this.enabled(plugin) && plugin.decorateTool) {
      const decorated = plugin.decorateTool(result, runtime);
      if (decorated.name !== result.name) throw new Error(`Plugin ${plugin.id} cannot rename tool ${result.name}.`);
      if (decorated === result) continue;
      result = { ...decorated, parameters: sanitizeToolSchema(decorated.parameters), execute: async (...args: Parameters<AgentTool['execute']>) => {
        runtime.check(args[2]);
        if (this.stopping || !this.plugins.includes(plugin) || !this.enabled(plugin)) throw new Error(`Plugin ${plugin.id} is disabled, reloaded, or stopping.`);
        return decorated.execute(...args);
      } };
    }
    return result;
  }
  observation(events: EnvironmentEvent[], thought: ThoughtContext): string[] { return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.observation?.(events, thought) ?? []); }
  reviewAllowed(tool: string): boolean { return this.plugins.some(plugin => this.enabled(plugin) && plugin.reviewTools?.includes(tool)); }
  async emojiNames(events?: EnvironmentEvent[], signal?: AbortSignal): Promise<Record<string, string>> {
    return Object.assign({}, ...await Promise.all(this.plugins.filter(plugin => this.enabled(plugin)).map(plugin => plugin.emojiNames?.(events, signal) ?? {})));
  }
  knownEmojiNames(): Record<string, string> { return Object.assign({}, ...this.plugins.filter(plugin => this.enabled(plugin)).map(plugin => plugin.knownEmojiNames?.() ?? {})); }
  supplementalImages(events: EnvironmentEvent[], thought: ThoughtContext): PluginImage[] { return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.supplementalImages?.(events, thought) ?? []); }
  imageViewer(label: string): string | undefined {
    for (const plugin of this.plugins) if (this.enabled(plugin)) { const tool = plugin.imageViewer?.(label); if (tool) return tool; }
  }
  imageCaption(image: Record<string, unknown>): string { return this.plugins.filter(plugin => this.enabled(plugin)).map(plugin => plugin.imageCaption?.(image) ?? '').join(''); }
  actionCaption(action: Action): string | undefined {
    for (const plugin of this.plugins) if (this.enabled(plugin)) { const caption = plugin.actionCaption?.(action); if (caption !== undefined) return caption; }
  }
  endsThought(tool: string, details: unknown): boolean { return this.plugins.some(plugin => this.enabled(plugin) && plugin.endsThought?.(tool, details)); }
  activities(builtins: OnlineActivity[] = [], available?: ReadonlySet<string>): OnlineActivity[] {
    const additions = this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.activities ?? []);
    const ordered = [...builtins, ...additions];
    for (const activity of additions) if (activity.insertBefore && ordered.some(item => item.activity === activity.insertBefore)) {
      ordered.splice(ordered.indexOf(activity), 1);
      ordered.splice(ordered.findIndex(item => item.activity === activity.insertBefore), 0, activity);
    }
    return available ? availableActivities(ordered, available) : ordered;
  }
  /** The same availability rules as life wakes, reading registered guidance without observation providers. */
  activityPrompts(available: ReadonlySet<string>): ActivityPrompt[] {
    return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin =>
      availableActivities(plugin.activities ?? [], available).flatMap(({ activity, tools, instructions }) =>
        instructions?.trim() ? [{ plugin: plugin.id, activity, tools, instructions }] : []));
  }
  /** Brief platform-specific guidance contributed by enabled adapters and plugins, deduplicated in order. */
  platformNotes(): string[] {
    const seen = new Set<string>();
    const notes: string[] = [];
    for (const plugin of this.plugins) {
      if (!this.enabled(plugin)) continue;
      for (const raw of plugin.promptNotes ?? []) {
        const note = raw.trim();
        if (note && !seen.has(note)) { seen.add(note); notes.push(note); }
      }
    }
    return notes;
  }
  experienceKind(tool: string): string { return this.plugins.find(plugin => plugin.experienceKinds?.[tool])?.experienceKinds?.[tool] ?? tool; }
  chatTarget(tool: string, args: unknown, staleOnly = false): string | undefined {
    for (const plugin of this.plugins) if (this.enabled(plugin) && (staleOnly ? plugin.staleActions : plugin.chatActions)?.includes(tool)) {
      const chat = plugin.chatTarget?.(tool, args); if (chat) return chat;
    }
  }
  trackedConversations(store: Store): string[] {
    return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.trackedConversations?.(store) ?? []);
  }
  displayProjectors(): DisplayProjector[] {
    return this.plugins.filter(plugin => this.enabled(plugin) && plugin.display).map(plugin => plugin.display!);
  }
  recordFormatters(): ChatRecordFormatter[] {
    return this.plugins.filter(plugin => this.enabled(plugin) && plugin.recordFormatter).map(plugin => plugin.recordFormatter!);
  }
  mediaPreviewUrl(value: string): string | undefined {
    for (const plugin of this.plugins) if (this.enabled(plugin)) {
      const url = plugin.mediaPreviewUrl?.(value);
      if (url !== undefined) return url;
    }
  }
  images(event: EnvironmentEvent): PluginImage[] {
    const helpers: ImageHelpers = { imageCaption: image => this.imageCaption(image) };
    return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.images?.(event, helpers) ?? []);
  }
  private mediaEncoder(actionName?: string): MediaEncoder {
    if (actionName) {
      for (const plugin of this.plugins) {
        if (this.enabled(plugin) && plugin.nativeActions?.definition(actionName) && plugin.nativeActions.encodeMedia) {
          const encode = plugin.nativeActions.encodeMedia;
          return media => encode(actionName, media);
        }
      }
    }
    return encodeBase64Uri;
  }
  /** Resolve references only in outgoing parameters; stored action arguments retain their small, stable IDs. */
  resolveMedia(value: unknown, actionName?: string): unknown {
    return this.resolveMediaWith(value, this.mediaEncoder(actionName));
  }
  private resolveMediaWith(value: unknown, encode: MediaEncoder): unknown {
    if (typeof value === 'string') {
      for (const plugin of this.plugins) if (this.enabled(plugin)) {
        const resolved = plugin.resolveMedia?.(value);
        if (resolved !== undefined) return typeof resolved === 'string' ? resolved : encode(resolved);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.resolveMediaWith(item, encode));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveMediaWith(item, encode)]));
    return value;
  }
  async start(onError?: (plugin: LifePlugin, error: unknown) => void) {
    if (this.started || this.stopping) throw new Error('The plugins have already started or stopped.');
    this.started = true;
    for (const plugin of [...this.plugins]) if (this.enabled(plugin)) {
      try { await plugin.start?.(); }
      catch (error) {
        // Left out, a configured account would leave the digital life running deaf with no reconnection and a different tool set.
        if (!onError || plugin.essential) throw error;
        this.plugins = this.plugins.filter(item => item !== plugin);
        try { await waitFor(Promise.resolve(plugin.stop?.()), AbortSignal.timeout(5000)); } catch { /* the original startup error is reported */ }
        onError(plugin, error);
      }
    }
  }
  stop(): Promise<void> { return this.stopping ??= this.stopAll(); }
  private async stopAll() {
    const results = await Promise.allSettled(this.plugins.map(async plugin => plugin.stop?.()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Plugins could not all be stopped.');
  }
}
