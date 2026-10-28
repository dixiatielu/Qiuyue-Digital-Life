import type { Config } from './config.js';
import type { Brain } from './brain.js';
import { Store, type PendingTiming } from './store.js';
import { errorText } from './domain.js';

export class LifeRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private steering: Promise<void> = Promise.resolve();
  private consolidating = false;
  private consolidated = false;
  private settledAt = 0;
  private ticking = false;
  private retryAfter = 0;
  private stopped = false;
  private started = false;
  private nextRetention = 0;
  constructor(readonly config: Config, readonly store: Store, readonly brain: Brain) {}
  start() {
    if (this.started) throw new Error('The runtime has already started.');
    this.started = true;
    this.store.recover();
    if (this.store.settings().lifeEnabled && !this.store.wakes().some(wake => wake.kind === 'life')) this.store.schedule('Consider what you want to do and schedule your next activity; you may also rest.', 'life', Date.now());
    this.timer = setInterval(() => { void this.tick(); }, this.config.limits.tickMs);
    void this.tick();
  }
  async tick() {
    if (!this.started || this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.store.settings();
      if (settings.paused || (this.work && settings.generation !== this.brain.thought.generation)) this.brain.abort();
      if (settings.paused) return;
      const now = Date.now();
      if (now >= this.nextRetention) { this.store.retain(this.config.memory.retentionDays); this.nextRetention = now + 3_600_000; }
      this.store.enqueueDue(now);
      if ((this.config.limits.modelCallsPerDay !== null && this.store.dailyCalls() >= this.config.limits.modelCallsPerDay) || now < this.retryAfter) return;
      const count = this.store.processedCount();
      const watermark = this.store.setting<number>('reflectionWatermark');
      if (count - watermark >= this.config.memory.reflectionEveryEvents) {
        this.store.receive({ key: `maintenance:${watermark}:${count}`, kind: 'memory_maintenance', at: now, text: 'Review recent experiences and organize important understandings, relationship changes, and personal notes; there is no need to speak in a group.', payload: {} });
        this.store.setSetting('reflectionWatermark', count);
      }
      const pending = this.store.pendingTiming(settings.lifeEnabled);
      // Events received above (due wakes, maintenance) are stamped after `now`; time them against a later clock.
      const checkedAt = Date.now();
      // Consolidation is housekeeping: an event that can wake a thought takes attention back at once.
      if (this.consolidating) { if (pending.first !== undefined) this.brain.abort(); return; }
      if (this.work && !this.brain.streaming) return;
      if (!this.ready(pending, checkedAt)) {
        if (!this.work && !this.consolidated && pending.first === undefined && checkedAt - this.settledAt >= this.config.compaction.idleAfterMs) this.consolidate();
        return;
      }
      const observation = this.store.claim(this.config.limits.batchSize, settings.lifeEnabled);
      if (!observation) return;
      this.store.log('observation_dispatched', { batchId: observation.batchId, mode: this.work ? 'steer' : 'run', events: observation.events.length, waitedMs: checkedAt - Math.min(...observation.events.map(event => event.receivedAt ?? checkedAt)) });
      if (this.work) {
        // Image downloads must not hold the tick; chaining keeps steered observations in arrival order.
        this.steering = this.steering.then(() => this.brain.steer(observation)).then(accepted => { if (!accepted) this.store.releaseBatch(observation.batchId); }, error => {
          this.store.log('runtime_error', { message: errorText(error) }); this.store.releaseBatch(observation.batchId);
        });
      } else {
        const timeout = this.config.limits.runTimeoutMs === null ? undefined : setTimeout(() => this.brain.abort(), this.config.limits.runTimeoutMs);
        this.work = this.brain.run(observation).catch(error => {
          this.store.log('thought_error', { message: errorText(error) }); this.retryAfter = Date.now() + 30_000;
        }).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
          this.store.releaseClaims(); this.work = undefined;
          this.settledAt = Date.now(); this.consolidated = false;
        });
      }
    } catch (error) { this.store.log('runtime_error', { message: errorText(error) }); }
    finally { this.ticking = false; }
  }
  /** A burst starts one thought once the environment goes quiet; ambient events never wake or steer on their own. */
  private ready({ first, last, ambient }: PendingTiming, now: number) {
    const { debounceMs, maxDelayMs, ambientDelayMs } = this.config.limits;
    if (first === undefined) return !this.work && ambient !== undefined && now - ambient >= ambientDelayMs;
    return this.work !== undefined || now - (last ?? first) >= debounceMs || now - first >= maxDelayMs;
  }
  /** Compact an oversized working context once per idle period, so a later observation does not wait for it. */
  private consolidate() {
    this.consolidated = true; this.consolidating = true;
    this.work = this.brain.consolidate().catch(error => { this.store.log('consolidation_stopped', { message: errorText(error) }); }).finally(() => {
      this.consolidating = false; this.work = undefined;
    });
  }
  async idle() { await this.work; await this.steering; }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.brain.abort(); await this.work; await this.steering; }
  control(command: string, value?: boolean) {
    this.store.transaction(() => {
      if (command === 'pause' || command === 'resume') this.store.setSetting('paused', command === 'pause');
      else if (command === 'life' && typeof value === 'boolean') this.store.setSetting('lifeEnabled', value);
      else throw new Error('Unknown control command.');
      this.store.bumpGeneration();
    });
    this.brain.abort();
    if (command === 'resume') this.retryAfter = 0;
    if (command === 'life' && value && !this.store.wakes().some(wake => wake.kind === 'life')) this.store.schedule('Plan your own life according to your current persona and interests.', 'life', Date.now());
    this.store.log('control', { command, value });
    return this.store.status();
  }
}
