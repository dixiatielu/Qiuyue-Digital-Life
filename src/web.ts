import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Config } from './config.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  const normalized = address.toLowerCase();
  const parts = normalized.split(':'); const second = Number.parseInt(parts[1] || '0', 16);
  return isIP(address) === 6 && /^[23]/.test(normalized) && !(parts[0] === '2001' && (second < 0x200 || second === 0xdb8)) && !normalized.startsWith('2002:');
}

export async function publicFetch(input: string, options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string>; method?: 'GET' | 'POST'; body?: string }, redirects = 0): Promise<{ data: Buffer; type: string; url: string }> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || redirects > 4) throw new Error('Only public HTTP/HTTPS URLs are allowed, with at most four redirects.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  signal.throwIfAborted();
  let aborted!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { aborted = () => reject(signal.reason); signal.addEventListener('abort', aborted, { once: true }); });
  const addresses = await (async () => {
    try { return isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([lookup(host, { all: true }), cancelled]); }
    finally { signal.removeEventListener('abort', aborted); }
  })();
  if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Error('The web tool cannot access local, private network, or reserved addresses.');
  const target = addresses[0]!;
  signal.throwIfAborted();
  const result = await new Promise<{ data: Buffer; type: string; redirect?: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal,
      method: options.method ?? 'GET',
      headers: { 'User-Agent': 'qiuyue-digital-life/0.1', 'Accept-Encoding': 'identity', ...options.headers },
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) { response.resume(); resolve({ data: Buffer.alloc(0), type: '', redirect: new URL(response.headers.location, url).href }); return; }
      if (!response.statusCode || response.statusCode >= 400) { response.resume(); reject(new Error(`HTTP ${response.statusCode}`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > options.maxBytes) { const error = new Error('The response exceeds the size limit.'); reject(error); request.destroy(error); } else chunks.push(chunk); });
      response.on('end', () => resolve({ data: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '').split(';')[0]! }));
      response.on('error', reject);
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error('Network read timed out.')));
    request.on('error', reject); request.end(options.body);
  });
  if (result.redirect) {
    if (options.method === 'POST') throw new Error('The search interface cannot redirect.');
    return publicFetch(result.redirect, { ...options, signal, headers: new URL(result.redirect).origin === url.origin ? options.headers : undefined }, redirects + 1);
  }
  return { ...result, url: url.href };
}

export class WebReader {
  constructor(private config: Config['web']) {}
  async read(url: string, signal?: AbortSignal) {
    if (!this.config.enabled) throw new Error('The web tool is disabled.');
    const result = await publicFetch(url, { ...this.config, signal });
    if (!/^(text\/|application\/(json|xml|xhtml\+xml))/.test(result.type)) throw new Error('The resource is not readable text.');
    const text = result.data.toString('utf8').replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    return { url: result.url, text: text.slice(0, 20_000), truncated: text.length > 20_000 };
  }
  async search(query: string, signal?: AbortSignal) {
    if (!this.config.enabled) throw new Error('The web tool is disabled.');
    if (typeof query !== 'string' || !query.trim() || [...query].length > 128) throw new Error('The search query must contain 1 to 128 Unicode characters and must not be entirely whitespace.');
    const key = process.env[this.config.searchKeyEnv];
    if (!key) throw new Error(`The search credential environment variable ${this.config.searchKeyEnv} is not configured; known webpages can still be read directly.`);
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
