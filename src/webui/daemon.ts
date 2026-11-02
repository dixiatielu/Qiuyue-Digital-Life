import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { followDisplay } from '../display-client.js';
import type { DisplayChange, DisplayItem, DisplayStatus } from '../monitor.js';
import { errorText } from '../domain.js';
import type { LifeReader } from './reader.js';

const run = promisify(execFile);

export type LivePacket =
  | { type: 'snapshot'; connected: boolean; message: string; status?: DisplayStatus; items: DisplayItem[] }
  | { type: 'change'; change: DisplayChange }
  | { type: 'connection'; connected: boolean; message: string };

/** One live subscription to the daemon, shared by every open page; it follows the daemon across restarts. */
export class LiveMirror {
  status?: DisplayStatus;
  connected = false;
  message = '';
  private items = new Map<string, DisplayItem>();
  private listeners = new Set<(packet: LivePacket) => void>();
  private stop: () => void;
  constructor(socket: string, private keep = 300) {
    this.stop = followDisplay(socket, packet => {
      if (packet.type === 'snapshot') {
        this.status = packet.status; this.items = new Map(packet.items.slice(-this.keep).map(item => [item.id, item]));
        this.broadcast(this.snapshot());
      } else if (packet.type === 'event') {
        const { change } = packet;
        if (change.type === 'status') this.status = change.status;
        else {
          this.items.delete(change.item.id); this.items.set(change.item.id, change.item);
          if (this.items.size > this.keep) this.items.delete(this.items.keys().next().value!);
        }
        this.broadcast({ type: 'change', change });
      }
    }, (connected, message) => {
      this.connected = connected; this.message = message;
      if (!connected) this.status = undefined;
      this.broadcast({ type: 'connection', connected, message });
    });
  }
  snapshot(): LivePacket { return { type: 'snapshot', connected: this.connected, message: this.message, status: this.status, items: [...this.items.values()] }; }
  subscribe(listener: (packet: LivePacket) => void) {
    this.listeners.add(listener); listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }
  private broadcast(packet: LivePacket) { for (const listener of this.listeners) { try { listener(packet); } catch {} } }
  close() { this.stop(); this.listeners.clear(); }
}

/** When a process started, from /proc; undefined where there is none. */
export function processStartedAt(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    const boot = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1]);
    // Linux reports start time in clock ticks, which are 100 a second on every common build.
    return Number.isFinite(ticks) && boot ? Math.round((boot + ticks / 100) * 1000) : undefined;
  } catch { return undefined; }
}
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
/** Files the daemon read at start that have changed since, so a restart is needed to use them. */
export function changedSince(startedAt: number | undefined, files: Record<string, string | undefined>): string[] {
  if (startedAt === undefined) return [];
  return Object.entries(files).filter(([, path]) => path && existsSync(path) && statSync(path).mtimeMs > startedAt).map(([name]) => name);
}

export async function serviceState(unit: string) {
  try {
    const { stdout } = await run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState,SubState,MainPID,ActiveEnterTimestamp,Result'], { timeout: 5000 });
    return Object.fromEntries(stdout.trim().split('\n').map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])) as Record<string, string>;
  } catch (error) { return { error: errorText(error) }; }
}
export async function serviceCommand(unit: string, action: 'start' | 'stop' | 'restart') {
  await run('systemctl', ['--user', action, unit], { timeout: 60_000 });
}

/** Why a restart now would throw work away, empty when there is nothing to wait for. */
export function busyReasons(mirror: LiveMirror, reader: LifeReader): string[] {
  const reasons: string[] = [];
  if (mirror.status?.busy) reasons.push('thinking');
  const activity = reader.activity();
  if (activity.reviewing !== undefined) reasons.push('reviewing');
  if (activity.callStarting) reasons.push('calling');
  return reasons;
}

export interface ServiceJob { unit: string; action: 'restart' | 'stop'; state: 'waiting' | 'running' | 'done' | 'failed' | 'cancelled'; startedAt: number; deadline: number; waitingFor: string[]; message?: string }
/**
 * Restarts or stops the daemon once a thought and a review are both finished (the daemon throws away the thought under way when it stops).
 * One job runs at a time; it gives up rather than cut work short when the deadline passes.
 */
export class ServiceJobs {
  job?: ServiceJob;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private mirror: LiveMirror, private reader: LifeReader, private pollMs = 2000, private command = serviceCommand) {}
  start(unit: string, action: ServiceJob['action'], whenIdle: boolean, waitMs = 15 * 60_000) {
    if (this.job && ['waiting', 'running'].includes(this.job.state)) throw new Error('Another restart or stop is already under way.');
    const now = Date.now();
    this.job = { unit, action, state: 'waiting', startedAt: now, deadline: now + waitMs, waitingFor: [] };
    this.poll(whenIdle);
    return this.job;
  }
  cancel() {
    if (this.job?.state !== 'waiting') return this.job;
    if (this.timer) clearTimeout(this.timer);
    this.job = { ...this.job, state: 'cancelled' };
    return this.job;
  }
  private poll(whenIdle: boolean) {
    const job = this.job!;
    if (job.state !== 'waiting') return;
    job.waitingFor = whenIdle ? busyReasons(this.mirror, this.reader) : [];
    if (job.waitingFor.length) {
      if (Date.now() >= job.deadline) { job.state = 'failed'; job.message = 'The daemon stayed busy until the deadline; nothing was restarted.'; return; }
      this.timer = setTimeout(() => this.poll(whenIdle), this.pollMs);
      return;
    }
    job.state = 'running';
    this.command(job.unit, job.action).then(() => { job.state = 'done'; }, error => { job.state = 'failed'; job.message = errorText(error); });
  }
  close() { if (this.timer) clearTimeout(this.timer); }
}
