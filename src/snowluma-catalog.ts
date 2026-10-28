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
