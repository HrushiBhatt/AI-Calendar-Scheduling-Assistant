import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { Assistant } from '../core/assistant';
import { Brew } from '../core/brew';
import { PlanResponse, PlanView, ScheduledBlock } from '../core/models';
import { Schedule } from '../core/schedule';
import { dayIn, formatDay } from '../core/zoned';
import { DayTimeline } from './day-timeline';
import { PlanComposer } from './plan-composer';
import { PlanReview } from './plan-review';

/**
 * /plan: ask for a plan, review it against the day it lands in, and (from phase 4)
 * accept it. Proposed blocks are drawn on the same timeline as meetings and accepted
 * blocks, so the review happens where the time actually is.
 */
@Component({
  selector: 'app-plan-page',
  imports: [DayTimeline, PlanComposer, PlanReview],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="side">
      <app-plan-composer (planned)="onPlanned($event)" />
      @if (assistant.conflict(); as c) {
        <app-plan-review [plan]="c" [zone]="zone()" [excluded]="excluded()" (toggle)="toggle($event)" (showDay)="schedule.show($event)" />
      }
      @if (assistant.proposal(); as p) {
        <app-plan-review
          [plan]="p"
          [zone]="zone()"
          [excluded]="excluded()"
          [notice]="assistant.last()?.notice"
          (toggle)="toggle($event)"
          (showDay)="schedule.show($event)"
        />
      }
    </div>

    <section class="panel px day" aria-labelledby="day-title">
      <header class="day-head">
        <h2 class="panel-title" id="day-title">{{ dayTitle() }}</h2>
        <div class="nav">
          <button class="btn btn-sm px" (click)="schedule.step(-1)" aria-label="Previous day">◀</button>
          <button class="btn btn-sm px" (click)="schedule.show(schedule.today())" [disabled]="schedule.day() === schedule.today()">Today</button>
          <button class="btn btn-sm px" (click)="schedule.step(1)" aria-label="Next day">▶</button>
        </div>
      </header>
      @if (!zone()) {
        <p class="empty">Set your time zone in settings to see your day.</p>
      } @else if (schedule.data.value(); as d) {
        <app-day-timeline
          [day]="schedule.day()"
          [from]="ms(d.from)"
          [to]="ms(d.to)"
          [zone]="zone()"
          [workdayStart]="brew.settings().workdayStart"
          [workdayEnd]="brew.settings().workdayEnd"
          [events]="d.events"
          [blocks]="blocksToday()"
          [dimmed]="excluded()"
          [now]="schedule.now()"
        />
        <p class="panel-note legend">
          <span class="key meeting"></span> meeting <span class="key proposed"></span> proposed
          <span class="key accepted"></span> planned · times in {{ zone() }}
        </p>
      } @else if (schedule.data.error()) {
        <p class="empty">Couldn't load your schedule.</p>
      } @else {
        <p class="empty">Loading your day…</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: grid;
      gap: 28px;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
    @media (min-width: 980px) {
      :host {
        grid-template-columns: 380px minmax(0, 1fr);
      }
    }
    .side {
      display: grid;
      gap: 28px;
    }
    .day-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    .day-head .panel-title {
      margin: 0;
    }
    .nav {
      display: flex;
      gap: 12px;
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
    }
    .key {
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-left: 8px;
    }
    .key.meeting {
      background: var(--gray-700);
      border-left: 3px solid var(--gray-400);
    }
    .key.proposed {
      outline: 2px dashed var(--accent-bright);
      outline-offset: -2px;
      background: var(--accent-soft);
    }
    .key.accepted {
      background: var(--accent);
    }
  `,
})
export class PlanPage {
  protected readonly schedule = inject(Schedule);
  protected readonly assistant = inject(Assistant);
  protected readonly brew = inject(Brew);
  protected readonly zone = this.schedule.zone;
  protected readonly ms = (iso: string) => Date.parse(iso);

  /** Blocks the user unticked in the review. Reset whenever a different plan arrives. */
  protected readonly excluded = signal<ReadonlySet<number>>(new Set());

  protected readonly dayTitle = computed(() => (this.schedule.day() ? formatDay(this.schedule.day(), 'long') : 'Your day'));

  /** Accepted blocks for the day shown, plus any proposed ones that land on it. */
  protected readonly blocksToday = computed(() => {
    const day = this.schedule.day();
    const accepted = this.schedule.data.value()?.blocks ?? [];
    const proposed = [this.assistant.conflict(), this.assistant.proposal()]
      .filter((p): p is PlanView => !!p)
      .flatMap((p) => p.blocks)
      .filter((b) => b.status === 'proposed' && dayIn(b.starts_at, this.zone()) === day);
    return [...accepted, ...proposed] as ScheduledBlock[];
  });

  constructor() {
    // A new proposal (from this tab or another) starts with every block ticked.
    const ids = computed(() => `${this.assistant.proposal()?.id}:${this.assistant.conflict()?.id}`);
    effect(() => {
      ids();
      untracked(() => this.excluded.set(new Set()));
    });
  }

  protected toggle(id: number): void {
    this.excluded.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Show the day the new plan starts on. */
  protected onPlanned(res: PlanResponse): void {
    const first = res.plan?.blocks[0]?.starts_at ?? res.plan?.window_start;
    if (first && this.zone()) this.schedule.show(dayIn(first, this.zone()));
  }
}
