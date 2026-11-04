import type { EventSource } from './identity.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface EnvironmentEvent {
  id: string;
  key: string;
  kind: string;
  at: number;
  text: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'processed';
  receivedAt?: number;
  /** Present on platform events; internal life events have no platform source. */
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
  conversations: string[];
  fictional: boolean;
  sources: string[];
  supersedes?: string;
  /** Where development applies: global, conversation:<canonical ref>, or person:<canonical ref>. Absent for other kinds. */
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
/** Canonical platform context is normalized by the adapter before persistence. */
export const eventChat = (event: Pick<EnvironmentEvent, 'source'>): string | undefined => event.source?.conversation;
export const ambientEvent = (event: Pick<EnvironmentEvent, 'source'>): boolean => event.source !== undefined && event.source.attention !== 'normal';
export const ownEvent = (event: Pick<EnvironmentEvent, 'source'>): boolean => event.source?.own === true;
