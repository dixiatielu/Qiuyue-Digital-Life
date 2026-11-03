export interface PlatformIdentity { platform: string; accountId: string }
export type ConversationType = 'private' | 'group' | 'channel' | 'thread';
export interface EventSource extends PlatformIdentity {
  instance: string;
  conversation?: string;
  conversationType?: ConversationType;
  actor?: string;
  actorName?: string;
  own: boolean;
  addressed: boolean;
  attention: 'normal' | 'ambient' | 'transport';
}
const part = (value: string) => {
  if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Platform identifiers must be non-empty strings of at most 256 characters.');
  return encodeURIComponent(value);
};
export function conversationRef(identity: PlatformIdentity, type: ConversationType, id: string): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(identity.platform)) throw new Error('Invalid platform identifier.');
  if (!['private', 'group', 'channel', 'thread'].includes(type)) throw new Error('Invalid conversation type.');
  return `${identity.platform}:${part(identity.accountId)}:${type}:${part(id)}`;
}
export function personRef(platform: string, id: string): string { if (!/^[a-z][a-z0-9_-]*$/.test(platform)) throw new Error('Invalid platform identifier.'); return `${platform}:user:${part(id)}`; }
export function parseConversationRef(value: string): { platform: string; accountId: string; type: ConversationType; id: string } | undefined {
  const match = /^([a-z][a-z0-9_-]*):([^:]+):(private|group|channel|thread):([^:]+)$/.exec(value);
  if (!match) return;
  try { return { platform: match[1]!, accountId: decodeURIComponent(match[2]!), type: match[3] as ConversationType, id: decodeURIComponent(match[4]!) }; }
  catch { throw new Error('Invalid encoded conversation identifier.'); }
}
