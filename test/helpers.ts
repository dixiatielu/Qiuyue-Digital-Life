import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { PiBrain } from '../src/brain.js';
import { createTools, forReview } from '../src/tools.js';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import type { SocialAdapter } from '../src/snowluma.js';
import type { SemanticRecall } from '../src/recall.js';
import { PluginHost, type LifePlugin } from '../src/plugins.js';
import { createPlugins } from '../src/plugins/index.js';

export function config() {
  const value = loadConfig(new URL('../config.example.json', import.meta.url).pathname);
  value.snowluma.selfId = 900; value.snowluma.groups = [100, 200]; value.web.enabled = false;
  value.limits.tickMs = 10000; value.limits.debounceMs = 0;
  return value;
}
export function event(store: Store, text = 'Hello', groupId = 100, key = crypto.randomUUID()) {
  return store.receive({ key, kind: 'message', at: Date.now(), text, groupId, actorId: 7, payload: { message: [{ type: 'text', data: { text } }] } })!;
}
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export function fixture(social?: SocialAdapter, existingStore?: Store, recall?: SemanticRecall, extensions?: (store: Store, cfg: ReturnType<typeof config>) => LifePlugin[]) {
  const cfg = config(); const store = existingStore ?? new Store(':memory:');
  const sent: { kind: string; args: Record<string, unknown> }[] = [];
  const adapter = social ?? { execute: async (kind: string, args: Record<string, unknown>) => { sent.push({ kind, args }); return kind === 'get_msg' ? { group_id: 100, message_type: 'group', message_id: -42 } : { message_id: -42 }; } };
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  // A review runs beside the thoughts, so its model answers from a script of its own.
  const reviewFaux = fauxProvider(); const reviewModels = createModels(); reviewModels.setProvider(reviewFaux.provider);
  let brain: PiBrain; let reviewer: PiBrain;
  let tools: ReturnType<typeof createTools>; let reviewTools: ReturnType<typeof createTools>;
  const plugins = extensions ? new PluginHost(extensions(store, cfg)) : createPlugins(cfg, store, adapter, recall);
  const restart = () => {
    tools = createTools(cfg, store, adapter, () => brain.thought, recall, plugins);
    brain = new PiBrain(cfg, store, tools, { model: faux.getModel(), stream: models.streamSimple.bind(models) }, undefined, recall);
    reviewTools = forReview(createTools(cfg, store, adapter, () => reviewer.thought, recall, plugins));
    reviewer = new PiBrain(cfg, store, reviewTools, { model: reviewFaux.getModel(), stream: reviewModels.streamSimple.bind(reviewModels) }, undefined, recall);
    return brain;
  };
  restart();
  return { cfg, store, plugins, get brain() { return brain; }, get reviewer() { return reviewer; }, faux, reviewFaux, sent, get tools() { return tools; }, get reviewTools() { return reviewTools; }, restart };
}
