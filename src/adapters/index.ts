import type { Config } from '../config.js';
import type { Store } from '../store.js';
import type { CredentialReader } from '../credentials.js';
import { ActionNotDispatchedError, type SocialAdapter } from '../platform.js';
import { SnowLumaAdapter } from './snowluma/index.js';

/** Compatibility connection for old configurations. Named adapters own their plugin lifecycle. */
export function createLegacyConnection(config: Config, store: Store, notify: () => void, credential: CredentialReader): SocialAdapter & { connect(): Promise<void>; close(): Promise<void> } {
  if (config.adapters !== undefined) return { execute: async () => { throw new ActionNotDispatchedError('Unknown adapter operation.'); }, connect: async () => {}, close: async () => {} };
  return new SnowLumaAdapter(config.snowluma, store, notify, credential);
}
