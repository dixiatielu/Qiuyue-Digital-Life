import { environmentCredential, type CredentialReader } from '../credentials.js';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import type { LifePlugin } from '../plugins.js';
import { publicFetch } from '../web.js';
import { ui } from '../ui-language.js';

export class WebSearch {
  constructor(private config: Config['web'], private credential: CredentialReader = environmentCredential) {}
  async search(query: string, signal?: AbortSignal) {
    if (!this.config.enabled) throw new Error('The web tool is disabled.');
    if (typeof query !== 'string' || !query.trim() || [...query].length > 128) throw new Error('The search query must contain 1 to 128 Unicode characters and must not be entirely whitespace.');
    const key = this.credential(this.config.searchKeyEnv);
    if (!key) throw new Error(`The search credential ${this.config.searchKeyEnv} is not configured; known webpages can still be read directly.`);
    const result = await publicFetch(this.config.searchUrl, {
      ...this.config, signal, method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, count: 5, need_content: false }),
    });
    const data = JSON.parse(result.data.toString('utf8'));
    if (!data || !Array.isArray(data.results) || data.results.some((item: any) => !item || typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.summary !== 'string' || typeof item.snippet !== 'string')) throw new Error('The search interface returned an invalid results format.');
    return data.results.slice(0, 5).map((item: { title: string; url: string; summary: string; snippet: string }) => ({ title: item.title, url: item.url, description: item.summary || item.snippet }));
  }
}
export function webSearchEnabled(config: Config) { return config.web.enabled && config.plugins['web-search'] !== false; }
export function webSearchCredentialWarnings(config: Config, credential: CredentialReader = environmentCredential): string[] {
  return webSearchEnabled(config) && !credential(config.web.searchKeyEnv)
    ? [ui(`Missing ${config.web.searchKeyEnv}; web search is unavailable, but known webpages can still be read.`, `缺少 ${config.web.searchKeyEnv}；联网搜索不可用，已知网页仍可阅读。`)] : [];
}
export function webSearchPlugin(config: Config, credential: CredentialReader = environmentCredential): LifePlugin {
  const web = new WebSearch(config.web, credential);
  return {
    id: 'web-search', enabled: () => webSearchEnabled(config),
    tools: runtime => [runtime.jsonTool('search_web', 'Search the web for public information.', Type.Object({ query: Type.String({ description: 'Search query, at most 128 Unicode characters', minLength: 1, maxLength: 128 }) }), async (args, signal) => runtime.record('search', await web.search(args.query, signal)))],
    activities: [{ activity: 'Look things up online: news, weather, or whatever you are curious about', tools: ['search_web'] }],
    experienceKinds: { search_web: 'search' },
  };
}
