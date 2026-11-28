import { environmentCredential, type CredentialReader } from '../credentials.js';
import type { AdapterConfig, Config } from '../config.js';
import type { Store } from '../store.js';
import { SnowLumaAdapter } from '../adapters/snowluma/index.js';
import { getSnowLumaCatalog } from '../adapters/snowluma/catalog.js';
import { telegramAdapter, telegramCatalog } from '../adapters/telegram/index.js';
import { nativeAdapterPlugin } from '../adapters/native.js';
import { scopePlugin } from '../adapters/scope.js';
import { PluginHost, type LifePlugin } from '../plugins.js';
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
import {
  activePluginIds,
  configuredPluginIds,
  pluginIds,
  snowlumaScopedPluginIds,
  standaloneBuiltinDescriptors,
  type BuiltinPluginId,
} from './metadata.js';

export { activePluginIds, configuredPluginIds, pluginIds, standaloneBuiltinDescriptors, type BuiltinPluginId };

type BuiltinFactory = (
  config: Config,
  store: Store,
  semantics?: SemanticSource,
  credential?: CredentialReader,
  connection?: { account: AdapterConfig; adapter: SocialAdapter },
) => LifePlugin;

const builtinFactories: Record<BuiltinPluginId, BuiltinFactory> = {
  'qzone-share': (config, _store, _semantics, _credential, connection) => qzoneSharePlugin(config, connection!.account),
  drawing: (config, store, _semantics, credential = environmentCredential) =>
    drawingPlugin(new Drawings(store, new ImageClient(config.drawing, fetch, credential), config.drawing.dir), () => drawingEnabled(config)),
  gallery: (config, store, semantics) => galleryPlugin(config, store, semantics),
  'web-reader': config => webReaderPlugin(config),
  'web-search': (config, _store, _semantics, credential = environmentCredential) => webSearchPlugin(config, credential),
  'qq-stickers': (config, store, semantics, _credential, connection) => {
    const saved = new StickerStore(store, connection!.account);
    return stickersPlugin(config, saved, semantics ? new StickerRecall(config.embedding, saved, semantics) : undefined);
  },
  'qq-faces': (config, store, _semantics, _credential, connection) => qqFacesPlugin(config, new FaceCatalog(store, connection!.adapter)),
  'snowluma-tools': (config, _store, _semantics, _credential, connection) => snowlumaToolsPlugin(config, connection!.account, connection!.adapter),
};

export function createBuiltinPlugin(
  id: BuiltinPluginId,
  config: Config,
  store: Store,
  semantics?: SemanticSource,
  credential: CredentialReader = environmentCredential,
  connection?: { account: AdapterConfig; adapter: SocialAdapter },
): LifePlugin {
  return builtinFactories[id](config, store, semantics, credential, connection);
}

export interface AdapterCatalogSummary {
  source: Record<string, unknown>;
  actions: { name: string; category?: string; summary?: string; readOnly: boolean }[];
}

/** Built-in adapter catalog summary for management interfaces. */
export function adapterCatalog(driver: string): AdapterCatalogSummary | undefined {
  if (driver === 'snowluma') {
    const catalog = getSnowLumaCatalog();
    return {
      source: catalog.source,
      actions: catalog.actions.map(action => ({ name: action.name, category: action.category, summary: action.summary, readOnly: action.readOnly })),
    };
  }
  if (driver === 'telegram') {
    return {
      source: telegramCatalog.source,
      actions: telegramCatalog.actions.map(action => ({ name: action.name, summary: action.summary, readOnly: action.readOnly })),
    };
  }
}

/** The composition root is the only place that knows which capability implementations are installed. */
export function createPlugins(
  config: Config,
  store: Store,
  semantics?: SemanticSource,
  credential: CredentialReader = environmentCredential,
  connections?: (account: AdapterConfig) => SocialAdapter & { connect?(): Promise<void>; close?(): Promise<void> },
): PluginHost {
  const plugins = [...standaloneBuiltinDescriptors]
    .sort((a, b) => a.order - b.order)
    .map(descriptor => createBuiltinPlugin(descriptor.id, config, store, semantics, credential));
  for (const instance of config.adapters) {
    if (instance.driver === 'telegram') {
      const plugin = nativeAdapterPlugin(telegramAdapter(instance, credential), store);
      plugin.enabled = () => config.plugins[plugin.id] !== false; plugin.essential = true;
      plugins.push(plugin); continue;
    }
    const local: Config = { ...config, plugins: { ...config.plugins } };
    for (const id of snowlumaScopedPluginIds) Object.defineProperty(local.plugins, id, { get: () => config.plugins[`${instance.id.replaceAll('_', '-')}-${id}`] ?? true });
    const adapter = connections?.(instance) ?? new SnowLumaAdapter(instance, store, () => {}, credential);
    const actions = getSnowLumaCatalog().actions;
    for (const id of snowlumaScopedPluginIds) {
      const plugin = scopePlugin(createBuiltinPlugin(id, local, store, semantics, credential, { account: instance, adapter }), instance.id, actions, adapter);
      plugin.requiresRestart = true;
      if (id === 'snowluma-tools') {
        plugin.essential = true;
        plugin.start = async () => { store.bindPlatformAccount(instance.id, { platform: 'qq', accountId: instance.accountId }); await adapter.connect?.(); };
        plugin.stop = () => adapter.close?.();
      }
      plugins.push(plugin);
    }
  }
  return new PluginHost(plugins);
}

export function pluginCredentials(config: Config, credential: CredentialReader = environmentCredential) {
  const adapterProblems = config.adapters
    .filter(adapter => adapter.driver === 'telegram' && config.plugins[`adapter-${adapter.id.replaceAll('_', '-')}`] !== false && !/^[0-9]+:[A-Za-z0-9_-]+$/.test(credential(adapter.tokenEnv) ?? ''))
    .map(adapter => `Missing or invalid credential ${adapter.tokenEnv} for ${adapter.id}.`);
  return { problems: [...drawingCredentialProblems(config, credential), ...adapterProblems], warnings: webSearchCredentialWarnings(config, credential) };
}
