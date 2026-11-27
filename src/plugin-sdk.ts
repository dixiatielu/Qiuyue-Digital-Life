/** Public interface v2. User plugins need not import runtime code: export a plain PluginDefinition. */
export type JsonSchema = { type?: string; [key: string]: unknown };
export interface PluginEvent {
  id: string; kind: string; at: number; text: string; payload: unknown; source?: import('./identity.js').EventSource;
}
export interface PluginActionResult {
  outcome: { id: string; status: 'pending' | 'success' | 'failed' | 'unknown'; result: unknown };
  reused: boolean;
}
export interface AdapterInfo {
  readonly instance: string;
  readonly platform: string;
  readonly accountId: string;
}
export interface AdapterInspector {
  list(): readonly AdapterInfo[];
  allowed(instance: string, operation: string): boolean;
}
export interface UserChatTarget {
  instance: string;
  type: import('./identity.js').ConversationType;
  id: string;
}
export interface PluginCall {
  readonly signal: AbortSignal;
  readonly reviewing: boolean;
  record(kind: string, result: unknown): { sourceId: string; result: unknown };
  /** Attach actual images to this tool response. URLs must occur in a source recorded by this invocation. */
  attachImages(sourceId: string, urls: string[]): Promise<{ attached: string[]; failed: { url: string; error: string }[]; omitted: string[] }>;
  /** External writes are recorded before dispatch; errors after dispatch leave an unknown outcome. A callback that gives up before sending anything throws an error whose `dispatched` property is `false`, and the attempt is recorded as failed. */
  action(kind: string, args: Record<string, unknown>, dispatch: (signal: AbortSignal) => Promise<unknown>): Promise<PluginActionResult>;
  adapters: AdapterInspector & {
    query(instance: string, operation: string, args: Record<string, unknown>): Promise<unknown>;
    action(instance: string, operation: string, args: Record<string, unknown>): Promise<PluginActionResult>;
    /** Record one plugin action keyed by stable args, prepare via queries, then dispatch at most one native adapter operation. Failures before dispatch are definite (`failed`); errors after dispatch follow ADR-0008. */
    perform(
      kind: string,
      args: Record<string, unknown>,
      run: (dispatch: (instance: string, operation: string, parameters: Record<string, unknown>) => Promise<unknown>, signal: AbortSignal) => Promise<unknown>,
      options?: { target?: UserChatTarget },
    ): Promise<PluginActionResult>;
  };
}
export interface UserTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  readOnly?: boolean;
  /** The local kind passed to call.record; lets activity suggestions show the last real experience. */
  experienceKind?: string;
  /** Only explicitly read-only tools may be offered during memory review. */
  review?: boolean;
  /** Dynamically gate tool availability against currently enabled adapters and permissions. */
  available?(adapters: AdapterInspector): boolean;
  /** Identify the chat targeted by a call so steering, stale checks, and action records bind to that conversation. */
  chatTarget?(args: any, adapters: AdapterInspector): UserChatTarget | undefined;
  /** Skip execution if a newer addressed message arrived in chatTarget before this call started. */
  stale?: boolean;
  /** End the thought once a batch made only of ending actions succeeds. */
  endsThought?: boolean;
  execute(args: any, call: PluginCall): unknown | Promise<unknown>;
}
export interface UserActivity {
  activity: string;
  /** Alternative ways to take part; offered while at least one tool is available. */
  tools: string[];
  /** Stable activity guidance, injected into system instructions while available. No persona or changing state. */
  instructions?: string;
}
export interface PluginContext {
  readonly id: string;
  readonly settings: Readonly<Record<string, any>>;
  readonly directory: string;
  readonly dataDirectory: string;
  readonly signal: AbortSignal;
  credential(name: string): string | undefined;
  tool(tool: UserTool): void;
  /** Register an entire native API catalog during setup. */
  adapter(adapter: NativeAdapterDefinition): void;
  observe(provider: (events: readonly PluginEvent[]) => string[]): void;
  activity(activity: UserActivity): void;
  /** Begins after activation. Calls never overlap and are drained before reload. */
  every(ms: number, work: (signal: AbortSignal) => void | Promise<void>): void;
  /** Start work from a tool, return immediately, then publish its result as an observation. */
  background(work: (signal: AbortSignal) => void | Promise<void>): void;
  publish(event: { key: string; kind: string; text: string; origin: 'self' | 'external'; data?: unknown }): void;
  storage: { get<T = unknown>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void };
  log(level: 'info' | 'warn' | 'error', message: string): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
/** Optional plugin.json sidecar. Safe to inspect without importing executable code. */
export interface PluginManifest {
  id: string;
  apiVersion: 2;
  name?: string;
  version?: string;
  description?: string;
  /** Bump for semantic changes not visible in tool declarations or activity instructions. */
  contextVersion?: string;
  defaults?: Record<string, unknown>;
  configSchema?: JsonSchema;
  /** Applies when config.plugins[id] is absent. Existing plugins default to enabled. */
  defaultEnabled?: boolean;
}
export interface PluginDefinition extends PluginManifest {
  /** Declare resources here. Host-managed timers and background work begin only after activation. */
  setup(context: PluginContext): void | Promise<void>;
}
export const definePlugin = <T extends PluginDefinition>(definition: T): T => definition;

/** Resolved local media asset passed to platform adapters for native encoding (e.g. multipart upload or base64 URI). */
export interface AdapterMediaAsset {
  readonly data: Uint8Array;
  readonly mimeType: string;
  readonly path?: string;
  readonly filename?: string;
}
/** Stable platform identity is independent of the adapter implementation. */
export interface NativeAdapterDefinition {
  instance: string;
  platform: string;
  accountId: string;
  /** Exact API/catalog version, not the agent version. */
  version: string;
  actions: { name: string; summary?: string; inputSchema: JsonSchema; readOnly: boolean; invariants?: string[] }[];
  /** Operations in everyday use. When given, the others are loaded on demand where the model's API can do that; every operation stays callable either way. */
  frequent?: string[];
  /** Operations skipped when a newer addressed message arrives in the same chat before they run (ADR-0002). */
  staleActions?: string[];
  /** Operations that end the thought once a batch made only of ending actions succeeds (ADR-0028). */
  endsThoughtActions?: string[];
  permissions?: { allow: '*' | string[]; deny: string[] };
  execute(operation: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  conversation?(operation: string, args: Record<string, unknown>): { type: import('./identity.js').ConversationType; id: string } | undefined;
  /** Encode a resolved local media reference (such as a gallery drawing ID) into this platform's native parameter format. */
  encodeMedia?(media: AdapterMediaAsset): unknown;
  /** Images come from the event's actual native media, and are loaded only when shown. */
  images?(event: PluginEvent): { label: string; autoView?: boolean; load(signal: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> }[];
  start?(context: AdapterContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}
export interface AdapterContext {
  signal: AbortSignal;
  publish(event: {
    key: string; kind: string; at?: number; text: string; payload: Record<string, unknown>;
    conversation?: { type: import('./identity.js').ConversationType; id: string };
    actor?: string; actorName?: string; own?: boolean; addressed?: boolean;
    attention?: 'normal' | 'ambient' | 'transport';
  }): void;
  storage: PluginContext['storage'];
}
