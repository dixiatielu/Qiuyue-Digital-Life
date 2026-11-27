import { validateToolArguments, type ToolCall } from '@earendil-works/pi-ai';
import type { TSchema } from 'typebox';
import type { LifePlugin } from '../plugins.js';
import type { Store } from '../store.js';
import { conversationRef, personRef } from '../identity.js';
import { ActionNotDispatchedError, nativeToolName, permits, type NativeActionDefinition, type ToolPermissions } from '../platform.js';
import type { NativeAdapterDefinition } from '../plugin-sdk.js';
import { sanitizeToolSchema } from '../schema.js';

/** Omit repeated prose from model declarations without removing a parameter or constraint. */
export function compactSchema(value: unknown, names = false): any {
  if (Array.isArray(value)) return value.map(item => compactSchema(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => names || !['description', 'title'].includes(key)).map(([key, item]) => [key, !names && ['enum', 'const', 'default', 'examples'].includes(key) ? item : compactSchema(item, !names && ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'].includes(key))]));
}
function validateNativeArgs(name: string, schema: TSchema, args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ActionNotDispatchedError(`Invalid native parameters for ${name}: expected an object.`);
  }
  try {
    return validateToolArguments(
      { name, description: '', parameters: schema },
      { type: 'toolCall', id: 'native', name, arguments: args as ToolCall['arguments'] },
    ) as Record<string, unknown>;
  } catch (error) {
    throw new ActionNotDispatchedError(error instanceof Error ? error.message : `Invalid native parameters for ${name}.`);
  }
}
/** One native catalog becomes one independently callable tool per operation. */
export function nativeAdapterPlugin(adapter: NativeAdapterDefinition, store: Store, permissions: ToolPermissions = adapter.permissions ?? { allow: '*', deny: [] }): LifePlugin {
  if (!Array.isArray(adapter.actions) || !adapter.actions.length || typeof adapter.version !== 'string' || !adapter.version.trim()) throw new Error('Adapters need a versioned, non-empty native catalog.');
  const identity = { platform: adapter.platform, accountId: adapter.accountId };
  conversationRef(identity, 'private', 'validation');
  const actions = new Map<string, NativeActionDefinition>();
  const schemas = new Map<string, TSchema>();
  for (const action of adapter.actions) {
    const name = nativeToolName(adapter.instance, action.name);
    if (actions.has(name) || action.inputSchema.type !== 'object' || typeof action.readOnly !== 'boolean') throw new Error(`Invalid or duplicate native operation: ${name}`);
    actions.set(name, { ...action, invariants: action.invariants ?? [], inputSchema: action.inputSchema as TSchema });
    schemas.set(name, sanitizeToolSchema(compactSchema(action.inputSchema) as TSchema));
  }
  for (const name of [...(permissions.allow === '*' ? [] : permissions.allow), ...permissions.deny]) if (!actions.has(nativeToolName(adapter.instance, name))) throw new Error(`Unknown native interface: ${name}`);
  if (adapter.frequent !== undefined && (!Array.isArray(adapter.frequent) || adapter.frequent.some(name => typeof name !== 'string' || !actions.has(nativeToolName(adapter.instance, name))))) throw new Error('frequent must list operations of this adapter.');
  const frequent = adapter.frequent && new Set(adapter.frequent);
  const controller = new AbortController();
  let active = false;
  const allowed = (name: string) => !!actions.get(name) && permits(permissions, actions.get(name)!.name);
  const chatTarget = (name: string, args: unknown) => {
    const action = actions.get(name); if (!action) return;
    const chat = adapter.conversation?.(action.name, args as Record<string, unknown>);
    return chat ? conversationRef(identity, chat.type, chat.id) : undefined;
  };
  const execute = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const action = actions.get(name);
    if (!active || !action || !allowed(name)) throw new ActionNotDispatchedError(`Adapter ${adapter.instance} is inactive or this operation is disabled.`);
    const validated = validateNativeArgs(name, schemas.get(name)!, args);
    return adapter.execute(action.name, validated, AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
  };
  // The host also stops a plugin whose start failed, so the adapter is stopped once however often this is asked.
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => { active = false; controller.abort(); await adapter.stop?.(); })();
  return {
    id: `adapter-${adapter.instance.replaceAll('_', '-')}`, contextVersion: adapter.version,
    nativeActions: { accounts: [identity], definition: name => actions.get(name), allowed, execute },
    reviewTools: [...actions].filter(([, action]) => action.readOnly).map(([name]) => name),
    chatActions: [...actions].filter(([, action]) => !action.readOnly).map(([name]) => name),
    chatTarget,
    images: event => event.source?.platform === adapter.platform && event.source.accountId === adapter.accountId ? (adapter.images?.(event) ?? []).map(image => ({
      label: image.label, autoView: image.autoView ?? true, unavailable: 'This platform image is unavailable; its appearance has not been perceived.', deferred: `Use view_event_image with event ${event.id} and its image index to see it.`,
      load: async signal => { if (!active) throw new Error('Adapter is inactive.'); const loaded = await image.load(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])); return { ...loaded, data: Buffer.from(loaded.data) }; },
    })) : [],
    tools: runtime => [...actions].map(([name, action]) => ({
      ...runtime.jsonTool(name, `[${adapter.platform} account ${adapter.accountId}; ${adapter.instance}; API ${adapter.version}] ${(action.summary ?? action.name).split('\n')[0]}\nNative operation: ${action.name}. ${action.invariants.join(' ')} Parameters and results follow the native API; find_tools returns the full parameter documentation.`, schemas.get(name)!, async (args, signal) => {
        const validated = validateNativeArgs(name, schemas.get(name)!, args);
        return action.readOnly ? runtime.record(`adapter:${adapter.instance}:${action.name}`, await runtime.query(name, validated, signal))
          : runtime.action(name, validated, dispatch => dispatch(name, runtime.resolveMedia(validated) as Record<string, unknown>), signal);
      }), available: () => allowed(name), ...(frequent && !frequent.has(action.name) ? { defer: true } : {}),
      // The declaration omits repeated prose; the catalog's own entry has it.
      documentation: () => action,
    })),
    start: async () => {
      store.bindPlatformAccount(adapter.instance, identity); active = true;
      try {
        await adapter.start?.({
          signal: controller.signal,
          publish: event => {
            if (!active || controller.signal.aborted) throw new Error('Adapter stopped.');
            const { conversation, actor, actorName, own = false, addressed = false, attention = 'normal', ...raw } = event;
            store.receive({ ...raw, at: raw.at ?? Date.now(), key: `adapter:${adapter.platform}:${adapter.accountId}:${raw.key}`, source: {
              ...identity, instance: adapter.instance, own, addressed, attention,
              ...(actor === undefined ? {} : { actor: personRef(adapter.platform, actor), actorName }),
              ...(conversation ? { conversation: conversationRef(identity, conversation.type, conversation.id), conversationType: conversation.type } : {}),
            } });
          },
          storage: { get: (key, fallback) => store.setting(`adapter:${adapter.platform}:${adapter.accountId}:${key}`, fallback), set: (key, value) => { if (!active) throw new Error('Adapter stopped.'); store.setSetting(`adapter:${adapter.platform}:${adapter.accountId}:${key}`, value); } },
        });
      } catch (error) { await stop(); throw error; }
    },
    stop,
  };
}
