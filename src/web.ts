import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

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

/** Qzone's CDN (*.qpic.cn) picks the format from t=: 8 gives AVIF and 5 WebP, which QQ rejects on upload. Without it the same image comes as JPEG. */
export function preferJpeg(url: string): string {
  let host: string;
  try { host = new URL(url).hostname; } catch { return url; }
  if (!/(^|\.)qpic\.cn$/.test(host)) return url;
  // Edit the query as text: these URLs carry a bare path-like key that URLSearchParams would re-encode.
  const [base = '', ...fragment] = url.split('#');
  const query = base.indexOf('?');
  if (query < 0) return url;
  const params = base.slice(query + 1).split('&').filter(param => !/^t=/.test(param));
  return [base.slice(0, query + 1) + params.join('&'), ...fragment].join('#');
}
export async function fetchImage(url: string, signal?: AbortSignal) {
  const image = await publicFetch(preferJpeg(url), { timeoutMs: 10_000, maxBytes: 5_000_000, signal });
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.type)) throw new Error('Unsupported image format.');
  return image;
}
