import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { PluginHost } from '../plugins.js';
import { drawingCredentialProblems, drawingEnabled, drawingPlugin, Drawings, ImageClient } from './drawing.js';
import { webReaderPlugin } from './web-reader.js';
import { webSearchCredentialWarnings, webSearchPlugin } from './web-search.js';
import { qzoneSharePlugin } from './qzone-share.js';
import type { SemanticSource } from '../embedding.js';
import { StickerStore } from './stickers-store.js';
import { StickerRecall } from './stickers-recall.js';
import { stickersPlugin } from './stickers.js';
import type { SocialAdapter } from '../snowluma.js';
import { FaceCatalog, qqFacesPlugin } from './faces.js';
import { snowlumaToolsPlugin } from './snowluma-tools.js';

export const pluginIds = ['drawing', 'web-search', 'web-reader', 'qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools'] as const;
export type BuiltinPluginId = typeof pluginIds[number];
// Retain the historical tool order: it participates in working-context identity.
const pluginOrder: BuiltinPluginId[] = ['qzone-share', 'drawing', 'web-reader', 'web-search', 'qq-stickers', 'qq-faces', 'snowluma-tools'];
export function createBuiltinPlugin(id: BuiltinPluginId, config: Config, store: Store, social: SocialAdapter, semantics?: SemanticSource) {
  switch (id) {
    case 'qzone-share': return qzoneSharePlugin(config);
    case 'drawing': return drawingPlugin(new Drawings(store, new ImageClient(config.drawing), config.drawing.dir, config.memory.retentionDays), () => drawingEnabled(config));
    case 'web-reader': return webReaderPlugin(config);
    case 'web-search': return webSearchPlugin(config);
    case 'qq-stickers': {
      const saved = new StickerStore(store);
      return stickersPlugin(config, saved, semantics ? new StickerRecall(config.embedding, saved, semantics) : undefined);
    }
    case 'qq-faces': return qqFacesPlugin(config, new FaceCatalog(store, social));
    case 'snowluma-tools': return snowlumaToolsPlugin(config);
  }
}
/** The composition root is the only place that knows which capability implementations are installed. */
export function createPlugins(config: Config, store: Store, social: SocialAdapter, semantics?: SemanticSource): PluginHost {
  return new PluginHost(pluginOrder.map(id => createBuiltinPlugin(id, config, store, social, semantics)));
}
export function pluginCredentials(config: Config) {
  return { problems: drawingCredentialProblems(config), warnings: webSearchCredentialWarnings(config) };
}
