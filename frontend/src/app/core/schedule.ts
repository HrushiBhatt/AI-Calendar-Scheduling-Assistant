import { DestroyRef, Injectable, computed, inject, linkedSignal, resource, signal } from '@angular/core';
import { Api } from './api';
import { Auth } from './auth';
import { LiveEvents } from './live';
import { DaySchedule, LiveEvent } from './models';
import { persistedSignal } from './persisted';
import { dayIn, firstDayOfWeek, monthGrid, shiftDay, shiftMonth, weekOf } from './zoned';

export type CalendarView = 'day' | 'week' | 'month';

/** Live events after which the calendar is stale. */
const STALE_AFTER: LiveEvent['type'][] = ['calendar.synced', 'plan.accepted', 'plan.conflict', 'session.completed'];
const stale = (e: LiveEvent) => STALE_AFTER.includes(e.type) || (e.type === 'changed' && e.data.kind === 'schedule');

/**
 * The user's calendar and accepted focus blocks for the days on screen, as signals. The
 * schedule is server-owned, like the timer: this keeps no second copy, it refetches
 * whenever the server says something changed.
 */
@Injectable({ providedIn: 'root' })
export class Schedule {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);

  /** The user's saved IANA zone. Every time on the calendar is drawn in it. */
  readonly zone = computed(() => this.auth.user()?.settings.timeZone || '');
  /** The clock, ticking every 30 s for the now-line. */
  readonly now = signal(Date.now());
  readonly today = computed(() => (this.zone() ? dayIn(this.now(), this.zone()) : ''));

  /** A phone has no room for seven columns, so it starts on one day. */
  readonly view = persistedSignal<CalendarView>('brew:calendar-view', typeof window !== 'undefined' && window.innerWidth < 760 ? 'day' : 'week');
  /** Which way the last step went, so the new range can slide in from that side. */
  readonly direction = signal<'next' | 'prev' | 'none'>('none');
  readonly firstDay = firstDayOfWeek();

  private readonly picked = signal<string | null>(null);
  /** The day the view is built around (today until the user picks another). */
  readonly day = computed(() => this.picked() ?? this.today());
  /** Every day on screen, in order. */
  readonly days = computed(() => {
    const day = this.day();
    if (!day) return [];
    if (this.view() === 'day') return [day];
    return this.view() === 'week' ? weekOf(day, this.firstDay) : monthGrid(day, this.firstDay);
  });

  readonly data = resource({
    params: () => {
      const days = this.days();
      return this.zone() && days.length ? { from: days[0], to: days[days.length - 1], user: this.auth.user()?.id } : undefined;
    },
    loader: ({ params }) => this.api.schedule(params.from, params.to),
  });

  /** The latest answer, kept on screen while the next range loads so the calendar doesn't blink. */
  readonly shown = linkedSignal<{ user?: number; value?: DaySchedule }, DaySchedule | undefined>({
    source: () => ({ user: this.auth.user()?.id, value: this.data.hasValue() ? this.data.value() : undefined }),
    computation: (next, previous) => next.value ?? (previous?.source.user === next.user ? previous?.value : undefined),
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
    this.direction.set(day === this.day() ? 'none' : day > this.day() ? 'next' : 'prev');
    this.picked.set(day === this.today() ? null : day);
  }

  /** One day, week or month forward (1) or back (-1). */
  step(dir: 1 | -1): void {
    const day = this.day();
    this.show(this.view() === 'day' ? shiftDay(day, dir) : this.view() === 'week' ? shiftDay(day, dir * 7) : shiftMonth(day, dir));
  }

  setView(view: CalendarView): void {
    this.direction.set('none');
    this.view.set(view);
  }

  /** Go from the week or month to one day of it. */
  openDay(day: string): void {
    this.view.set('day');
    this.show(day);
    this.direction.set('none');
  }

  /** Refetch, keeping the current value on screen meanwhile. */
  refresh(): void {
    if (this.data.status() !== 'idle') this.data.reload();
  }
}
