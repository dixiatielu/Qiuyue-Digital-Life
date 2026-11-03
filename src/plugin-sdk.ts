/** Public interface v1. User plugins need not import runtime code: export a plain PluginDefinition. */
export type JsonSchema = { type?: string; [key: string]: unknown };
export interface PluginEvent {
  id: string; kind: string; at: number; text: string; groupId?: number; actorId?: number; payload: unknown;
}
export interface PluginCall {
  readonly signal: AbortSignal;
  readonly reviewing: boolean;
  record(kind: string, result: unknown): { sourceId: string; result: unknown };
  /** External writes are recorded before dispatch; errors after dispatch leave an unknown outcome. */
  action(kind: string, args: Record<string, unknown>, dispatch: (signal: AbortSignal) => Promise<unknown>): Promise<unknown>;
  snowluma: {
    query(name: string, args: Record<string, unknown>): Promise<unknown>;
    action(name: string, args: Record<string, unknown>): Promise<unknown>;
  };
}
export interface UserTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  readOnly?: boolean;
  /** Only explicitly read-only tools may be offered during memory review. */
  review?: boolean;
  execute(args: any, call: PluginCall): unknown | Promise<unknown>;
}
export interface PluginContext {
  readonly id: string;
  readonly settings: Readonly<Record<string, any>>;
  readonly directory: string;
  readonly dataDirectory: string;
  readonly signal: AbortSignal;
  credential(name: string): string | undefined;
  tool(tool: UserTool): void;
  observe(provider: (events: readonly PluginEvent[]) => string[]): void;
  activity(activity: { activity: string; tools: string[] }): void;
  /** Begins after activation. Calls never overlap and are drained before reload. */
  every(ms: number, work: (signal: AbortSignal) => void | Promise<void>): void;
  /** Start work from a tool, return immediately, then publish its result as an observation. */
  background(work: (signal: AbortSignal) => void | Promise<void>): void;
  publish(event: { key: string; kind: string; text: string; origin: 'self' | 'external'; data?: unknown }): void;
  storage: { get<T = unknown>(key: string, fallback?: T): T | undefined; set(key: string, value: unknown): void };
  log(level: 'info' | 'warn' | 'error', message: string): void;
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface PluginDefinition {
  id: string;
  apiVersion: 1;
  name?: string;
  version?: string;
  description?: string;
  /** Bump when observation or activity meaning changes while tool declarations stay the same. */
  contextVersion?: string;
  defaults?: Record<string, unknown>;
  configSchema?: JsonSchema;
  /** Declare resources here. Host-managed timers and background work begin only after activation. */
  setup(context: PluginContext): void | Promise<void>;
}
export const definePlugin = <T extends PluginDefinition>(definition: T): T => definition;
