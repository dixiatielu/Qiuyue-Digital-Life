import type { Config } from './config.js';
import type { Brain } from './brain.js';
import { Store, type PendingTiming } from './store.js';
import { errorText, type EnvironmentEvent, type Wake } from './domain.js';
import { recordTime } from './record.js';
import { waitFor } from './async.js';

export interface FreeTimeView { now: number; heardAt: number; quietMs: number; lifeWakes: { at: number; freeTime: boolean }[]; plans: Wake[] }
/** A quiet stretch offers free time unless the digital life rests, another life wake is near, or the day's free time is spent (ADR-0015). */
export function freeTimeDue({ now, heardAt, quietMs, lifeWakes, plans }: FreeTimeView, { gapMs, perDay }: Config['life']['freeTime']): boolean {
  if (now - heardAt < quietMs || plans.some(wake => wake.rest && wake.status === 'pending')) return false;
  if (lifeWakes.some(wake => now - wake.at < gapMs) || plans.some(wake => wake.kind === 'life' && wake.dueAt - now < gapMs)) return false;
  return lifeWakes.filter(wake => wake.freeTime && now - wake.at < 86_400_000).length < perDay;
}

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
  private maintenance = false;
  private nextRetention = 0;
  private nextFreeTime = 0;
  /** The quiet stretch being waited out: since when, and how long this one must last. */
  private quiet = { heardAt: -1, needMs: 0 };
  /** The memory review under way, which runs beside the thoughts rather than taking their turn (ADR-0012). */
  private reviewing?: Promise<void>;
  /** Without a reviewer, no review runs. */
  constructor(readonly config: Config, readonly store: Store, readonly brain: Brain, readonly reviewer?: Brain, private random = Math.random) {}
  start() {
    if (this.started) throw new Error('The runtime has already started.');
    this.started = true;
    this.store.recover();
    if (this.store.settings().lifeEnabled && !this.store.wakes().some(wake => wake.kind === 'life')) this.store.schedule('Consider what you want to do and schedule your next activity; you may also rest.', 'life', Date.now());
    this.timer = setInterval(() => { void this.tick(); }, this.config.limits.tickMs);
    void this.tick();
  }
  async tick() {
    if (!this.started || this.stopped || this.ticking || this.maintenance) return;
    this.ticking = true;
    try {
      const settings = this.store.settings();
      if (settings.paused || (this.work && settings.generation !== this.brain.thought.generation)) this.brain.abort();
      if (settings.paused || (this.reviewing && settings.generation !== this.reviewer!.thought.generation)) this.reviewer?.abort();
      if (settings.paused) return;
      const now = Date.now();
      if (now >= this.nextRetention) { this.store.retain(this.config.memory.retentionDays); this.nextRetention = now + 3_600_000; }
      this.store.enqueueDue(now);
      // After due wakes are queued, so the wake a rest was for ends it.
      const resting = this.rest(now);
      if ((this.config.limits.modelCallsPerDay !== null && this.store.dailyCalls() >= this.config.limits.modelCallsPerDay) || now < this.retryAfter) return;
      // A life wake may interrupt housekeeping, but waits out a thought already under way.
      let pending = this.store.pendingTiming(settings.lifeEnabled && (!this.work || this.consolidating), resting);
      // Events received above (due wakes) are stamped after `now`; time them against a later clock.
      let checkedAt = Date.now();
      const idle = !this.work && pending.first === undefined && checkedAt - this.settledAt >= this.config.compaction.idleAfterMs;
      this.startReview(idle, now);
      // Consolidation is housekeeping: an event that can wake a thought takes attention back at once.
      if (this.consolidating) { if (pending.first !== undefined) this.brain.abort(); return; }
      if (this.work && !this.brain.streaming) return;
      if (idle && settings.lifeEnabled && this.offerFreeTime(now)) { pending = this.store.pendingTiming(settings.lifeEnabled, resting); checkedAt = Date.now(); }
      if (!this.ready(pending, checkedAt, resting)) {
        if (idle && !this.consolidated && pending.first === undefined) this.consolidate();
        return;
      }
      // Anything that wakes or steers a thought during rest brings the held chat with it.
      if (resting) this.store.transaction(() => this.setAsideRest(this.store.setting<number>('restingSince'), checkedAt));
      // A life wake waits for the thought under way to end rather than steering it.
      const observation = this.store.claim(this.config.limits.batchSize, settings.lifeEnabled && !this.work, resting);
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
  /** Review waits for a quiet moment, unless the backlog has grown well past its threshold. One runs at a time, apart from the conversations (ADR-0012). */
  private startReview(idle: boolean, now: number) {
    const reviewer = this.reviewer;
    if (!reviewer || this.reviewing) return;
    const count = this.store.processedCount();
    const watermark = this.store.setting<number>('reflectionWatermark');
    const every = this.config.memory.reflectionEveryEvents;
    if (count - watermark < every || (!idle && count - watermark < every * 3)) return;
    const backlog = this.store.reviewBacklog(now);
    const chats = backlog.map(item => `${item.conversation}: ${item.messages} new messages since ${recordTime(item.since)}`).join('; ');
    const text = `Time to consolidate memory, apart from your conversations: new messages go to them as usual, and nothing you do here reaches anyone. If you find something you still owe someone, schedule it as a commitment. ${chats ? `Unreviewed chat records: ${chats}. Read them with read_chat_record, which continues where your last review stopped; you decide how much to read. Start with what happened as the record shows it. Find what someone asked of you and whether you did it, where someone corrected, questioned, or contradicted you, or said again something you had not taken up, and check what you said you did or saw against your actions; keep those corrections in what you save. Your own feelings are yours to write, but how someone took your words is only what their replies show, and what they did after their last message, such as going to sleep or back to work, is unknown unless they said so. Where the record does not show whether something helped, say it is unknown rather than how you hoped it went. Then look at how as much as what. After reading a chat, read your own lines there alone with read_chat_record person=self. Quote a few of yours beside a few of theirs from the same moments and say how they differ in form, not content: what most of their lines share that yours lack, and what yours share that theirs lack. Look at length, punctuation and tone words, messages that are only a sticker or image, several short messages in a row, joining in, and how they responded to you. Check your group participation rhythm in both directions: whether you chimed in on unaddressed lines far more often than others or stepped into exchanges between other people, and whether you stayed completely silent when open conversations had natural room for you; describe when to join and when to let pass by the conversational situation rather than broad topic keywords. Then do the same for reactions and stickers. Count your own reactions, stickers, and messages in your lines, and ask whether anyone else reacted or sent stickers that often over the same stretch. Look at which ones they use in which situations and on whose messages, and how they use them, such as alone, after a few words, or joining others' reactions. Open a few of their stickers with view_event_image to see what they are. Record what you see as practices, keep what suits you as habits, and revise impressions of people. A habit says when it applies and when it does not. Development holds everywhere unless it belongs to one group alone. Before you revise a habit or practice, see whose lines its examples come from: if they all come from one person, it is about that person even when it is worded for friends in general, so put what still holds into your impression of them and retire the habit or practice instead of revising it.` : 'Review recent experiences and revise practices, habits, and impressions of people.'} Save important experiences too, and retire entries that no longer hold.`;
    // Perceived by the review alone, so no thought claims it.
    const event = this.store.receive({ key: `maintenance:${watermark}:${count}`, kind: 'memory_maintenance', at: now, text, payload: { backlog } }, true);
    this.store.setSetting('reflectionWatermark', count);
    if (!event) return;
    const timeout = this.config.limits.runTimeoutMs === null ? undefined : setTimeout(() => reviewer.abort(), this.config.limits.runTimeoutMs);
    // What it read and saved before stopping stays; the next review reads on from there.
    this.reviewing = reviewer.review({ batchId: `review:${event.id}`, events: [event] }).catch(error => { this.store.log('review_stopped', { message: errorText(error) }); }).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      this.reviewing = undefined;
      // What it handed on comes to the conversations together, so revisions that one plan cites start one thought rather than one each.
      try { this.store.noticeRevisions(reviewer.thought.handedOn ?? []); } catch (error) { this.store.log('runtime_error', { message: errorText(error) }); }
    });
  }
  /** Once a minute while idle, see whether the quiet stretch, its length drawn afresh each time one begins, offers a free-time life wake (ADR-0015). */
  private offerFreeTime(now: number) {
    const free = this.config.life.freeTime;
    if (!free.enabled || now < this.nextFreeTime) return false;
    this.nextFreeTime = now + 60_000;
    const heardAt = this.store.lastHeard() ?? 0;
    if (heardAt !== this.quiet.heardAt) this.quiet = { heardAt, needMs: free.quietMinMs + Math.floor(this.random() * (free.quietMaxMs - free.quietMinMs + 1)) };
    const view = { now, heardAt, quietMs: this.quiet.needMs, lifeWakes: this.store.lifeWakesSince(now - Math.max(free.gapMs, 86_400_000)), plans: this.store.wakes() };
    if (!freeTimeDue(view, free)) return false;
    const minutes = Math.floor((now - heardAt) / 60_000);
    this.store.receive({ key: `free-time:${now}`, kind: 'wake', at: now, text: `Free time: your chats have been quiet for ${heardAt ? `${minutes} minutes` : 'a while'}. Do something of your own or rest, as you like.`, payload: { wakeKind: 'life', freeTime: true } });
    return true;
  }
  /** A burst starts one thought once the environment goes quiet; ambient events never wake or steer on their own, and during a rest they wait for something that does. */
  private ready({ first, last, ambient }: PendingTiming, now: number, resting: boolean) {
    const { debounceMs, maxDelayMs, ambientDelayMs } = this.config.limits;
    if (first === undefined) return !this.work && !resting && ambient !== undefined && now - ambient >= ambientDelayMs;
    return this.work !== undefined || now - (last ?? first) >= debounceMs || now - first >= maxDelayMs;
  }
  /** Whether the digital life rests now. Held group chat accompanies the next thought, or comes when the rest ends, as one chat-record note (ADR-0016). */
  private rest(now: number) {
    const resting = this.store.resting(now);
    const since = this.store.setting<number | null>('restingSince');
    if (resting && since === null) this.store.setSetting('restingSince', now);
    if (!resting && since !== null) this.store.transaction(() => { this.setAsideRest(since, now); this.store.setSetting('restingSince', null); });
    return resting;
  }
  private setAsideRest(since: number, now: number) {
    const held = this.store.restHeld();
    if (!held.length) return;
    const groups = new Map<string, EnvironmentEvent[]>();
    for (const event of held) groups.set(event.source!.conversation!, [...groups.get(event.source!.conversation!) ?? [], event]);
    const chats = [...groups].map(([conversation, events]) => {
      const messages = events.filter(event => event.kind === 'message').length;
      return { conversation, from: events[0]!.at, messages, notices: events.length - messages };
    });
    // One observation by events would be several times the size of the same chat as a record, and would come in batches.
    this.store.setAside(held.map(event => event.id));
    const lines = chats.map(chat => `${chat.conversation}: ${chat.messages} messages${chat.notices ? ` and ${chat.notices} notices such as reactions and pokes` : ''} from ${recordTime(chat.from)}`);
    this.store.receive({ key: `rest:${held[0]!.id}`, kind: 'rest_backlog', at: now, text: `While you rested from ${recordTime(since)} to ${recordTime(now)}, group chat not addressed to you waited: ${lines.join('; ')}. Its record follows.`, payload: { since, until: now, chats } });
  }
  /** Compact an oversized working context once per idle period, so a later observation does not wait for it. */
  private consolidate() {
    this.consolidated = true; this.consolidating = true;
    this.work = this.brain.consolidate().catch(error => { this.store.log('consolidation_stopped', { message: errorText(error) }); }).finally(() => {
      this.consolidating = false; this.work = undefined;
    });
  }
  async idle() { await this.work; await this.steering; await this.reviewing; }
  /** Perception writes directly to the store. Only dispatch pauses while both brains and housekeeping drain. */
  async maintain<T>(signal: AbortSignal, change: () => Promise<T>): Promise<T> {
    if (this.maintenance || this.stopped) throw new Error('The runtime is already in maintenance or stopping.');
    this.maintenance = true;
    try { await waitFor(this.idle(), signal); signal.throwIfAborted(); if (this.stopped) throw new Error('The runtime is stopping.'); return await change(); }
    finally { this.maintenance = false; void this.tick(); }
  }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.brain.abort(); this.reviewer?.abort(); await this.work; await this.steering; await this.reviewing; }
  control(command: string, value?: boolean) {
    this.store.transaction(() => {
      if (command === 'pause' || command === 'resume') this.store.setSetting('paused', command === 'pause');
      else if (command === 'life' && typeof value === 'boolean') this.store.setSetting('lifeEnabled', value);
      else throw new Error('Unknown control command.');
      this.store.bumpGeneration();
    });
    this.brain.abort(); this.reviewer?.abort();
    if (command === 'resume') this.retryAfter = 0;
    if (command === 'life' && value && !this.store.wakes().some(wake => wake.kind === 'life')) this.store.schedule('Plan your own life according to your current persona and interests.', 'life', Date.now());
    this.store.log('control', { command, value });
    return this.store.status();
  }
}
