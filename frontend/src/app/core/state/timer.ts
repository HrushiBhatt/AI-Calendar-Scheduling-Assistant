import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Api } from '../api/api';
import { FocusRequest, TimerAction, TimerState } from '../api/models';

const IDLE: TimerState = {
  phase: 'focus',
  status: 'idle',
  duration_ms: 0,
  remaining_ms: 0,
  server_time: new Date(0).toISOString(),
};

/**
 * The client's view of the server-run timer. The server owns the clock; this only
 * renders it, deriving the remaining time from the server's deadline (corrected for
 * clock skew), so every device shows the same countdown.
 */
@Injectable({ providedIn: 'root' })
export class Timer {
  private readonly api = inject(Api);
  private readonly now = signal(Date.now());
  private skewMs = 0; // server clock minus ours

  readonly state = signal<TimerState>(IDLE);

  readonly remainingMs = computed(() => {
    const s = this.state();
    if (s.status !== 'running' || !s.ends_at) return s.remaining_ms;
    return Math.max(0, Date.parse(s.ends_at) - (this.now() + this.skewMs));
  });

  constructor() {
    // Re-render four times a second, only while running.
    effect((onCleanup) => {
      if (this.state().status !== 'running') return;
      const id = setInterval(() => this.now.set(Date.now()), 250);
      onCleanup(() => clearInterval(id));
    });
  }

  /** Adopt a state from the server, ignoring any that arrive out of order. */
  apply(next: TimerState): void {
    const at = Date.parse(next.server_time);
    if (at < Date.parse(this.state().server_time)) return;
    this.skewMs = at - Date.now();
    this.now.set(Date.now());
    this.state.set(next);
  }

  reset(): void {
    this.state.set(IDLE);
  }

  async startFocus(req: FocusRequest): Promise<void> {
    this.apply(await this.api.startFocus(req));
  }

  async startBreak(seconds: number): Promise<void> {
    this.apply(await this.api.startBreak(seconds));
  }

  async control(action: TimerAction): Promise<void> {
    const state = await this.api.control(action);
    if (action !== 'distraction') this.apply(state);
  }
}
