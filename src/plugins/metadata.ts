import type { Config } from '../config.js';
import { builtinAdapterDrivers, snowlumaScopedPluginIds } from '../adapters/metadata.js';

export const pluginIds = ['drawing', 'web-search', 'web-reader', 'qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools', 'gallery'] as const;
export type BuiltinPluginId = typeof pluginIds[number];
export type StandaloneBuiltinPluginId = 'drawing' | 'web-reader' | 'web-search' | 'gallery';

export interface BuiltinPluginDescriptor {
  readonly id: StandaloneBuiltinPluginId;
  /** Retain the historical tool order: it participates in working-context identity. */
  readonly order: number;
  /** Config slice governing this plugin's hot-reload change detection. */
  fingerprint(config: Config): unknown;
  /** Copy reloadable settings from desired config into target, preserving restart-only paths. */
  applyReloadConfig?(target: Config, desired: Config): void;
  /** Credential env var field declared on Config (shared by credential redaction & WebUI secrets). */
  readonly credentialField?: readonly [section: 'web' | 'drawing', field: string];
}

export const standaloneBuiltinDescriptors: readonly BuiltinPluginDescriptor[] = [
  {
    id: 'drawing',
    order: 1,
    fingerprint: config => ({ enabled: config.plugins.drawing ?? true, drawing: config.drawing }),
    applyReloadConfig: (target, desired) => { target.drawing = { ...desired.drawing, dir: target.drawing.dir }; },
    credentialField: ['drawing', 'apiKeyEnv'],
  },
  {
    id: 'web-reader',
    order: 2,
    fingerprint: config => ({ enabled: config.plugins['web-reader'] ?? true, web: config.web }),
    applyReloadConfig: (target, desired) => { target.web = desired.web; },
  },
  {
    id: 'web-search',
    order: 3,
    fingerprint: config => ({ enabled: config.plugins['web-search'] ?? true, web: config.web }),
    applyReloadConfig: (target, desired) => { target.web = desired.web; },
    credentialField: ['web', 'searchKeyEnv'],
  },
  {
    id: 'gallery',
    order: 4,
    fingerprint: config => ({
      enabled: config.plugins.gallery ?? true,
      dir: config.drawing.dir,
      drawing: config.drawing.enabled,
      generator: config.plugins.drawing,
      embedding: config.embedding,
    }),
  },
];

export const standaloneBuiltinById: ReadonlyMap<string, BuiltinPluginDescriptor> = new Map(
  standaloneBuiltinDescriptors.map(descriptor => [descriptor.id, descriptor]),
);

export const isBuiltinPluginId = (id: string): id is BuiltinPluginId =>
  (pluginIds as readonly string[]).includes(id);

export const isStandaloneBuiltinId = (id: string): id is StandaloneBuiltinPluginId =>
  standaloneBuiltinById.has(id);

export const activePluginIds = (_config?: Config): BuiltinPluginId[] =>
  standaloneBuiltinDescriptors.map(descriptor => descriptor.id);

/** Includes named adapter capabilities even while the daemon is offline. */
export const configuredPluginIds = (config: Config): string[] => [
  ...activePluginIds(config),
  ...config.adapters.flatMap(adapter => builtinAdapterDrivers[adapter.driver].configuredPluginIds(adapter)),
];

export const coreCredentialFields: readonly (readonly [string, string])[] = [
  ['model', 'apiKeyEnv'],
  ['embedding', 'apiKeyEnv'],
  ['webui', 'tokenEnv'],
];

/** Single source of truth for Config credential fields used by redaction and WebUI secret tracking. */
export const builtinCredentialFields: readonly (readonly [string, string])[] = [
  ...coreCredentialFields,
  ...standaloneBuiltinDescriptors.flatMap(descriptor => descriptor.credentialField ? [descriptor.credentialField] : []),
];

export function builtinFingerprintInput(id: string, config: Config): unknown {
  const descriptor = standaloneBuiltinById.get(id);
  return descriptor ? descriptor.fingerprint(config) : { enabled: config.plugins[id] ?? true };
}

export function applySelectedPluginReloadConfig(target: Config, desired: Config, targetId: string) {
  if (targetId === 'all') {
    for (const descriptor of standaloneBuiltinDescriptors) descriptor.applyReloadConfig?.(target, desired);
    return;
  }
  standaloneBuiltinById.get(targetId)?.applyReloadConfig?.(target, desired);
}

/** Non-reloadable core configuration subset compared to report changes that require a daemon restart. */
export function coreConfigForRestartCheck(config: Config) {
  const { plugins: _plugins, web: _web, drawing: _drawing, extensions, ...rest } = config;
  return {
    ...rest,
    drawing: { dir: config.drawing.dir },
    extensions: { directory: extensions.directory, dataDirectory: extensions.dataDirectory },
  };
}

export { snowlumaScopedPluginIds };
