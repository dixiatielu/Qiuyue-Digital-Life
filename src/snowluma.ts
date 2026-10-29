import { SnowLumaWebSocketClient, SnowLumaApiError, fromCQString, type SnowLumaAction, type SnowLumaStreamAction } from '@snowluma/sdk';
import type { Config } from './config.js';
import type { EnvironmentEvent } from './domain.js';
import { errorText } from './domain.js';
import { Store, digest } from './store.js';
import { allowedSnowLumaAction, findSnowLumaAction } from './snowluma-catalog.js';

export interface SocialAdapter {
  execute(action: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}
export class ActionNotDispatchedError extends Error {}
export function normalizeEvent(raw: Record<string, any>, config: Config['snowluma']): Omit<EnvironmentEvent, 'id' | 'status'> | undefined {
  if (Number(raw.self_id) !== config.selfId || typeof raw.post_type !== 'string' || !raw.post_type) return;
  const isMessage = ['message', 'message_sent'].includes(raw.post_type);
  const optionalId = (value: unknown) => value != null && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  const groupId = optionalId(raw.group_id);
  const actorId = optionalId(raw.user_id);
  const segments = !isMessage ? [] : typeof raw.message === 'string' ? fromCQString(raw.message).toSegments() : raw.message;
  const message = Array.isArray(segments) ? segments : [];
  const text = message.map((segment: any) => {
    if (segment.type === 'text') return String(segment.data?.text ?? '');
    if (segment.type === 'at') return `[@${segment.data?.qq}]`;
    if (segment.type === 'reply') return `[Quoted message ${segment.data?.id}]`;
    if (segment.type === 'face') return `[face ${segment.data?.id}]`;
    return `[${segment.type}]`;
  }).join('') || String(raw.raw_message ?? raw.notice_type ?? raw.request_type ?? raw.meta_event_type ?? raw.post_type);
  const eventType = raw.notice_type ?? raw.request_type ?? raw.meta_event_type;
  const kind = isMessage ? 'message' : [raw.post_type, eventType, raw.sub_type ?? ''].filter(value => value !== undefined).join(':');
  const conversation = raw.message_type !== 'private' && groupId !== undefined ? `group:${groupId}` : actorId === undefined ? undefined : `private:${actorId}`;
  return {
    key: isMessage && raw.message_id != null && conversation !== undefined ? `qq:${config.selfId}:${conversation}:message:${raw.message_id}` : `qq:${config.selfId}:${isMessage ? 'message' : raw.post_type}:${digest(raw)}`,
    kind,
    at: Number.isFinite(Number(raw.time)) ? Number(raw.time) * 1000 : Date.now(),
    groupId, actorId, text,
    payload: isMessage ? { ...raw, message } : { ...raw },
  };
}

export class SnowLumaAdapter implements SocialAdapter {
  readonly client: SnowLumaWebSocketClient;
  private verified = false;
  private connectedOnce = false;
  private closing = false;
  private recovery?: Promise<void>;
  private anchors = new Map<number, number | undefined>();
  constructor(private config: Config['snowluma'], private store: Store, private notify: () => void) {
    this.client = new SnowLumaWebSocketClient({ url: config.url, accessToken: process.env[config.tokenEnv], reconnect: true, requestTimeoutMs: 20_000 });
    this.client.onEvent(raw => { if (this.closing) return; const event = normalizeEvent(raw as Record<string, unknown>, config); if (event && store.receive(event)?.status === 'pending') notify(); });
    this.client.on('close', () => { this.verified = false; if (!this.closing) { this.captureAnchors(); store.log('connection_closed', {}); } });
    this.client.on('error', error => { if (!this.closing) store.log('connection_error', { message: errorText(error) }); });
    this.client.on('open', () => { if (this.connectedOnce && !this.closing) void this.recover().catch(error => { if (!this.closing) store.log('recovery_error', { message: errorText(error) }); }); });
  }
  private captureAnchors() { for (const group of this.config.groups) this.anchors.set(group, this.store.latestGroupMessage(group)); }
  async connect() { this.captureAnchors(); await this.client.connect(); this.connectedOnce = true; await this.recover(); }
  async close() { this.closing = true; this.client.close(); await this.recovery?.catch(() => {}); }
  private recover() {
    this.recovery ??= this.verifyAndRecover().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  private async verifyAndRecover() {
    const login = await this.client.getLoginInfo();
    if (this.closing) return;
    if (login.user_id !== this.config.selfId) { this.client.close(); throw new Error('The SnowLuma account does not match the configured account.'); }
    this.verified = true;
    this.store.log('connection_opened', {});
    this.store.receive({ key: `gap:snowluma:${this.config.selfId}:${Date.now()}`, kind: 'perception_gap', at: Date.now(), text: 'Connection established or restored: receiving all SnowLuma pushes for the current account. Private chats, requests, notices, meta events, and other pushes during the offline period may not be recovered; group message history recovery is attempted only for configured groups.', payload: { selfId: this.config.selfId, historyGroups: this.config.groups } });
    for (const groupId of this.config.groups) {
      const anchor = this.anchors.get(groupId);
      try {
        let messageId = anchor;
        for (let page = 0; page < 10; page++) {
          const history = await this.client.raw('get_group_msg_history', { group_id: groupId, message_id: messageId, count: 100, reverse_order: !anchor });
          if (this.closing) return;
          const messages = history.messages ?? [];
          for (const message of messages) {
            const event = normalizeEvent({ ...message, post_type: 'message', self_id: this.config.selfId, group_id: groupId }, this.config);
            if (event) this.store.receive(event);
          }
          const next = messages.at(-1)?.message_id;
          if (!anchor || messages.length < 100 || next === messageId || next == null) break;
          messageId = Number(next);
        }
      } catch (error) { if (this.closing) return; this.store.log('history_unavailable', { groupId, message: errorText(error) }); }
      this.store.receive({ key: `gap:${groupId}:${Date.now()}`, kind: 'perception_gap', at: Date.now(), groupId, text: 'Connection established or restored: message history recovery was attempted. Notices and messages outside the recovery scope during the offline period may be incomplete.', payload: { anchor: anchor ?? null } });
    }
    this.notify();
  }
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const action = findSnowLumaAction(name);
    if (!allowedSnowLumaAction(action, this.config.tools)) throw new ActionNotDispatchedError('The operator has not enabled this SnowLuma interface.');
    if (!this.verified || !this.client.isConnected) throw new ActionNotDispatchedError('SnowLuma is not connected or the account has not been verified.');
    if (action.stream) {
      const frames: unknown[] = []; let bytes = 0;
      for await (const frame of this.client.stream(action.name as SnowLumaStreamAction, args as never, { signal })) {
        bytes += Buffer.byteLength(JSON.stringify(frame), 'utf8');
        if (bytes > this.config.maxStreamBytes) throw new Error('The SnowLuma stream exceeded maxStreamBytes; reception stopped and the remote outcome may be unknown.');
        frames.push(frame);
      }
      return frames;
    }
    return this.client.raw(action.name as SnowLumaAction, args as never, { signal });
  }
}
export const definitelyFailed = (error: unknown): boolean => error instanceof ActionNotDispatchedError || (error instanceof SnowLumaApiError && [400, 401, 403, 1400, 1401, 1403].includes(error.retcode));
