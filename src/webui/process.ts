import { existsSync, readFileSync, statSync } from 'node:fs';

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

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Files the daemon read at start that have changed since, so a restart is needed to use them. */
export function changedSince(startedAt: number | undefined, files: Record<string, string | undefined>): string[] {
  if (startedAt === undefined) return [];
  return Object.entries(files).filter(([, path]) => path && existsSync(path) && statSync(path).mtimeMs > startedAt).map(([name]) => name);
}
