import { readFileSync } from 'node:fs';
import type { TSchema } from 'typebox';

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
// Upstream definitions are local dependencies under their own license, not project source.
// Both src/ and dist/ resolve this default to the checkout's ignored cache directory.
const catalogs = new Map<string, { source: Record<string, any>; actions: SnowLumaActionDefinition[] }>();
export function getSnowLumaCatalog(file = process.env.QIUYUE_SNOWLUMA_CATALOG || new URL('../../../.qiuyue-cache/snowluma/catalog.json', import.meta.url).pathname) {
  let catalog = catalogs.get(file);
  if (catalog) return catalog;
  try { catalog = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error('Cannot read the local SnowLuma catalog. See THIRD_PARTY_NOTICES.md, then run npm run sync:snowluma for permitted local use, or set QIUYUE_SNOWLUMA_CATALOG to an existing catalog file.', { cause: error }); }
  if (!catalog?.source || !Array.isArray(catalog.actions) || !catalog.actions.length) throw new Error('The local SnowLuma catalog must include source metadata and a non-empty actions array.');
  const names = new Set<string>();
  for (const action of catalog.actions) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(action.name) || names.has(action.name)) throw new Error(`Invalid or duplicate native action: ${action.name}`);
    if ((action.inputSchema as Record<string, unknown>)?.type !== 'object' || typeof action.readOnly !== 'boolean' || !Array.isArray(action.invariants)) throw new Error(`Invalid native action definition: ${action.name}`);
    names.add(action.name);
  }
  catalogs.set(file, catalog); return catalog;
}
export function nativeToolDescription(action: SnowLumaActionDefinition, usage?: string): string {
  return [action.summary, `SnowLuma native interface ${action.name}; ${action.readOnly ? 'read-only query' : 'may have side effects and is subject to action budgets and deduplication'}.`, ...action.invariants, action.returns, action.stream ? 'Streaming results return an array of raw data frames in arrival order.' : '', usage].filter(Boolean).join('\n');
}
/** The native target is also the chat an action engages. */
export function snowlumaChat(args: unknown): string | undefined {
  const { group_id: group, user_id: user, message_type: type } = (args ?? {}) as Record<string, unknown>;
  if (group != null && type !== 'private') return `group:${Number(group)}`;
  return user != null ? `private:${Number(user)}` : undefined;
}
export function findSnowLumaAction(name: string): SnowLumaActionDefinition {
  const action = getSnowLumaCatalog().actions.find(action => action.name === name);
  if (!action) throw new Error(`Unknown SnowLuma interface: ${name}`);
  return action;
}
export function allowedSnowLumaAction(action: SnowLumaActionDefinition, permissions: SnowLumaPermissions): boolean {
  return !permissions.deny.includes(action.name) && (permissions.allow === '*' || permissions.allow.includes(action.name));
}
