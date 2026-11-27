import type { AdapterConfig } from '../config.js';

export type BuiltinAdapterDriver = 'snowluma' | 'telegram';
export const snowlumaScopedPluginIds = ['qzone-share', 'qq-stickers', 'qq-faces', 'snowluma-tools'] as const;
export type SnowLumaScopedPluginId = typeof snowlumaScopedPluginIds[number];

export interface AdapterDriverMetadata {
  readonly driver: BuiltinAdapterDriver;
  readonly platform: string;
  readonly defaultUrl: string;
  readonly allowedProtocols: readonly string[];
  readonly defaultTokenEnv: string;
  configuredPluginIds(adapter: AdapterConfig): string[];
  validateConfig(adapter: AdapterConfig): void;
}

export const builtinAdapterDrivers: Record<BuiltinAdapterDriver, AdapterDriverMetadata> = {
  snowluma: {
    driver: 'snowluma',
    platform: 'qq',
    defaultUrl: 'ws://127.0.0.1:3001',
    allowedProtocols: ['ws:', 'wss:'],
    defaultTokenEnv: 'SNOWLUMA_TOKEN',
    configuredPluginIds: adapter => snowlumaScopedPluginIds.map(id => `${adapter.id.replaceAll('_', '-')}-${id}`),
    validateConfig(adapter) {
      if (!Array.isArray(adapter.groups) || adapter.groups.some(id => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error('Adapter groups must contain positive QQ group IDs.');
      }
      if (!Number.isSafeInteger(adapter.maxStreamBytes) || adapter.maxStreamBytes <= 0) {
        throw new Error('Adapter size limits must be positive integers.');
      }
    },
  },
  telegram: {
    driver: 'telegram',
    platform: 'telegram',
    defaultUrl: 'https://api.telegram.org',
    allowedProtocols: ['https:', 'http:'],
    defaultTokenEnv: 'TELEGRAM_BOT_TOKEN',
    configuredPluginIds: adapter => [`adapter-${adapter.id.replaceAll('_', '-')}`],
    validateConfig(adapter) {
      if (!Number.isSafeInteger(adapter.maxFileBytes) || adapter.maxFileBytes <= 0) {
        throw new Error('Adapter size limits must be positive integers.');
      }
      if (!['manual', 'polling'].includes(adapter.receive)) {
        throw new Error('Telegram receive must be polling or manual.');
      }
    },
  },
};

export function isBuiltinAdapterDriver(value: unknown): value is BuiltinAdapterDriver {
  return typeof value === 'string' && Object.hasOwn(builtinAdapterDrivers, value);
}
