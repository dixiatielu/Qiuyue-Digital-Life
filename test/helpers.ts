import type { ThoughtContext } from '../src/tool-runtime.js';
import type { CredentialReader } from '../src/credentials.js';
import { normalizeEvent } from '../src/adapters/snowluma/index.js';
import { scopePlugin } from '../src/adapters/scope.js';
import { getSnowLumaCatalog } from '../src/adapters/snowluma/catalog.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { PiBrain } from '../src/brain.js';
import { createTools as builtinTools, forReview } from '../src/tools.js';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import type { SocialAdapter } from '../src/platform.js';
import type { SemanticRecall } from '../src/recall.js';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
import { createPlugins as builtinPlugins } from '../src/plugins/index.js';
import { snowlumaToolsPlugin as rawSnowTools } from '../src/plugins/snowluma-tools.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function config() {
  const value = loadConfig(new URL('../config.example.json', import.meta.url).pathname);
  value.adapters[0]!.accountId = '900'; value.adapters[0]!.groups = [100, 200]; value.web.enabled = false;
  value.limits.tickMs = 10000; value.limits.debounceMs = 0;
  return value;
}
export function event(store: Store, text = 'Hello', groupId = 100, key = crypto.randomUUID()) {
  return store.receive(qqEvent({ key, kind: 'message', at: Date.now(), text, groupId, actorId: 7, payload: { message: [{ type: 'text', data: { text } }] } }, store))!;
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export function fixture(social?: SocialAdapter, existingStore?: Store, recall?: SemanticRecall, extensions?: (store: Store, cfg: ReturnType<typeof config>) => LifePlugin[]) {
  const cfg = config(); const store = existingStore ?? new Store(':memory:');
  cfg.drawing.dir = join(tmpdir(), `qiuyue-fixture-images-${crypto.randomUUID()}`);
  const sent: { kind: string; args: Record<string, unknown> }[] = [];
  const adapter = social ?? { execute: async (kind: string, args: Record<string, unknown>) => { sent.push({ kind, args }); return kind === 'get_msg' ? { group_id: 100, message_type: 'group', message_id: -42 } : { message_id: -42 }; } };
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  // A review runs beside the thoughts, so its model answers from a script of its own.
  const reviewFaux = fauxProvider(); const reviewModels = createModels(); reviewModels.setProvider(reviewFaux.provider);
  let brain: PiBrain; let reviewer: PiBrain;
  let tools: ReturnType<typeof createTools>; let reviewTools: ReturnType<typeof createTools>;
  const local = qqConfig(cfg);
  const plugins = extensions ? new PluginHost([...extensions(store, local).map(plugin => ['qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools'].includes(plugin.id) ? scopePlugin(plugin, 'qq_main', getSnowLumaCatalog().actions, adapter) : plugin), scopePlugin(rawSnowTools(local, cfg.adapters[0]!), 'qq_main', getSnowLumaCatalog().actions, adapter)]) : createPlugins(cfg, store, adapter, recall);
  const restart = () => {
    tools = createTools(cfg, store, adapter, () => brain.thought, recall, plugins);
    brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) }, undefined, recall);
    reviewTools = forReview(createTools(cfg, store, adapter, () => reviewer.thought, recall, plugins));
    reviewer = new PiBrain(cfg, store, reviewTools, { model: reviewFaux.getModel(), stream: reviewModels.streamSimple.bind(reviewModels) }, undefined, recall, undefined, 'review');
    return brain;
  };
  restart();
  return { cfg, store, plugins, get brain() { return brain; }, get reviewer() { return reviewer; }, faux, reviewFaux, sent, get tools() { return tools; }, get reviewTools() { return reviewTools; }, restart };
}

/** Explicit native QQ input fixtures; production only accepts canonical events. */
export function qqEvent(input: any, store?: Store): any {
  if (input.source) { const { groupId, actorId, ...canonical } = input; return canonical; }
  const { groupId, actorId, ...rest } = input;
  if (groupId === undefined && actorId === undefined && !/^(message|notice:|request:|meta_event:)/.test(input.kind)) return rest;
  const payload = input.payload ?? {};
  const account = config().adapters[0]!;
  const native = { ...payload, self_id: 900, group_id: payload.group_id ?? groupId, user_id: payload.user_id ?? actorId, post_type: payload.post_type ?? input.kind.split(':')[0], notice_type: payload.notice_type ?? (input.kind.startsWith('notice:') ? input.kind.split(':')[1] : undefined), sub_type: payload.sub_type ?? input.kind.split(':')[2] };
  const normalized = normalizeEvent(native, account, id => store?.sentMessage(id, { platform: 'qq', accountId: '900' }) ?? false)!;
  return { ...rest, source: normalized.source };
}
export function createPlugins(cfg: ReturnType<typeof config>, store: Store, social: SocialAdapter, semantics?: SemanticRecall, credential?: CredentialReader) {
  return builtinPlugins(cfg, store, semantics, credential, () => social);
}
export function createTools(cfg: ReturnType<typeof config>, store: Store, social: SocialAdapter, context: () => ThoughtContext, recall?: SemanticRecall, host?: PluginHost) {
  return builtinTools(cfg, store, context, recall, host ?? createPlugins(cfg, store, social, recall));
}

/** Record a native fixture action with its canonical account and conversation. */
export function beginAction(store: Store, ...values: Parameters<Store['beginAction']>) {
  let [key, kind, args, sources, triggers, limit, conversation] = values;
  if (getSnowLumaCatalog().actions.some(action => action.name === kind) || kind === 'share_qzone_feed') kind = `qq_main__${kind}`;
  if (!conversation && kind.startsWith('qq_main__') && (args.group_id != null || args.user_id != null)) conversation = `qq:900:${args.group_id != null ? 'group' : 'private'}:${args.group_id ?? args.user_id}`;
  return store.beginAction(key, kind, args, sources, triggers, limit, conversation);
}

/** Internal capability plugins read their own switch; the composition root scopes it. */
export function qqConfig(cfg: ReturnType<typeof config>) {
  return { ...cfg, plugins: new Proxy(cfg.plugins, {
    get(target, key) { return typeof key === 'string' && ['snowluma-tools', 'qzone-share', 'qq-stickers', 'qq-faces'].includes(key) ? target[`qq-main-${key}`] ?? true : Reflect.get(target, key); },
  }) };
}
