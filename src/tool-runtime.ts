import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';
import type { Config } from './config.js';
import { errorText, type Memory } from './domain.js';
import { Store, type RevisionReach } from './store.js';
import { definitelyFailed, nativeErrorResult, nativeToolName, type SocialAdapter } from './platform.js';
import type { PluginHost } from './plugins.js';

/** A review hands revisions affecting unfinished matters back to the conversations (ADR-0012). */
export interface ThoughtContext { generation: number; sources: Set<string>; triggers: Set<string>; lifeOnly: boolean; reviewing?: boolean; handedOn?: { memory: Memory; reach: RevisionReach }[] }
export function ensureCurrent(store: Store, context: ThoughtContext, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const settings = store.settings();
  if (settings.paused || context.generation !== settings.generation) throw new Error('The run is paused or management state changed; a new reasoning run is required.');
  if (context.lifeOnly && !settings.lifeEnabled) throw new Error('Autonomous life is disabled.');
}
export const errorResult = nativeErrorResult;
export const jsonResult = (result: unknown): AgentToolResult<any> => ({ content: [{ type: 'text', text: JSON.stringify(result) }], details: {} });

/** Shared execution rules for built-in and plugin tools. Plugins never create their own action receipts. */
export class ToolRuntime {
  constructor(readonly config: Config, readonly store: Store, private social: SocialAdapter, readonly context: () => ThoughtContext, private extensions: Pick<PluginHost, 'resolveMedia' | 'decorate'> & Partial<Pick<PluginHost, 'nativeDefinition' | 'nativeAllowed' | 'nativeExecute' | 'chatTarget'>> = { resolveMedia: value => value, decorate: tool => tool }, private namespace?: string) {}
  scoped(instance: string) { return new ToolRuntime(this.config, this.store, this.social, this.context, this.extensions, instance); }
  private name(name: string) { return this.namespace ? nativeToolName(this.namespace, name) : name; }
  private dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.extensions.nativeExecute?.(this.name(name), args, signal) ?? this.social.execute(this.name(name), args, signal);
  }
  resolveMedia(value: unknown): unknown { return this.extensions.resolveMedia(value); }
  decorate(tool: AgentTool): AgentTool {
    const decorated = this.extensions.decorate({ ...tool, name: this.name(tool.name) }, this);
    return { ...decorated, name: tool.name };
  }
  check(signal?: AbortSignal) { ensureCurrent(this.store, this.context(), signal); }
  allowed(name: string) { return this.extensions.nativeAllowed?.(this.name(name)) ?? this.social.allowed?.(this.name(name)) ?? false; }
  definition(name: string) {
    const definition = this.extensions.nativeDefinition?.(this.name(name)) ?? this.social.definition?.(this.name(name));
    if (!definition) throw new Error(`Unknown native interface: ${name}`);
    return definition;
  }
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
    if (!this.allowed(name)) throw new Error('The operator has not enabled this native interface.');
    const result = await this.dispatch(name, args, signal);
    this.check(signal);
    return result;
  }
  /** Non-QQ actions use the same ledger and budget; a dispatched failure cannot be assumed safe to repeat. */
  async externalAction(name: string, args: Record<string, unknown>, dispatch: () => Promise<unknown>, signal?: AbortSignal) {
    this.check(signal);
    const attempt = this.store.beginAction(`${this.name(name)}:${crypto.randomUUID()}`, this.name(name), args, [...this.context().sources], [...this.context().triggers], this.config.limits.actionsPerHour, this.extensions.chatTarget?.(this.name(name), args));
    if (attempt.fresh) {
      let dispatched = false;
      try { this.check(signal); dispatched = true; this.store.finishAction(attempt.action.id, 'success', await dispatch()); }
      catch (error) { this.store.finishAction(attempt.action.id, dispatched ? 'unknown' : 'failed', errorResult(error)); }
    }
    return { outcome: this.store.actionById(attempt.action.id)!, reused: !attempt.fresh };
  }
  /** Preparation may read through query; only dispatch can perform the recorded external action. */
  async action(name: string, args: Record<string, unknown>, perform: (dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>, signal?: AbortSignal, failure = errorResult) {
    this.check(signal);
    const attempt = this.store.beginAction(`${this.name(name)}:${crypto.randomUUID()}`, this.name(name), args, [...this.context().sources], [...this.context().triggers], this.config.limits.actionsPerHour, this.extensions.chatTarget?.(this.name(name), args));
    if (attempt.fresh) {
      let dispatched: string | undefined;
      try {
        const result = await perform(async (action, parameters) => {
          this.check(signal);
          if (!this.allowed(action)) throw new Error('The operator has not enabled this native interface.');
          dispatched = this.extensions.nativeDefinition?.(this.name(action))?.name ?? this.social.definition?.(this.name(action))?.name ?? action;
          return this.dispatch(action, parameters, signal);
        });
        this.store.finishAction(attempt.action.id, 'success', result, this.extensions.chatTarget?.(this.name(name), args));
      } catch (error) {
        this.store.finishAction(attempt.action.id, dispatched === undefined || definitelyFailed(error, dispatched) ? 'failed' : 'unknown', failure(error));
      }
    }
    return { outcome: this.store.actionById(attempt.action.id)!, reused: !attempt.fresh };
  }
}
