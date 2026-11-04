import { environmentCredential, type CredentialReader } from '../../credentials.js';
import { SnowLumaWebSocketClient, SnowLumaApiError, fromCQString, type SnowLumaAction, type SnowLumaStreamAction } from '@snowluma/sdk';
import { ActionNotDispatchedError, NativeApiError, type SocialAdapter } from '../../platform.js';
import type { AdapterConfig } from '../../config.js';
import type { EnvironmentEvent } from '../../domain.js';
import { isHeartbeat, errorText } from '../../domain.js';
import { conversationRef, personRef } from '../../identity.js';
import { Store, digest } from '../../store.js';
import { allowedSnowLumaAction, findSnowLumaAction } from './catalog.js';

export function normalizeEvent(raw: Record<string, any>, config: AdapterConfig, sent: (id: number) => boolean = () => false): Omit<EnvironmentEvent, 'id' | 'status'> | undefined {
  if (Number(raw.self_id) !== Number(config.accountId) || typeof raw.post_type !== 'string' || !raw.post_type) return;
  const isMessage = ['message', 'message_sent'].includes(raw.post_type);
  const optionalId = (value: unknown) => value != null && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  const groupId = optionalId(raw.group_id);
  // A private poke names the other person as user_id even when this account poked; sender_id is who poked.
  const actorId = optionalId(raw.notice_type === 'notify' && raw.sub_type === 'poke' ? raw.sender_id ?? raw.user_id : raw.user_id);
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
    key: isMessage && raw.message_id != null && conversation !== undefined ? `qq:${Number(config.accountId)}:${conversation}:message:${raw.message_id}` : `qq:${Number(config.accountId)}:${isMessage ? 'message' : raw.post_type}:${digest(raw)}`,
    kind,
    at: Number.isFinite(Number(raw.time)) ? Number(raw.time) * 1000 : Date.now(),
    text,
    source: qqSource(raw, config, kind, groupId, actorId, message, sent),
    payload: isMessage ? { ...raw, message } : { ...raw },
  };
}

/** QQ-native addressing and attention are settled once, at ingestion. */
function qqSource(raw: Record<string, any>, account: AdapterConfig, kind: string, groupId: number | undefined, actorId: number | undefined, segments: any[], sent: (id: number) => boolean): import('../../identity.js').EventSource {
  const self = (value: unknown) => value != null && String(value) === account.accountId;
  const own = self(actorId) || raw.post_type === 'message_sent';
  const type = groupId !== undefined && raw.message_type !== 'private' ? 'group' : 'private';
  const target = type === 'group' ? groupId : raw.post_type === 'message_sent' ? raw.target_id ?? actorId : actorId;
  const addressed = kind.startsWith('notice:') ? (self(raw.target_id) && !own) || (self(raw.user_id) && raw.operator_id != null && !self(raw.operator_id))
    : kind === 'message' && !own && (type === 'private' || segments.some(segment => segment.type === 'at' && self(segment.data?.qq) || segment.type === 'reply' && sent(Number(segment.data?.id))));
  const ambient = kind === 'notice:notify:input_status' || kind.startsWith('notice:group_msg_emoji_like:') || kind === 'notice:notify:poke' && own;
  const identity = { platform: 'qq', accountId: account.accountId };
  return { ...identity, instance: account.id, own, addressed, attention: isHeartbeat(kind) ? 'transport' : ambient ? 'ambient' : 'normal',
    ...(actorId === undefined ? {} : { actor: personRef('qq', String(actorId)), actorName: raw.sender?.card || raw.sender?.nickname }),
    ...(target === undefined || !(kind === 'message' || kind.startsWith('notice:') || groupId !== undefined && kind === 'perception_gap') ? {} : { conversation: conversationRef(identity, type, String(target)), conversationType: type }) };
}

export class SnowLumaAdapter implements SocialAdapter {
  readonly client: SnowLumaWebSocketClient;
  private verified = false;
  private connectedOnce = false;
  private closing = false;
  private recovery?: Promise<void>;
  private anchors = new Map<number, number | undefined>();
  constructor(private config: AdapterConfig, private store: Store, private notify: () => void, credential: CredentialReader = environmentCredential) {
    this.client = new SnowLumaWebSocketClient({ url: config.url ?? 'ws://127.0.0.1:3001', accessToken: credential(config.tokenEnv), reconnect: true, requestTimeoutMs: 20_000 });
    this.client.onEvent(raw => { if (this.closing) return; const event = normalizeEvent(raw as Record<string, unknown>, config, id => store.sentMessage(id, { platform: 'qq', accountId: config.accountId })); if (event && this.receive(event)?.status === 'pending') notify(); });
    this.client.on('close', () => { this.verified = false; if (!this.closing) { this.captureAnchors(); store.log('connection_closed', {}); } });
    this.client.on('error', error => { if (!this.closing) store.log('connection_error', { message: errorText(error) }); });
    this.client.on('open', () => { if (this.connectedOnce && !this.closing) void this.recover().catch(error => { if (!this.closing) store.log('recovery_error', { message: errorText(error) }); }); });
  }
  private receive(event: Omit<EnvironmentEvent, 'id' | 'status'>) { return this.store.receive(event); }
  private captureAnchors() { for (const group of this.config.groups) this.anchors.set(group, this.store.latestGroupMessage(conversationRef({ platform: 'qq', accountId: this.config.accountId }, 'group', String(group)))); }
  async connect() { this.captureAnchors(); await this.client.connect(); this.connectedOnce = true; await this.recover(); }
  async close() { this.closing = true; this.client.close(); await this.recovery?.catch(() => {}); }
  private recover() {
    this.recovery ??= this.verifyAndRecover().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  private async verifyAndRecover() {
    const login = await this.client.getLoginInfo();
    if (this.closing) return;
    if (login.user_id !== Number(this.config.accountId)) { this.client.close(); throw new Error('The SnowLuma account does not match the configured account.'); }
    this.verified = true;
    this.store.log('connection_opened', {});
    this.receive({ key: `gap:snowluma:${Number(this.config.accountId)}:${Date.now()}`, kind: 'perception_gap', at: Date.now(), source: { platform: 'qq', accountId: this.config.accountId, instance: this.config.id, own: true, addressed: false, attention: 'normal' }, text: 'Connection established or restored: receiving all SnowLuma pushes for the current account. Private chats, requests, notices, meta events, and other pushes during the offline period may not be recovered; group message history recovery is attempted only for configured groups.', payload: { historyGroups: this.config.groups } });
    for (const groupId of this.config.groups) {
      const anchor = this.anchors.get(groupId);
      try {
        let messageId = anchor;
        for (let page = 0; page < 10; page++) {
          const history = await this.client.raw('get_group_msg_history', { group_id: groupId, message_id: messageId, count: 100, reverse_order: !anchor });
          if (this.closing) return;
          const messages = history.messages ?? [];
          for (const message of messages) {
            const event = normalizeEvent({ ...message, post_type: 'message', self_id: Number(this.config.accountId), group_id: groupId }, this.config, id => this.store.sentMessage(id, { platform: 'qq', accountId: this.config.accountId }));
            if (event) this.receive(event);
          }
          const next = messages.at(-1)?.message_id;
          if (!anchor || messages.length < 100 || next === messageId || next == null) break;
          messageId = Number(next);
        }
      } catch (error) { if (this.closing) return; this.store.log('history_unavailable', { groupId, message: errorText(error) }); }
      this.receive({ key: `gap:qq:${this.config.accountId}:${groupId}:${Date.now()}`, kind: 'perception_gap', at: Date.now(), source: { platform: 'qq', accountId: this.config.accountId, instance: this.config.id, conversation: conversationRef({ platform: 'qq', accountId: this.config.accountId }, 'group', String(groupId)), conversationType: 'group', own: true, addressed: false, attention: 'normal' }, text: 'Connection established or restored: message history recovery was attempted. Notices and messages outside the recovery scope during the offline period may be incomplete.', payload: { anchor: anchor ?? null } });
    }
    this.notify();
  }
  definition(name: string) { return findSnowLumaAction(name); }
  allowed(name: string) { return allowedSnowLumaAction(this.definition(name), this.config.tools); }
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const action = findSnowLumaAction(name);
    if (!allowedSnowLumaAction(action, this.config.tools)) throw new ActionNotDispatchedError('The operator has not enabled this SnowLuma interface.');
    if (!this.verified || !this.client.isConnected) throw new ActionNotDispatchedError('SnowLuma is not connected or the account has not been verified.');
    try {
      if (action.stream) {
        const frames: unknown[] = []; let bytes = 0;
        for await (const frame of this.client.stream(action.name as SnowLumaStreamAction, args as never, { signal })) {
          bytes += Buffer.byteLength(JSON.stringify(frame), 'utf8');
          if (bytes > this.config.maxStreamBytes) throw new Error('The SnowLuma stream exceeded maxStreamBytes; remote outcome may be unknown.');
          frames.push(frame);
        }
        return frames;
      }
      return await this.client.raw(action.name as SnowLumaAction, args as never, { signal });
    } catch (error) {
      // Keep SDK-specific errors inside this adapter; the host sees a native receipt.
      if (error instanceof SnowLumaApiError) throw new SnowLumaActionError(error.response, action.name);
      throw error;
    }
  }
}

/** Preserve the native error envelope and distinguish a confirmed rejection from an unknown outcome. */
export class SnowLumaActionError extends NativeApiError {
  readonly retcode: number;
  readonly wording?: string;
  constructor(response: SnowLumaApiError['response'], private operation?: string) {
    super(response, response.wording || `SnowLuma API failed with retcode ${response.retcode}`);
    this.retcode = response.retcode; this.wording = response.wording;
  }
  override definitelyFailed(action?: string) {
    // Use the native operation, even when the host dispatches an account-prefixed tool name.
    return [400, 401, 403, 1400, 1401, 1403].includes(this.retcode)
      || (this.operation ?? action) === 'set_diy_online_status' && this.retcode === 100 && this.wording === 'set status fail';
  }
}
