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

export const pluginIds = ['drawing', 'web-search', 'web-reader', 'qzone-share', 'qq-stickers', 'qq-faces'] as const;
/** The composition root is the only place that knows which capability implementations are installed. */
export function createPlugins(config: Config, store: Store, social: SocialAdapter, semantics?: SemanticSource): PluginHost {
  const saved = new StickerStore(store);
  return new PluginHost([
    qzoneSharePlugin(config),
    ...(drawingEnabled(config) ? [drawingPlugin(new Drawings(store, new ImageClient(config.drawing), config.drawing.dir, config.memory.retentionDays), () => drawingEnabled(config))] : []),
    webReaderPlugin(config), webSearchPlugin(config),
    stickersPlugin(config, saved, semantics ? new StickerRecall(config.embedding, saved, semantics) : undefined),
    qqFacesPlugin(config, new FaceCatalog(store, social)),
  ]);
}
export function pluginCredentials(config: Config) {
  return { problems: drawingCredentialProblems(config), warnings: webSearchCredentialWarnings(config) };
}
