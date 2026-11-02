import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Action, EnvironmentEvent, MemoryKind } from './domain.js';
import type { ThoughtContext, ToolRuntime } from './tool-runtime.js';

export interface OnlineActivity { activity: string; tools: string[]; memoryKind?: MemoryKind }
export interface PluginTool extends AgentTool { insertBefore?: string }
export interface PluginImage {
  label: string;
  unavailable: string;
  deferred: string;
  autoView: boolean;
  load(signal?: AbortSignal): { data: Buffer; mimeType: string } | undefined | Promise<{ data: Buffer; mimeType: string } | undefined>;
  onShown?(): void;
}
/** One complete capability: tools and the hooks required to take part in the digital life's experiences. */
export interface LifePlugin {
  id: string;
  enabled?(): boolean;
  tools(runtime: ToolRuntime): PluginTool[];
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
  experienceKinds?: Record<string, string>;
  chatActions?: string[];
  images?(event: EnvironmentEvent): PluginImage[];
  resolveMedia?(value: string): string | undefined;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export class PluginHost {
  private started = false;
  private stopping?: Promise<void>;
  constructor(private plugins: readonly LifePlugin[] = []) {
    const ids = new Set<string>();
    for (const plugin of plugins) {
      if (ids.has(plugin.id)) throw new Error(`Duplicate plugin ID: ${plugin.id}`);
      ids.add(plugin.id);
    }
  }
  private enabled(plugin: LifePlugin) { return plugin.enabled?.() ?? true; }
  /** Bind once per thinking process; the primary process and review share plugin lifetimes, not thought state. */
  bind(runtime: ToolRuntime): (builtins: AgentTool[], following?: AgentTool[]) => AgentTool[] {
    const registered = this.plugins.map(plugin => ({ plugin, tools: plugin.tools(runtime).map(tool => ({ ...tool, execute: async (...args: Parameters<AgentTool['execute']>) => {
      runtime.check(args[2]);
      if (this.stopping) throw new Error('The program is shutting down; plugin tools are unavailable.');
      if (!this.enabled(plugin)) throw new Error(`Plugin ${plugin.id} is disabled or its required interfaces are unavailable.`);
      return tool.execute(...args);
    } })) }));
    // Reject conflicts even when a plugin is disabled, before any tool can execute.
    return (builtins, following = []) => {
      const names = new Set<string>();
      for (const tool of [...builtins, ...registered.flatMap(item => item.tools), ...following]) {
        if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
        names.add(tool.name);
      }
      const additions = registered.filter(item => this.enabled(item.plugin)).flatMap(item => item.tools);
      const ordered: AgentTool[] = [...builtins, ...additions, ...following];
      for (const tool of additions) if (tool.insertBefore && tool.insertBefore !== tool.name && ordered.some(item => item.name === tool.insertBefore)) {
        ordered.splice(ordered.findIndex(item => item === tool), 1);
        ordered.splice(ordered.findIndex(item => item.name === tool.insertBefore), 0, tool);
      }
      return ordered.map(tool => this.decorate(tool, runtime));
    };
  }
  decorate(original: AgentTool, runtime: ToolRuntime): AgentTool {
    let result = original;
    for (const plugin of this.plugins) if (this.enabled(plugin) && plugin.decorateTool) {
      const decorated = plugin.decorateTool(result, runtime);
      if (decorated.name !== result.name) throw new Error(`Plugin ${plugin.id} cannot rename tool ${result.name}.`);
      if (decorated === result) continue;
      result = { ...decorated, execute: async (...args: Parameters<AgentTool['execute']>) => {
        runtime.check(args[2]);
        if (this.stopping || !this.enabled(plugin)) throw new Error(`Plugin ${plugin.id} is disabled or stopping.`);
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
  activities(): OnlineActivity[] { return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.activities ?? []); }
  experienceKind(tool: string): string { return this.plugins.find(plugin => plugin.experienceKinds?.[tool])?.experienceKinds?.[tool] ?? `snowluma:${tool}`; }
  engagesChat(tool: string): boolean { return this.plugins.some(plugin => this.enabled(plugin) && plugin.chatActions?.includes(tool)); }
  images(event: EnvironmentEvent): PluginImage[] { return this.plugins.filter(plugin => this.enabled(plugin)).flatMap(plugin => plugin.images?.(event) ?? []); }
  /** Resolve references only in outgoing parameters; stored action arguments retain their small, stable IDs. */
  resolveMedia(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const plugin of this.plugins) if (this.enabled(plugin)) {
        const resolved = plugin.resolveMedia?.(value);
        if (resolved !== undefined) return resolved;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(item => this.resolveMedia(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.resolveMedia(item)]));
    return value;
  }
  async start() {
    if (this.started || this.stopping) throw new Error('The plugins have already started or stopped.');
    this.started = true;
    for (const plugin of this.plugins) if (this.enabled(plugin)) await plugin.start?.();
  }
  stop(): Promise<void> { return this.stopping ??= this.stopAll(); }
  private async stopAll() {
    const results = await Promise.allSettled(this.plugins.map(async plugin => plugin.stop?.()));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Plugins could not all be stopped.');
  }
}
