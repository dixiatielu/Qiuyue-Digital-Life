import type { Config } from './config.js';
import type { Brain } from './brain.js';
import { Store } from './store.js';
import { errorText } from './domain.js';

export class LifeRuntime {
  private timer?: ReturnType<typeof setInterval>;
  private work?: Promise<void>;
  private ticking = false;
  private lastDispatch = 0;
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
      if (now - this.lastDispatch < this.config.limits.debounceMs || (this.work && !this.brain.streaming)) return;
      const observation = this.store.claim(this.config.limits.batchSize, settings.lifeEnabled);
      if (!observation) return;
      this.lastDispatch = now;
      if (this.work) {
        if (!await this.brain.steer(observation)) this.store.releaseBatch(observation.batchId);
      } else {
        const timeout = this.config.limits.runTimeoutMs === null ? undefined : setTimeout(() => this.brain.abort(), this.config.limits.runTimeoutMs);
        this.work = this.brain.run(observation).catch(error => {
          this.store.log('thought_error', { message: errorText(error) }); this.retryAfter = Date.now() + 30_000;
        }).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
          this.store.releaseClaims(); this.work = undefined;
        });
      }
    } catch (error) { this.store.log('runtime_error', { message: errorText(error) }); }
    finally { this.ticking = false; }
  }
  async idle() { await this.work; }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.brain.abort(); await this.work; }
  control(command: string, value?: boolean) {
    this.store.transaction(() => {
      if (command === 'pause' || command === 'resume') this.store.setSetting('paused', command === 'pause');
      else if (command === 'life' && typeof value === 'boolean') this.store.setSetting('lifeEnabled', value);
      else throw new Error('Unknown control command.');
      this.store.bumpGeneration();
    });
    this.brain.abort();
    if (command === 'resume') { this.retryAfter = 0; this.lastDispatch = 0; }
    if (command === 'life' && value && !this.store.wakes().some(wake => wake.kind === 'life')) this.store.schedule('Plan your own life according to your current persona and interests.', 'life', Date.now());
    this.store.log('control', { command, value });
    return this.store.status();
  }
}
