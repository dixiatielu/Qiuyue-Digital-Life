import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { PluginHost } from '../plugins.js';
import { drawingCredentialProblems, drawingEnabled, drawingPlugin, Drawings, ImageClient } from './drawing.js';
import { webReaderPlugin } from './web-reader.js';
import { webSearchCredentialWarnings, webSearchPlugin } from './web-search.js';
import { qzoneSharePlugin } from './qzone-share.js';

export const pluginIds = ['drawing', 'web-search', 'web-reader', 'qzone-share'] as const;
/** The composition root is the only place that knows which capability implementations are installed. */
export function createPlugins(config: Config, store: Store): PluginHost {
  return new PluginHost([
    qzoneSharePlugin(config),
    ...(drawingEnabled(config) ? [drawingPlugin(new Drawings(store, new ImageClient(config.drawing), config.drawing.dir, config.memory.retentionDays), () => drawingEnabled(config))] : []),
    webReaderPlugin(config), webSearchPlugin(config),
  ]);
}
export function pluginCredentials(config: Config) {
  return { problems: drawingCredentialProblems(config), warnings: webSearchCredentialWarnings(config) };
}
