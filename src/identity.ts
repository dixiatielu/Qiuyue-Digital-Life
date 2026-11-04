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
  try {
    const ref = { platform: match[1]!, accountId: decodeURIComponent(match[2]!), type: match[3] as ConversationType, id: decodeURIComponent(match[4]!) };
    return conversationRef(ref, ref.type, ref.id) === value ? ref : undefined;
  }
  catch { throw new Error('Invalid encoded conversation identifier.'); }
}

export function requireConversationRef(value: string) {
  const ref = parseConversationRef(value);
  if (!ref || conversationRef(ref, ref.type, ref.id) !== value) throw new Error('Use a canonical platform:account:type:id conversation reference.');
  return ref;
}
export function parsePersonRef(value: string): { platform: string; id: string } | undefined {
  const match = /^([a-z][a-z0-9_-]*):user:([^:]+)$/.exec(value);
  if (!match) return;
  try { const id = decodeURIComponent(match[2]!); return personRef(match[1]!, id) === value ? { platform: match[1]!, id } : undefined; } catch { return; }
}
export function validateSource(source: EventSource) {
  personRef(source.platform, source.accountId);
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(source.instance)) throw new Error('Invalid platform instance.');
  if (source.conversation) { const chat = requireConversationRef(source.conversation); if (chat.platform !== source.platform || chat.accountId !== source.accountId || chat.type !== source.conversationType) throw new Error('Conversation must belong to the event account.'); }
  if (source.actor && parsePersonRef(source.actor)?.platform !== source.platform) throw new Error('Actor must belong to the event platform.');
  if (typeof source.own !== 'boolean' || typeof source.addressed !== 'boolean' || !['normal', 'ambient', 'transport'].includes(source.attention)) throw new Error('Invalid event attention context.');
}
