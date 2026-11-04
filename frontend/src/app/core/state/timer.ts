import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Store } from '../data/store';
import { FocusRequest, TimerAction, TimerState } from '../data/models';

/**
 * The timer as the screen shows it. The store owns the state; this only works out the time left
 * from the saved deadline, so a reload or a throttled background tab can't make it drift.
 */
@Injectable({ providedIn: 'root' })
export class Timer {
  private readonly store = inject(Store);
  private readonly now = signal(Date.now());

  readonly state = signal<TimerState>(this.store.timer());

  readonly remainingMs = computed(() => {
    const s = this.state();
    if (s.status !== 'running' || !s.ends_at) return s.remaining_ms;
    return Math.max(0, Date.parse(s.ends_at) - this.now());
  });

  constructor() {
    // Re-render four times a second, only while running.
    effect((onCleanup) => {
      if (this.state().status !== 'running') return;
      const id = setInterval(() => this.now.set(Date.now()), 250);
      onCleanup(() => clearInterval(id));
    });
  }

  /** Show a new state, from this tab or another one. */
  apply(next: TimerState): void {
    this.now.set(Date.now());
    this.state.set(next);
  }

  startFocus(req: FocusRequest): void {
    this.apply(this.store.startFocus(req));
  }

  startBreak(seconds: number): void {
    this.apply(this.store.startBreak(seconds));
  }

  control(action: TimerAction): void {
    const state = this.store.control(action);
    if (action !== 'distraction') this.apply(state);
  }
}
