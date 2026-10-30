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
export function eventChat(event: EnvironmentEvent): string | undefined {
  if (event.kind !== 'message' && !event.kind.startsWith('notice:')) return;
  if (event.groupId !== undefined && event.payload.message_type !== 'private') return `group:${event.groupId}`;
  return event.actorId === undefined ? undefined : `private:${event.actorId}`;
}
