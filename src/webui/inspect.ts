import { environmentCredential, type CredentialReader } from '../credentials.js';
import type { Config } from '../config.js';
import { Store } from '../store.js';
import { createTools } from '../tools.js';
import { contextIdentity } from '../brain.js';
import { EmbeddingClient, SemanticRecall } from '../recall.js';
import { createPlugins, pluginCredentials } from '../plugins/index.js';
import type { PluginHost } from '../plugins.js';
import type { SocialAdapter } from '../snowluma.js';

const offline = () => { throw new Error('Offline inspection takes no action.'); };

/** Build, offline, the tools a configuration would start with: which plugins it enables and which working context it would continue. */
export function inspectConfig(config: Config, credential: CredentialReader = environmentCredential) {
  const store = new Store(':memory:');
  try {
    const social: SocialAdapter = { execute: async () => offline() };
    let plugins!: PluginHost;
    const recall = config.embedding.enabled ? new SemanticRecall(config, store, new EmbeddingClient(config.embedding, fetch, credential), () => plugins.knownEmojiNames()) : undefined;
    plugins = createPlugins(config, store, social, recall, credential);
    const tools = createTools(config, store, social, offline, recall, plugins);
    return {
      identities: [contextIdentity(config, tools), contextIdentity(config, tools, true)],
      plugins: plugins.enabledIds(), tools: tools.current().map(tool => tool.name), credentials: pluginCredentials(config, credential),
    };
  } finally { store.close(); }
}
