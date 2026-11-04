import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Board } from '../core/board';
import { Brew } from '../core/brew';
import { CalendarView, Schedule } from '../core/schedule';
import { formatDay, formatMonth, formatRange } from '../core/zoned';
import { Icon } from '../shared/icon';
import { MonthGrid } from './month-grid';
import { TimeGrid } from './time-grid';

const VIEWS: { id: CalendarView; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
];

/** The calendar itself, in day, week or month, with its controls. */
@Component({
  selector: 'app-calendar-board',
  imports: [Icon, MonthGrid, TimeGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card calendar" aria-labelledby="cal-title">
      <header class="head">
        <div class="nav">
          <button class="icon-btn" (click)="schedule.step(-1)" [attr.aria-label]="'Previous ' + schedule.view()"><app-icon name="left" /></button>
          <button class="icon-btn" (click)="schedule.step(1)" [attr.aria-label]="'Next ' + schedule.view()"><app-icon name="right" /></button>
          <button class="btn btn-sm" (click)="schedule.show(schedule.today())" [disabled]="onToday()">Today</button>
          <h1 id="cal-title">{{ title() }}</h1>
        </div>
        <div class="segmented" role="tablist" aria-label="Calendar view" [style.--n]="views.length" [style.--i]="viewIndex()">
          @for (v of views; track v.id) {
            <button role="tab" [attr.aria-selected]="schedule.view() === v.id" (click)="schedule.setView(v.id)">{{ v.label }}</button>
          }
        </div>
      </header>

      @if (!zone()) {
        <p class="empty">
          <button class="btn btn-sm" (click)="openSettings()">Set your time zone</button>
        </p>
      } @else if (schedule.shown(); as d) {
        @for (key of [gridKey()]; track key) {
          <div class="view" [class]="'from-' + schedule.direction()" [class.month]="schedule.view() === 'month'" [attr.data-day]="schedule.day()">
            @if (schedule.view() === 'month') {
              <app-month-grid
                [days]="schedule.days()"
                [anchor]="schedule.day()"
                [today]="schedule.today()"
                [zone]="zone()"
                [events]="d.events"
                [blocks]="board.blocks()"
                (openDay)="schedule.openDay($event)"
              />
            } @else {
              <app-time-grid
                [days]="schedule.days()"
                [today]="schedule.today()"
                [zone]="zone()"
                [workdayStart]="brew.settings().workdayStart"
                [workdayEnd]="brew.settings().workdayEnd"
                [events]="d.events"
                [blocks]="board.blocks()"
                [dimmed]="board.excluded()"
                [selected]="board.selectedId()"
                [now]="schedule.now()"
                [canMove]="board.canMove"
                (moved)="board.move($event)"
                (activate)="board.activate($event)"
                (openDay)="schedule.openDay($event)"
              />
            }
          </div>
        }
      } @else if (schedule.data.error()) {
        <p class="empty">Couldn't load your calendar</p>
      } @else {
        <div class="skeleton" aria-hidden="true"></div>
        <p class="sr-only" role="status">Loading</p>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .calendar {
      padding: 14px 16px 16px;
      animation: rise 0.45s var(--ease-out) both;
    }
    .head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px 16px;
      margin-bottom: 10px;
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .nav .btn {
      margin: 0 8px 0 4px;
    }
    h1 {
      font-size: 1.2rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .segmented {
      width: min(100%, 230px);
    }
    /* The hours scroll inside the glass, so the bars above stay put. */
    @media (min-width: 761px) {
      .view:not(.month) {
        height: calc(100dvh - 240px);
        min-height: 420px;
      }
    }
    .view.from-next {
      animation: from-right 0.35s var(--ease-out) both;
    }
    .view.from-prev {
      animation: from-left 0.35s var(--ease-out) both;
    }
    .view.from-none {
      animation: fade 0.3s ease both;
    }
    .skeleton {
      height: 460px;
      background: linear-gradient(100deg, var(--surface-2) 35%, var(--surface-3) 50%, var(--surface-2) 65%);
      background-size: 220% 100%;
      border-radius: var(--radius-sm);
      animation: skeleton 1.5s ease-in-out infinite;
    }
    @keyframes from-right {
      from { opacity: 0; transform: translateX(22px); }
    }
    @keyframes from-left {
      from { opacity: 0; transform: translateX(-22px); }
    }
    @keyframes skeleton {
      from { background-position: 120% 0; }
      to { background-position: -20% 0; }
    }
  `,
})
export class CalendarBoard {
  protected readonly schedule = inject(Schedule);
  protected readonly board = inject(Board);
  protected readonly brew = inject(Brew);
  protected readonly zone = this.schedule.zone;
  protected readonly views = VIEWS;

  protected readonly viewIndex = computed(() => VIEWS.findIndex((v) => v.id === this.schedule.view()));
  protected readonly onToday = computed(() => this.schedule.days().includes(this.schedule.today()));
  /** A new key rebuilds the grid, which is what plays its slide. Data refreshes keep the key. */
  protected readonly gridKey = computed(() => `${this.schedule.view()}:${this.schedule.days()[0]}`);

  protected readonly title = computed(() => {
    const days = this.schedule.days();
    if (!days.length) return 'Calendar';
    if (this.schedule.view() === 'day') return formatDay(days[0], 'long');
    return this.schedule.view() === 'week' ? formatRange(days[0], days[days.length - 1]) : formatMonth(this.schedule.day());
  });

  protected openSettings(): void {
    this.brew.settingsTab.set('planning');
    this.brew.dialog.set('settings');
  }
}
