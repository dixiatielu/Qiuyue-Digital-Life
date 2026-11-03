import type { EventSource } from './identity.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface EnvironmentEvent {
  id: string;
  key: string;
  kind: string;
  at: number;
  groupId?: number;
  actorId?: number;
  text: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'processed';
  receivedAt?: number;
  /** Canonical platform context; legacy QQ numeric fields remain readable. */
  source?: EventSource;
}
export type MemoryKind = 'experience' | 'understanding' | 'fiction' | 'note' | DevelopmentKind;
/** The digital life's own development (ADR-0012): always supplied by scope, never left to chance recall. */
export type DevelopmentKind = 'habit' | 'practice' | 'impression';
export const developmentKinds: readonly DevelopmentKind[] = ['habit', 'practice', 'impression'];
export const isDevelopment = (kind: string): kind is DevelopmentKind => (developmentKinds as readonly string[]).includes(kind);
export interface Memory {
  id: string;
  kind: MemoryKind;
  title: string;
  content: string;
  importance: number;
  subjects: string[];
  groups: number[];
  fictional: boolean;
  sources: string[];
  supersedes?: string;
  /** Where development applies: global, group:<id>, or person:<qq>. Absent for other kinds. */
  scope?: string;
  active: boolean;
  createdAt: number;
}
export interface Wake {
  id: string;
  title: string;
  kind: 'life' | 'commitment';
  dueAt: number;
  status: 'pending' | 'queued' | 'done' | 'cancelled';
  /** The digital life rests until this wake: no free-time wake comes before it (ADR-0015). */
  rest?: boolean;
}
/** Something pursued over days, such as a song being learned or a series being followed, with where it stands now. */
export interface Pursuit {
  id: string;
  title: string;
  progress: string;
  fictional: boolean;
  status: 'active' | 'done' | 'dropped';
  startedAt: number;
  updatedAt: number;
}
export interface Action {
  id: string;
  key: string;
  fingerprint: string;
  kind: string;
  args: Record<string, unknown>;
  sources: string[];
  status: 'pending' | 'success' | 'failed' | 'unknown';
  result: unknown;
  createdAt: number;
  conversation?: string;
}
export interface Observation {
  batchId: string;
  events: EnvironmentEvent[];
}
export interface LifeSettings {
  paused: boolean;
  lifeEnabled: boolean;
  generation: number;
  activity: string;
}
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const isHeartbeat = (kind: string): boolean => kind === 'meta_event:heartbeat' || kind.startsWith('meta_event:heartbeat:');
/** Low-information signals ride along with other observations; they never start or steer a thought on their own. QQ pushes the digital life's own pokes back as notices that say no more than the poke's receipt. */
export const isAmbient = (kind: string, actorId?: number, selfId?: number): boolean => kind === 'notice:notify:input_status' || kind.startsWith('notice:group_msg_emoji_like:') || (kind === 'notice:notify:poke' && actorId !== undefined && actorId === selfId);
/** The chat a message or notice happened in: group:<id> or private:<qq>. */
export function eventChat(event: Pick<EnvironmentEvent, 'kind' | 'groupId' | 'actorId' | 'payload' | 'source'>): string | undefined {
  if (event.source) return event.source.conversation;
  if (event.kind !== 'message' && !event.kind.startsWith('notice:')) return;
  if (event.groupId !== undefined && event.payload.message_type !== 'private') return `group:${event.groupId}`;
  return event.actorId === undefined ? undefined : `private:${event.actorId}`;
}
/** Addressed to the digital life (ADR-0002): any message from the other person in a private chat; in a group, a message that mentions it or replies to one it sent. A notice is addressed to it when it is the target, as of a poke, or when someone else did something to it, such as banning it or inviting it in. */
export function addressedTo(selfId: number, event: Pick<EnvironmentEvent, 'kind' | 'groupId' | 'actorId' | 'payload' | 'source'>, sent: (messageId: number) => boolean): boolean {
  if (event.source) return event.source.addressed;
  const self = (value: unknown) => value != null && Number(value) === selfId;
  if (event.kind.startsWith('notice:')) return (self(event.payload.target_id) && !self(event.actorId)) || (self(event.payload.user_id) && event.payload.operator_id != null && !self(event.payload.operator_id));
  if (event.kind !== 'message' || self(event.actorId)) return false;
  if (eventChat(event)?.startsWith('private:')) return true;
  const segments = (Array.isArray(event.payload.message) ? event.payload.message : []) as { type?: string; data?: Record<string, unknown> }[];
  return segments.some(segment => (segment.type === 'at' && self(segment.data?.qq)) || (segment.type === 'reply' && sent(Number(segment.data?.id))));
}

export const ambientEvent = (event: EnvironmentEvent, selfId?: number) => event.source ? event.source.attention !== 'normal' : isAmbient(event.kind, event.actorId, selfId);
export const ownEvent = (event: EnvironmentEvent, selfId?: number) => event.source ? event.source.own : event.actorId !== undefined && event.actorId === selfId;
