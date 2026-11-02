import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import { SnowLumaApiError } from '@snowluma/sdk';
import type { Config } from './config.js';
import { errorText, type Memory } from './domain.js';
import { Store, type RevisionReach } from './store.js';
import { definitelyFailed, type SocialAdapter } from './snowluma.js';
import { allowedSnowLumaAction, findSnowLumaAction, type SnowLumaActionDefinition } from './snowluma-catalog.js';

/** A review hands revisions affecting unfinished matters back to the conversations (ADR-0012). */
export interface ThoughtContext { generation: number; sources: Set<string>; triggers: Set<string>; lifeOnly: boolean; reviewing?: boolean; handedOn?: { memory: Memory; reach: RevisionReach }[] }
export function ensureCurrent(store: Store, context: ThoughtContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const settings = store.settings();
  if (settings.paused || context.generation !== settings.generation) throw new Error('The run is paused or management state changed; a new reasoning run is required.');
  if (context.lifeOnly && !settings.lifeEnabled) throw new Error('Autonomous life is disabled.');
}
export const errorResult = (error: unknown): unknown => error instanceof SnowLumaApiError ? error.response : { message: errorText(error) };
export const jsonResult = (result: unknown): AgentToolResult<any> => ({ content: [{ type: 'text', text: JSON.stringify(result) }], details: {} });
export function nativeToolDescription(action: SnowLumaActionDefinition, usage?: string): string {
  return [action.summary, `SnowLuma native interface ${action.name}; ${action.readOnly ? 'read-only query' : 'may have side effects and is subject to action budgets and deduplication'}.`, ...action.invariants, action.returns, action.stream ? 'Streaming results return an array of raw data frames in arrival order.' : '', usage].filter(Boolean).join('\n');
}

/** Shared execution rules for built-in and plugin tools. Plugins never create their own action receipts. */
export class ToolRuntime {
  constructor(readonly config: Config, readonly store: Store, private social: SocialAdapter, readonly context: () => ThoughtContext) {}
  check(signal?: AbortSignal) { ensureCurrent(this.store, this.context(), signal); }
  allowed(name: string) { return allowedSnowLumaAction(findSnowLumaAction(name), this.config.snowluma.tools); }
  tool(name: string, description: string, parameters: TSchema, execute: (args: any, signal?: AbortSignal) => Promise<AgentToolResult<any>> | AgentToolResult<any>): AgentTool {
    return { name, label: name, description, parameters, executionMode: 'sequential', replay: 'never', execute: async (_callId, args, signal) => {
      this.check(signal);
      return execute(args, signal);
    } };
  }
  jsonTool(name: string, description: string, parameters: TSchema, execute: (args: any, signal?: AbortSignal) => Promise<unknown> | unknown): AgentTool {
    return this.tool(name, description, parameters, async (args, signal) => jsonResult(await execute(args, signal)));
  }
  record(kind: string, result: unknown) {
    this.check();
    const event = this.store.receive({ key: `tool:${crypto.randomUUID()}`, kind, at: Date.now(), text: JSON.stringify(result), payload: { result } }, true)!;
    this.context().sources.add(event.id);
    return { sourceId: event.id, result };
  }
  async query(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    this.check(signal);
    if (!this.allowed(name)) throw new Error('The operator has not enabled this SnowLuma interface.');
    const result = await this.social.execute(name, args, signal);
    this.check(signal);
    return result;
  }
  /** Preparation may read through query; only dispatch can perform the recorded external action. */
  async action(name: string, args: Record<string, unknown>, perform: (dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>, signal?: AbortSignal, failure = errorResult) {
    this.check(signal);
    const attempt = this.store.beginAction(`${name}:${crypto.randomUUID()}`, name, args, [...this.context().sources], [...this.context().triggers], this.config.limits.actionsPerHour);
    if (attempt.fresh) {
      let dispatched: string | undefined;
      try {
        const result = await perform(async (action, parameters) => {
          this.check(signal);
          if (!this.allowed(action)) throw new Error('The operator has not enabled this SnowLuma interface.');
          dispatched = action;
          return this.social.execute(action, parameters, signal);
        });
        this.store.finishAction(attempt.action.id, 'success', result);
      } catch (error) {
        this.store.finishAction(attempt.action.id, dispatched === undefined || definitelyFailed(error, dispatched) ? 'failed' : 'unknown', failure(error));
      }
    }
    return { outcome: this.store.actionById(attempt.action.id)!, reused: !attempt.fresh };
  }
}
