import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { EnvironmentEvent, MemoryKind } from './domain.js';
import type { ToolRuntime } from './tool-runtime.js';

export interface OnlineActivity { activity: string; tools: string[]; memoryKind?: MemoryKind }
export interface PluginImage {
  label: string;
  unavailable: string;
  deferred: string;
  autoView: boolean;
  load(signal?: AbortSignal): { data: Buffer; mimeType: string } | undefined | Promise<{ data: Buffer; mimeType: string } | undefined>;
}
/** One complete capability: tools and the hooks required to take part in the digital life's experiences. */
export interface LifePlugin {
  id: string;
  enabled?(): boolean;
  tools(runtime: ToolRuntime): AgentTool[];
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
      return [...builtins, ...registered.filter(item => this.enabled(item.plugin)).flatMap(item => item.tools), ...following];
    };
  }
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
