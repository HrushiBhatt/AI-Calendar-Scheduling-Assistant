import { DestroyRef, Injectable, computed, inject, resource, signal } from '@angular/core';
import { Api } from './api';
import { Auth } from './auth';
import { LiveEvents } from './live';
import { LiveEvent } from './models';
import { dayIn, shiftDay } from './zoned';

/** Live events after which the day view is stale. */
const STALE_AFTER: LiveEvent['type'][] = ['calendar.synced', 'plan.accepted', 'plan.conflict', 'session.completed'];
const stale = (e: LiveEvent) => STALE_AFTER.includes(e.type) || (e.type === 'changed' && e.data.kind === 'schedule');

/**
 * The user's calendar and accepted focus blocks for one local day, as signals. The
 * schedule is server-owned, like the timer: this keeps no second copy, it refetches
 * whenever the server says something changed.
 */
@Injectable({ providedIn: 'root' })
export class Schedule {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);

  /** The user's saved IANA zone. Every time on the timeline is drawn in it. */
  readonly zone = computed(() => this.auth.user()?.settings.timeZone || '');
  /** The clock, ticking every 30 s for the now-line. */
  readonly now = signal(Date.now());
  readonly today = computed(() => (this.zone() ? dayIn(this.now(), this.zone()) : ''));
  private readonly picked = signal<string | null>(null);
  /** The day being shown (today until the user picks another). */
  readonly day = computed(() => this.picked() ?? this.today());

  readonly data = resource({
    params: () => (this.zone() && this.day() ? { day: this.day(), user: this.auth.user()?.id } : undefined),
    loader: ({ params }) => this.api.schedule(params.day),
  });

  constructor() {
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    const sub = inject(LiveEvents).events$.subscribe((e) => {
      if (stale(e)) this.refresh();
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  show(day: string): void {
    this.picked.set(day === this.today() ? null : day);
  }

  step(days: number): void {
    this.show(shiftDay(this.day(), days));
  }

  /** Refetch, keeping the current value on screen meanwhile. */
  refresh(): void {
    if (this.data.status() !== 'idle') this.data.reload();
  }
}
