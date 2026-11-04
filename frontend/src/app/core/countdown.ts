import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Api, errorMessage } from './api';
import { LiveEvents } from './live';
import { Starting } from './models';
import { Timer } from './timer';
import { Toasts } from './toast';

/** How long past its start a warning stays up if the timer never shows up. */
const LINGER_MS = 15_000;

/**
 * The 60-second warning before a planned block starts on its own. Starting with no
 * warning would be hostile: the user may be mid-sentence in a meeting that ran long. If
 * nothing is clicked the block starts anyway, as the server decides; delay and skip are
 * ordinary edits to the block.
 */
@Injectable({ providedIn: 'root' })
export class Countdown {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly timer = inject(Timer);
  private readonly clock = signal(Date.now());

  readonly pending = signal<Starting | null>(null);
  readonly busy = signal(false);
  readonly secondsLeft = computed(() => {
    const p = this.pending();
    return p ? Math.max(0, Math.ceil((Date.parse(p.starts_at) - this.clock()) / 1000)) : 0;
  });

  constructor() {
    const sub = inject(LiveEvents).events$.subscribe((e) => {
      if (e.type === 'scheduled.starting') this.pending.set(e.data);
      // The block started (here or from another device): the warning has done its job.
      if (e.type === 'timer' && e.data.status === 'running' && this.pending()) this.pending.set(null);
      if (e.type === 'changed' && e.data.kind === 'schedule' && this.timer.state().status === 'running') this.pending.set(null);
    });
    const tick = setInterval(() => {
      this.clock.set(Date.now());
      const p = this.pending();
      if (p && Date.now() > Date.parse(p.starts_at) + LINGER_MS) this.pending.set(null);
    }, 250);
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      clearInterval(tick);
    });
  }

  async startNow(): Promise<void> {
    await this.act((p) => this.api.startBlock(p.scheduled_id).then((state) => this.timer.apply(state)));
  }

  /** Push the block back ten minutes. The server re-checks the new slot. */
  async delay(): Promise<void> {
    await this.act(async (p) => {
      const later = new Date(Date.parse(p.starts_at) + 10 * 60_000).toISOString();
      await this.api.moveBlock(p.scheduled_id, later);
      this.toasts.show('Pushed back 10 minutes');
    });
  }

  async skip(): Promise<void> {
    await this.act(async (p) => {
      await this.api.dropBlock(p.scheduled_id);
      this.toasts.show('Block skipped');
    });
  }

  private async act(fn: (p: Starting) => Promise<unknown>): Promise<void> {
    const p = this.pending();
    if (!p || this.busy()) return;
    this.busy.set(true);
    try {
      await fn(p);
      this.pending.set(null);
    } catch (err) {
      this.toasts.show(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
