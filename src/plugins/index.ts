import { environmentCredential, type CredentialReader } from '../credentials.js';
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { SnowLumaAdapter } from '../adapters/snowluma/index.js';
import { getSnowLumaCatalog } from '../adapters/snowluma/catalog.js';
import { telegramAdapter } from '../adapters/telegram/index.js';
import { nativeAdapterPlugin } from '../adapters/native.js';
import { scopePlugin } from '../adapters/scope.js';
import { conversationRef } from '../identity.js';
import { PluginHost } from '../plugins.js';
import { drawingCredentialProblems, drawingEnabled, drawingPlugin, Drawings, ImageClient } from './drawing.js';
import { webReaderPlugin } from './web-reader.js';
import { webSearchCredentialWarnings, webSearchPlugin } from './web-search.js';
import { qzoneSharePlugin } from './qzone-share.js';
import type { SemanticSource } from '../embedding.js';
import { StickerStore } from './stickers-store.js';
import { StickerRecall } from './stickers-recall.js';
import { stickersPlugin } from './stickers.js';
import type { SocialAdapter } from '../platform.js';
import { FaceCatalog, qqFacesPlugin } from './faces.js';
import { snowlumaToolsPlugin } from './snowluma-tools.js';
import { galleryPlugin } from './gallery.js';

export const pluginIds = ['drawing', 'web-search', 'web-reader', 'qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools', 'gallery'] as const;
export const activePluginIds = (config: Config) => config.adapters === undefined ? [...pluginIds] : pluginIds.filter(id => !['qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools'].includes(id));
export type BuiltinPluginId = typeof pluginIds[number];
// Retain the historical tool order: it participates in working-context identity.
const pluginOrder: BuiltinPluginId[] = ['qzone-share', 'drawing', 'web-reader', 'web-search', 'qq-stickers', 'qq-faces', 'snowluma-tools', 'gallery'];
export function createBuiltinPlugin(id: BuiltinPluginId, config: Config, store: Store, social: SocialAdapter, semantics?: SemanticSource, credential: CredentialReader = environmentCredential) {
  switch (id) {
    case 'qzone-share': return qzoneSharePlugin(config);
    case 'drawing': return drawingPlugin(new Drawings(store, new ImageClient(config.drawing, fetch, credential), config.drawing.dir), () => drawingEnabled(config));
    case 'gallery': return galleryPlugin(config, store, semantics);
    case 'web-reader': return webReaderPlugin(config);
    case 'web-search': return webSearchPlugin(config, credential);
    case 'qq-stickers': {
      const saved = new StickerStore(store);
      return stickersPlugin(config, saved, semantics ? new StickerRecall(config.embedding, saved, semantics) : undefined);
    }
    case 'qq-faces': return qqFacesPlugin(config, new FaceCatalog(store, social));
    case 'snowluma-tools': return snowlumaToolsPlugin(config);
  }
}
/** The composition root is the only place that knows which capability implementations are installed. */
export function createPlugins(config: Config, store: Store, social: SocialAdapter, semantics?: SemanticSource, credential: CredentialReader = environmentCredential): PluginHost {
  const plugins = pluginOrder.filter(id => activePluginIds(config).includes(id)).map(id => createBuiltinPlugin(id, config, store, social, semantics, credential));
  for (const instance of config.adapters ?? []) {
    if (instance.driver === 'telegram') {
      const plugin = nativeAdapterPlugin(telegramAdapter(instance, credential), store);
      plugin.enabled = () => config.plugins[plugin.id] !== false;
      plugins.push(plugin); continue;
    }
    const snow = { ...config.snowluma, url: instance.url ?? 'ws://127.0.0.1:3001', selfId: Number(instance.accountId), tokenEnv: instance.tokenEnv, groups: instance.groups, tools: instance.tools, maxStreamBytes: instance.maxStreamBytes };
    const local: Config = { ...config, snowluma: snow, plugins: { ...config.plugins } };
    for (const id of ['snowluma-tools', 'qzone-share', 'qq-stickers', 'qq-faces']) local.plugins[id] = config.plugins[`${instance.id.replaceAll('_', '-')}-${id}`] ?? config.plugins[id] ?? true;
    const adapter = new SnowLumaAdapter(snow, store, () => {}, credential, instance.id);
    const actions = getSnowLumaCatalog().actions;
    for (const id of ['qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools'] as const) {
      const plugin = scopePlugin(createBuiltinPlugin(id, local, store, adapter, semantics, credential), instance.id, actions, adapter, legacy => {
        const [type, target] = legacy.split(':'); return conversationRef({ platform: 'qq', accountId: instance.accountId }, type as 'private' | 'group', target!);
      });
      if (id === 'snowluma-tools') {
        plugin.start = async () => { store.bindPlatformAccount(instance.id, { platform: 'qq', accountId: instance.accountId }); await adapter.connect(); };
        plugin.stop = () => adapter.close();
      }
      plugins.push(plugin);
    }
  }
  return new PluginHost(plugins);
}
export function pluginCredentials(config: Config, credential: CredentialReader = environmentCredential) {
  const adapterProblems = (config.adapters ?? []).filter(adapter => adapter.driver === 'telegram' && config.plugins[`adapter-${adapter.id.replaceAll('_', '-')}`] !== false && !/^[0-9]+:[A-Za-z0-9_-]+$/.test(credential(adapter.tokenEnv) ?? '')).map(adapter => `Missing or invalid credential ${adapter.tokenEnv} for ${adapter.id}.`);
  return { problems: [...drawingCredentialProblems(config, credential), ...adapterProblems], warnings: webSearchCredentialWarnings(config, credential) };
}
