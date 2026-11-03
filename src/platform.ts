import type { TSchema } from 'typebox';
import { createHash } from 'node:crypto';

/** A native API operation. The host never narrows its parameters to a shared chat API. */
export interface NativeActionDefinition {
  name: string;
  summary?: string;
  category?: string;
  inputSchema: TSchema;
  readOnly: boolean;
  stream?: boolean;
  invariants: string[];
  returns?: string;
  returnsSchema?: Record<string, unknown>;
  examples?: { summary: string; params: Record<string, unknown>; notes?: string }[];
}
export interface ToolPermissions { allow: '*' | string[]; deny: string[] }
export const permits = (permissions: ToolPermissions, name: string): boolean =>
  !permissions.deny.includes(name) && (permissions.allow === '*' || permissions.allow.includes(name));

/** Stable model names; full native identifiers remain in the catalog and dispatch map. */
export function nativeToolName(instance: string, operation: string): string {
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(instance)) throw new Error('Adapter instance IDs must use 1–24 lowercase letters, digits, or underscores.');
  if (typeof operation !== 'string' || !operation || operation.length > 512) throw new Error('Native operation identifiers must contain 1–512 characters.');
  const readable = `${instance}__${operation.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  return readable.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(operation) ? readable
    : `${readable.slice(0, 51)}_${createHash('sha256').update(operation).digest('hex').slice(0, 12)}`;
}

export interface SocialAdapter {
  execute(action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  definition?(action: string): NativeActionDefinition;
  allowed?(action: string): boolean;
}

/** These outcomes describe evidence about dispatch, not whether the caller should retry. */
export class ActionNotDispatchedError extends Error {}
export class NativeApiError extends Error {
  constructor(readonly response: unknown, message: string, private outcome: 'failed' | 'unknown' = 'unknown') { super(message); }
  definitelyFailed(_action?: string): boolean { return this.outcome === 'failed'; }
}
export const definitelyFailed = (error: unknown, action?: string): boolean =>
  error instanceof ActionNotDispatchedError || error instanceof NativeApiError && error.definitelyFailed(action);
export const nativeErrorResult = (error: unknown): unknown => error instanceof NativeApiError
  ? error.response : { message: error instanceof Error ? error.message : String(error) };
