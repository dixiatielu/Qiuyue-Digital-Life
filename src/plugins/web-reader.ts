import { Type } from 'typebox';
import type { Config } from '../config.js';
import type { LifePlugin } from '../plugins.js';
import { publicFetch } from '../web.js';

export class WebReader {
  constructor(private config: Config['web']) {}
  async read(url: string, signal?: AbortSignal) {
    if (!this.config.enabled) throw new Error('The web tool is disabled.');
    const result = await publicFetch(url, { ...this.config, signal });
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/.test(result.type)) throw new Error('The resource is not readable text.');
    const text = result.data.toString('utf8').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    return { url: result.url, text: text.slice(0, 20_000), truncated: text.length > 20_000 };
  }
}
export function webReaderPlugin(config: Config): LifePlugin {
  const web = new WebReader(config.web);
  return {
    id: 'web-reader', enabled: () => config.web.enabled && config.plugins['web-reader'] !== false,
    tools: runtime => [runtime.jsonTool('read_webpage', 'Read a public webpage.', Type.Object({ url: Type.String({ description: 'Public webpage URL', minLength: 1, maxLength: 2000 }) }), async (args, signal) => runtime.record('reading', await web.read(args.url, signal)))],
    activities: [{ activity: 'Read online: something you follow, news, or whatever you are curious about', tools: ['read_webpage'] }],
    experienceKinds: { read_webpage: 'reading' },
  };
}
