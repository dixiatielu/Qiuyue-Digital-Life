import { SNOWLUMA_ACTIONS } from '@snowluma/sdk';
import type { TSchema } from 'typebox';
import generated from './generated/snowluma-catalog.json' with { type: 'json' };

export interface SnowLumaActionDefinition {
  name: string;
  category?: string;
  summary?: string;
  readOnly: boolean;
  stream?: boolean;
  inputSchema: TSchema;
  invariants: string[];
  returns?: string;
  returnsSchema?: Record<string, unknown>;
  examples?: { summary: string; params: Record<string, unknown>; notes?: string }[];
}
export interface SnowLumaPermissions { allow: '*' | string[]; deny: string[] }
export function nativeToolDescription(action: SnowLumaActionDefinition, usage?: string): string {
  return [action.summary, `SnowLuma native interface ${action.name}; ${action.readOnly ? 'read-only query' : 'may have side effects and is subject to action budgets and deduplication'}.`, ...action.invariants, action.returns, action.stream ? 'Streaming results return an array of raw data frames in arrival order.' : '', usage].filter(Boolean).join('\n');
}
/** The native target is also the chat an action engages. */
export function snowlumaChat(args: unknown): string | undefined {
  const { group_id: group, user_id: user, message_type: type } = (args ?? {}) as Record<string, unknown>;
  if (group != null && type !== 'private') return `group:${Number(group)}`;
  return user != null ? `private:${Number(user)}` : undefined;
}
export const snowlumaCatalog = generated.actions as unknown as SnowLumaActionDefinition[];
export const snowlumaCatalogSource = generated.source;
const definitions = new Map<string, SnowLumaActionDefinition>();
const sdkNames = new Set<string>(SNOWLUMA_ACTIONS);
for (const action of snowlumaCatalog) {
  if (!sdkNames.has(action.name)) throw new Error('The SnowLuma SDK and interface catalog do not match; run npm run sync:snowluma and review the changes.');
  if (definitions.has(action.name)) throw new Error(`Duplicate SnowLuma tool name: ${action.name}`);
  definitions.set(action.name, action);
}
export function findSnowLumaAction(name: string): SnowLumaActionDefinition {
  const action = definitions.get(name);
  if (!action) throw new Error(`Unknown SnowLuma interface: ${name}`);
  return action;
}
export function allowedSnowLumaAction(action: SnowLumaActionDefinition, permissions: SnowLumaPermissions): boolean {
  return !permissions.deny.includes(action.name) && (permissions.allow === '*' || permissions.allow.includes(action.name));
}
