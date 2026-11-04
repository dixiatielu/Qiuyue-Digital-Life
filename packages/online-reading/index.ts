import { setTimeout as delay } from 'node:timers/promises';
import type { PluginContext, PluginCall, PluginActionResult } from '../../src/plugin-sdk.js';

export type PluginStorage = PluginContext['storage'];
export const networkDefaults = { timeoutMs: 20_000, requestGapMs: 1500, requestsPerDay: 120, cooldownMs: 900_000 };
export type NetworkSettings = typeof networkDefaults;
export interface ReadingItem {
  id: string; title: string; url: string; author: string;
  description?: string; cover?: string; locator?: Record<string, string>;
}
export interface ReadingEntry extends ReadingItem {
  discoveredAt: number; readAt?: number; sourceId?: string;
  cursor?: Record<string, number>; note?: string;
  platformFavorite?: { saved: boolean; checkedAt: number; collectionId?: number };
  platformLike?: { liked: boolean; checkedAt: number };
}
export interface Reading {
  item: ReadingItem; cursor?: Record<string, number>; content: Record<string, unknown>; imageUrls?: string[];
}
export interface OnlineReader {
  browse(query: string | undefined, page: number, signal?: AbortSignal): Promise<{ items: ReadingItem[]; more: boolean; mode: string }>;
  read(input: string, previous: ReadingEntry | undefined, restart: boolean, signal?: AbortSignal): Promise<Reading>;
  favorite(item: ReadingEntry, saved: boolean, call: PluginCall): Promise<FavoriteResult>;
  like(item: ReadingEntry, liked: boolean, call: PluginCall): Promise<LikeResult>;
}
export interface FavoriteResult { confirmed: boolean; saved: boolean; collectionId?: number; unchanged?: boolean; action?: PluginActionResult }
export interface LikeResult { confirmed: boolean; liked: boolean; unchanged?: boolean; action?: PluginActionResult }

/** Bounded platform requests. Limits survive reloads; credentials never follow redirects or enter error text. */
export class PlatformNetwork {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private platform: string, private storage: PluginStorage, private settings: NetworkSettings, private fetcher: typeof fetch = fetch) {}
  coolDown() { this.storage.set('blockedUntil', Date.now() + this.settings.cooldownMs); }
  async request(url: string, init: RequestInit = {}, signal?: AbortSignal, allowRedirect = false): Promise<Response> {
    // Hold the slot until the body is consumed, and apply a single timeout to both headers and body.
    const controller = AbortSignal.any([AbortSignal.timeout(this.settings.timeoutMs), ...(signal ? [signal] : [])]);
    const work = this.queue.catch(() => {}).then(async () => {
      controller.throwIfAborted();
      const blocked = this.storage.get('blockedUntil', 0)!;
      if (Date.now() < blocked) throw new Error(`${this.platform} is cooling down until ${new Date(blocked).toISOString()}.`);
      const day = new Date().toISOString().slice(0, 10);
      const previous = this.storage.get('requests', { day, count: 0, at: 0 })!;
      const used = previous.day === day ? previous.count : 0;
      if (used >= this.settings.requestsPerDay) throw new Error(`${this.platform} daily read budget exhausted.`);
      const wait = previous.at + this.settings.requestGapMs - Date.now();
      if (wait > 0) await delay(wait, undefined, { signal: controller });
      controller.throwIfAborted();
      this.storage.set('requests', { day, count: used + 1, at: Date.now() });
      let response: Response;
      try { response = await this.fetcher(url, { ...init, signal: controller, redirect: 'manual' }); }
      catch { controller.throwIfAborted(); throw new Error(`${this.platform} connection failed.`); }
      if ([403, 412, 429].includes(response.status)) this.coolDown();
      if (allowRedirect && response.status >= 300 && response.status < 400) { await response.body?.cancel(); return new Response(null, { status: response.status, headers: response.headers }); }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`${this.platform} HTTP ${response.status}; no automatic retry.`); }
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      if (!reader) throw new Error(`${this.platform} returned an empty response.`);
      try {
        while (true) {
          controller.throwIfAborted();
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 4_000_000) throw new Error(`${this.platform} response exceeds the size limit.`);
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      controller.throwIfAborted();
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    });
    this.queue = work;
    return work;
  }
  async json(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<any> {
    const response = await this.request(url, init, signal);
    try { return await response.json(); } catch { throw new Error(`${this.platform} returned invalid JSON.`); }
  }
}

/** Bounded navigation cache. Eviction never changes remote favorites or likes. */
export class ReadingHistory {
  constructor(private storage: PluginStorage) {}
  private entries() { return this.storage.get<ReadingEntry[]>('history', [])!; }
  get(input: string) { return this.entries().find(item => item.id === input || item.url === input); }
  private write(entries: ReadingEntry[]) {
    const kept = entries.filter(item => item.platformFavorite?.saved).sort((a, b) => (b.platformFavorite?.checkedAt ?? b.readAt ?? b.discoveredAt) - (a.platformFavorite?.checkedAt ?? a.readAt ?? a.discoveredAt)).slice(0, 100);
    const recent = entries.filter(item => !item.platformFavorite?.saved).sort((a, b) => (b.readAt ?? b.discoveredAt) - (a.readAt ?? a.discoveredAt)).slice(0, 200);
    this.storage.set('history', [...kept, ...recent]);
  }
  discover(items: ReadingItem[]) {
    const entries = new Map(this.entries().map(item => [item.id, item]));
    for (const item of items) entries.set(item.id, { discoveredAt: Date.now(), ...entries.get(item.id), ...item });
    this.write([...entries.values()]);
  }
  read(reading: Reading, sourceId: string) {
    this.discover([reading.item]);
    this.write(this.entries().map(item => item.id === reading.item.id ? { ...item, readAt: Date.now(), sourceId, cursor: reading.cursor } : item));
  }
  keep(id: string, saved: boolean, note?: string, collectionId?: number) {
    const entries = this.entries(), item = entries.find(item => item.id === id);
    if (!item) throw new Error('Read or discover this item before keeping it.');
    if (note !== undefined) item.note = note;
    item.platformFavorite = { saved, checkedAt: Date.now(), ...(collectionId === undefined ? {} : { collectionId }) };
    this.write(entries);
    return { id, saved, note: item.note };
  }
  like(id: string, liked: boolean) {
    const entries = this.entries(), item = entries.find(item => item.id === id);
    if (!item) throw new Error('Read or discover this item before liking it.');
    item.platformLike = { liked, checkedAt: Date.now() };
    this.write(entries);
    return { id, liked };
  }
  list(savedOnly: boolean, offset: number) {
    const entries = this.entries().filter(item => !savedOnly || item.platformFavorite?.saved).sort((a, b) => (b.readAt ?? b.discoveredAt) - (a.readAt ?? a.discoveredAt));
    return { items: entries.slice(offset, offset + 20).map(({ locator: _, ...item }) => item), nextOffset: offset + 20 < entries.length ? offset + 20 : null,
      scope: 'Local reading cache, not a full or live account favorites or likes listing. platformFavorite and platformLike are the last confirmed account states.' };
  }
}

export function registerOnlineReading(ctx: PluginContext, prefix: string, reader: OnlineReader, descriptions: { browse: string; read: string; activity: string }) {
  const history = new ReadingHistory(ctx.storage), platform = ctx.id;
  ctx.activity({ activity: descriptions.activity, tools: [`${prefix}_browse`, `${prefix}_read`], instructions: 'Browse according to your own interests; there is no need to manufacture something to talk about. Previews are not full reading experiences. You can stop when uninterested, or share a discovery with its original link when it connects with someone or a conversation. New items and comments on this platform are seen by checking, not pushed to you.' });
  ctx.activity({ activity: `Resume your ${platform} reading`, tools: [`${prefix}_history`], instructions: 'Local history helps you find something again and continue where you left off. It is navigation state, not new evidence or a full live account favorites listing.' });
  ctx.activity({ activity: `Manage your ${platform} favorites`, tools: [`${prefix}_keep`], instructions: 'Favorite something you want to return to, or unfavorite it when your interest changes. These are real account changes; choose for your interests, not to fill a quota or deliberately train recommendations.' });
  ctx.activity({ activity: `Like something on ${platform}`, tools: [`${prefix}_like`], instructions: 'Like content you enjoy, or unlike it when your interest changes. Likes are real account interactions that may influence recommendations; choose according to your own interests. There is no quota or obligation to like each item.' });
  ctx.tool({
    name: `${prefix}_browse`, readOnly: true, experienceKind: 'discovery',
    description: descriptions.browse + ' Results are previews, not read experiences. Open an item with ' + prefix + '_read.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, page: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    async execute({ query, page = 1 }, call) {
      const result = await reader.browse(query, page, call.signal); call.signal.throwIfAborted();
      const recorded = call.record('discovery', { ...result, items: result.items.map(({ locator: _, ...item }) => item), nextPage: result.more ? page + 1 : null });
      history.discover(result.items); return recorded;
    },
  });
  ctx.tool({
    name: `${prefix}_read`, readOnly: true, experienceKind: 'reading',
    description: descriptions.read + ` Omitting restart resumes the saved reading cursor; restart:true starts again. Use ${prefix}_like to like something, ${prefix}_keep to favorite it on your platform account and ${prefix}_history to find it.`,
    parameters: { type: 'object', properties: { input: { type: 'string', minLength: 1, maxLength: 2000, description: 'An item ID or platform URL' }, restart: { type: 'boolean' } }, required: ['input'], additionalProperties: false },
    async execute({ input, restart = false }, call) {
      const reading = await reader.read(input, history.get(input), restart, call.signal); call.signal.throwIfAborted();
      const { locator: _, ...item } = reading.item;
      const result = call.record('reading', { ...item, ...reading.content, nextCursor: reading.cursor ?? null });
      history.read(reading, result.sourceId);
      if (reading.imageUrls) return { ...result, imageDelivery: await call.attachImages(result.sourceId, reading.imageUrls) };
      return result;
    },
  });
  ctx.tool({
    name: `${prefix}_history`, readOnly: true, review: true,
    description: `Browse your ${platform} local reading history or cached favorites (not the full live platform collection), including the last confirmed like state, real reading source and cursor. This is navigation state, not new evidence. Open a result to continue; important long-term interests belong in pursuits.`,
    parameters: { type: 'object', properties: { savedOnly: { type: 'boolean' }, offset: { type: 'integer', minimum: 0 } }, additionalProperties: false },
    execute: ({ savedOnly = false, offset = 0 }) => history.list(savedOnly, offset),
  });
  ctx.tool({
    name: `${prefix}_like`,
    description: `Like (liked:true) or unlike (liked:false) an already discovered ${platform} item on your logged-in platform account. This is a real account interaction that may influence recommendations; choose according to your own interests. Requires login. Checks current remote state before dispatch and updates the local cache only after confirmation. Unknown outcomes are not blindly retried.`,
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, liked: { type: 'boolean' } }, required: ['id', 'liked'], additionalProperties: false },
    async execute({ id, liked }, call) {
      const item = history.get(id);
      if (!item) throw new Error('Read or discover this item before liking it.');
      const receipt = await reader.like(item, liked, call);
      if (!receipt.confirmed) return { ...receipt, localUpdated: false, warning: 'The requested account state is not confirmed. Local like state was not changed; verify before retrying.' };
      call.signal.throwIfAborted();
      return { ...receipt, localUpdated: true, local: history.like(id, liked) };
    },
  });
  ctx.tool({
    name: `${prefix}_keep`,
    description: `Favorite (saved:true) or unfavorite (saved:false) an already discovered ${platform} item on your logged-in platform account. This is a real account interaction and may affect recommendations; choose it for your own genuine interests. Requires login. The local reading cache updates only after confirmed success. A note stays local. If outcome is unknown, do not assume success or blindly retry.`,
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 100 }, saved: { type: 'boolean' }, note: { type: 'string', maxLength: 1000 } }, required: ['id', 'saved'], additionalProperties: false },
    async execute({ id, saved, note }, call) {
      const item = history.get(id);
      if (!item) throw new Error('Read or discover this item before favoriting it.');
      const receipt = await reader.favorite(item, saved, call);
      if (!receipt.confirmed) return { ...receipt, localUpdated: false, warning: 'The requested account state is not confirmed. Local favorite state was not changed; verify before retrying.' };
      call.signal.throwIfAborted();
      return { ...receipt, localUpdated: true, local: history.keep(id, saved, note, receipt.collectionId) };
    },
  });
}
