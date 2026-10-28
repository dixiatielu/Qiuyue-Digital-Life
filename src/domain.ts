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
/** Low-information signals ride along with other observations; they never start or steer a thought on their own. */
export const isAmbient = (kind: string): boolean => kind === 'notice:notify:input_status' || kind.startsWith('notice:group_msg_emoji_like:');
