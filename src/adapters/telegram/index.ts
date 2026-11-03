import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { telegramCatalog as catalog } from './catalog.js';
import type { AdapterContext, NativeAdapterDefinition } from '../../plugin-sdk.js';
import { ActionNotDispatchedError, NativeApiError, permits } from '../../platform.js';
import type { CredentialReader } from '../../credentials.js';
import type { AdapterConfig } from '../../config.js';

export { telegramCatalog } from './catalog.js';
export class TelegramClient {
  constructor(private baseUrl: string, private token: string, private fetcher: typeof fetch = fetch, private maxFileBytes = 50_000_000) {}
  async image(fileId: string, signal: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
    try {
      const info = await this.call('getFile', { file_id: fileId }, signal);
      if (typeof info.file_path !== 'string' || info.file_path.split('/').some((part: string) => part === '..') || info.file_size > 5_000_000) throw new Error('Unavailable file');
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/file/bot${this.token}/${info.file_path.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), redirect: 'error' });
      const mimeType = response.headers.get('content-type')?.split(';')[0] ?? '';
      if (!response.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) throw new Error('Unsupported image');
      const reader = response.body?.getReader(); if (!reader) throw new Error('No image');
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 5_000_000) { await reader.cancel(); throw new Error('Image too large'); } chunks.push(chunk.value); }
      return { data: Buffer.concat(chunks), mimeType };
    } catch { throw new Error('Telegram image unavailable; its appearance has not been perceived.'); }
  }
  async call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    signal?.throwIfAborted();
    const form = new FormData(); let files = 0;
    const convert = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(convert));
      if (!value || typeof value !== 'object') return value;
      const item = value as Record<string, unknown>;
      if (typeof item.file === 'string' && Object.keys(item).every(key => ['file', 'filename', 'contentType'].includes(key))) {
        const path = item.file.startsWith('file:') ? fileURLToPath(item.file) : item.file;
        let bytes: Buffer;
        try {
          const info = await stat(path); if (!info.isFile() || info.size > this.maxFileBytes) throw new Error('size');
          bytes = await readFile(path, { signal }); if (bytes.length > this.maxFileBytes) throw new Error('size');
        } catch { throw new ActionNotDispatchedError('Cannot read this upload, or it exceeds the configured file limit.'); }
        const name = `upload_${files++}`;
        form.append(name, new Blob([new Uint8Array(bytes)], { type: typeof item.contentType === 'string' ? item.contentType : 'application/octet-stream' }), typeof item.filename === 'string' ? item.filename : path.split('/').at(-1)!);
        return `attach://${name}`;
      }
      return Object.fromEntries(await Promise.all(Object.entries(item).map(async ([key, val]) => [key, await convert(val)])));
    };
    const body = await convert(args) as Record<string, unknown>;
    if (files) for (const [key, value] of Object.entries(body)) if (value !== undefined) form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/bot${this.token}/${operation}`, { method: 'POST', headers: files ? {} : { 'Content-Type': 'application/json' }, body: files ? form : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]), redirect: 'error' });
      const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response');
      let length = 0; const chunks: Uint8Array[] = [];
      while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 32_000_000) { await reader.cancel(); throw new Error('Response too large'); } chunks.push(chunk.value); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (result.ok === false) throw new NativeApiError(result, `Telegram ${operation} failed (code ${result.error_code ?? response.status}).`, response.status < 500 && Number(result.error_code) < 500 ? 'failed' : 'unknown');
      if (!response.ok || result.ok !== true || !Object.hasOwn(result, 'result')) throw new Error('Invalid response');
      return result.result;
    } catch (error) {
      if (error instanceof NativeApiError) throw error;
      // Fetch errors can contain the request URL, which includes the bot token.
      throw new NativeApiError({ message: 'Telegram transport failed; execution outcome is unknown.' }, 'Telegram transport failed; execution outcome is unknown.');
    }
  }
}

export function telegramAdapter(config: AdapterConfig, credential: CredentialReader, fetcher: typeof fetch = fetch): NativeAdapterDefinition {
  const token = credential(config.tokenEnv) ?? '';
  const client = new TelegramClient(config.url ?? 'https://api.telegram.org', token, fetcher, config.maxFileBytes);
  let context: AdapterContext | undefined, polling: Promise<void> | undefined, pollAbort: AbortController | undefined;
  let webhook = false, username = '', ready = false;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.catch(() => {}).then(work); queue = next; return next; };
  const rememberChat = (chat: any) => {
    if (chat?.id !== undefined && ['private', 'group', 'supergroup', 'channel'].includes(chat.type)) { context!.storage.set(`chat:${chat.id}`, chat.type === 'supergroup' ? 'group' : chat.type); if (typeof chat.username === 'string') context!.storage.set(`alias:@${chat.username.toLowerCase()}`, String(chat.id)); }
  };
  const resultChats = (result: any, operation: string, args: Record<string, unknown>) => {
    for (const item of Array.isArray(result) ? result : [result]) {
      rememberChat(item?.chat); rememberChat(item);
      const chat = item?.chat?.id ?? args.chat_id;
      if (item?.chat?.id !== undefined && typeof args.chat_id === 'string' && args.chat_id.startsWith('@')) context!.storage.set(`alias:${args.chat_id.toLowerCase()}`, String(item.chat.id));
      if (/^(send|copy|forward)/.test(operation) && chat !== undefined && item?.message_id !== undefined) context!.storage.set(`sent:${chat}:${item.message_id}`, true);
    }
    return result;
  };
  const persist = (updates: any[]) => {
    if (!Array.isArray(updates)) throw new Error('Invalid Telegram updates.');
    for (const update of updates) {
      if (!Number.isSafeInteger(update.update_id)) throw new Error('Invalid Telegram update ID.');
      const entry = Object.entries(update).find(([name]) => name !== 'update_id');
      if (!entry) continue;
      const [kind, data] = entry as [string, any];
      const message = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'business_message', 'edited_business_message'].includes(kind) ? data : data.message;
      const chat = message?.chat ?? data.chat;
      rememberChat(chat);
      const actor = data.from ?? data.user ?? message?.from;
      const text = String(message?.text ?? message?.caption ?? data.data ?? data.query ?? `[${kind}]`);
      const thread = message?.message_thread_id ?? message?.direct_messages_topic?.topic_id;
      const type = thread !== undefined ? 'thread' : chat?.type === 'private' ? 'private' : chat?.type === 'channel' ? 'channel' : 'group';
      const own = String(actor?.id) === config.accountId || !!(chat && message?.message_id !== undefined && context!.storage.get(`sent:${chat.id}:${message.message_id}`, false));
      const entities = message?.entities ?? message?.caption_entities ?? [];
      const addressed = !own && (chat?.type === 'private' || kind === 'callback_query' || kind === 'inline_query' || String(message?.reply_to_message?.from?.id) === config.accountId || entities.some((entity: any) => entity.type === 'text_mention' && String(entity.user?.id) === config.accountId || entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username.toLowerCase()}`));
      context!.publish({ key: `update:${update.update_id}`, kind: message && !data.message ? 'message' : `notice:${kind}`, at: Number.isFinite(message?.edit_date ?? message?.date) ? (message.edit_date ?? message.date) * 1000 : Date.now(), text,
        payload: update, ...(chat ? { conversation: { type, id: thread === undefined ? String(chat.id) : `${chat.id}/${thread}` } } : {}),
        ...(actor ? { actor: String(actor.id), actorName: [actor.first_name, actor.last_name].filter(Boolean).join(' ') || actor.username } : {}), own, addressed,
        attention: own || ['message_reaction', 'message_reaction_count'].includes(kind) ? 'ambient' : 'normal',
      });
    }
    if (updates.length) context!.storage.set('offset', Math.max(context!.storage.get<number>('offset', 0)!, ...updates.map(update => update.update_id + 1)));
  };
  const poll = async () => {
    while (!context!.signal.aborted) {
      if (webhook) { await delay(1000, undefined, { signal: context!.signal }).catch(() => {}); continue; }
      try {
        await serial(async () => {
          if (webhook || context!.signal.aborted) return;
          pollAbort = new AbortController();
          const updates = await client.call('getUpdates', { offset: context!.storage.get('offset', 0), timeout: 30, allowed_updates: (catalog.actions.find(action => action.name === 'getUpdates')!.inputSchema.properties as any).allowed_updates.items.enum }, AbortSignal.any([context!.signal, pollAbort.signal]));
          persist(updates);
        });
        // Also prevents a hot loop against a local server returning empty polls immediately.
        await delay(50, undefined, { signal: context!.signal });
      } catch {
        if (!context!.signal.aborted) await delay(1000, undefined, { signal: context!.signal }).catch(() => {});
      }
    }
  };
  return {
    instance: config.id, platform: 'telegram', accountId: config.accountId, version: `@grammyjs/types ${catalog.source.version}`, actions: catalog.actions, permissions: config.tools,
    conversation: (_operation, args) => {
      if (args.chat_id === undefined) return;
      const target = String(args.chat_id);
      const chat = target.startsWith('@') ? context?.storage.get<string>(`alias:${target.toLowerCase()}`, target) ?? target : target;
      const topic = args.message_thread_id ?? args.direct_messages_topic_id;
      if (topic !== undefined) return { type: 'thread', id: `${chat}/${topic}` };
      const known = context?.storage.get<'private' | 'group' | 'channel'>(`chat:${chat}`);
      const type = known ?? (/^[1-9][0-9]*$/.test(chat) ? 'private' : undefined);
      return type ? { type, id: chat } : undefined;
    },
    images: event => {
      const payload = event.payload as Record<string, any>;
      const data = payload.message ?? payload.edited_message ?? payload.channel_post ?? payload.edited_channel_post ?? payload.business_message ?? payload.edited_business_message ?? payload.callback_query?.message;
      const photo = data?.photo?.at(-1);
      const media = photo ?? (data?.document?.mime_type?.startsWith('image/') ? data.document : undefined) ?? data?.sticker?.thumbnail;
      if (!media?.file_id || !permits(config.tools, 'getFile')) return [];
      return [{ label: `Telegram ${photo ? 'photo' : data?.document ? 'image document' : 'sticker thumbnail'} from event ${event.id}`, load: signal => client.image(media.file_id, signal) }];
    },
    start: async ctx => {
      if (!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) throw new Error(`Missing or invalid credential ${config.tokenEnv}.`);
      context = ctx;
      const me = await client.call('getMe', {}, ctx.signal);
      if (String(me.id) !== config.accountId) throw new Error(`Telegram account does not match adapter ${config.id}.`);
      username = String(me.username ?? '');
      const info = await client.call('getWebhookInfo', {}, ctx.signal); webhook = !!info.url;
      ready = true;
      ctx.publish({ key: `connection:${Date.now()}`, kind: 'perception_gap', text: webhook ? 'Telegram is connected, but an existing webhook owns incoming updates. Native tools are available. deleteWebhook resumes polling when reception is set to polling.' : 'Telegram connected. Polling resumes from the persisted update offset; updates that expired while offline cannot be recovered.', payload: { reception: config.receive, webhook } });
      if (config.receive !== 'manual') polling = poll();
    },
    execute: async (operation, args, signal) => {
      if (!ready) throw new ActionNotDispatchedError('Telegram account has not been verified.');
      if (['getUpdates', 'setWebhook', 'deleteWebhook', 'close', 'logOut'].includes(operation)) {
        pollAbort?.abort();
        return serial(async () => {
          const result = await client.call(operation, args, signal);
          if (operation === 'getUpdates') persist(result);
          if (operation === 'setWebhook') webhook = !!args.url;
          if (operation === 'deleteWebhook') webhook = false;
          if (operation === 'close' || operation === 'logOut') { ready = false; webhook = true; }
          return result;
        });
      }
      return resultChats(await client.call(operation, args, signal), operation, args);
    },
    stop: async () => { ready = false; pollAbort?.abort(); await polling; },
  };
}
