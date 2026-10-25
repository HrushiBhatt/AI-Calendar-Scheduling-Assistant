import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Brew } from '../core/brew';
import { Schedule } from '../core/schedule';
import { formatDay } from '../core/zoned';
import { DayTimeline } from './day-timeline';

@Component({
  selector: 'app-plan-page',
  imports: [DayTimeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel px day" aria-labelledby="day-title">
      <header class="day-head">
        <h2 class="panel-title" id="day-title">{{ dayTitle() }}</h2>
        <div class="nav">
          <button class="btn btn-sm px" (click)="schedule.step(-1)" aria-label="Previous day">◀</button>
          <button class="btn btn-sm px" (click)="schedule.show(schedule.today())" [disabled]="schedule.day() === schedule.today()">Today</button>
          <button class="btn btn-sm px" (click)="schedule.step(1)" aria-label="Next day">▶</button>
        </div>
      </header>
      @if (!schedule.zone()) {
        <p class="empty">Set your time zone in settings to see your day.</p>
      } @else if (schedule.data.value(); as d) {
        <app-day-timeline
          [day]="schedule.day()"
          [from]="ms(d.from)"
          [to]="ms(d.to)"
          [zone]="d.time_zone"
          [workdayStart]="brew.settings().workdayStart"
          [workdayEnd]="brew.settings().workdayEnd"
          [events]="d.events"
          [blocks]="d.blocks"
          [now]="schedule.now()"
        />
      } @else if (schedule.data.error()) {
        <p class="empty">Couldn't load your schedule.</p>
      } @else {
        <p class="empty">Loading your day…</p>
      }
      <p class="panel-note">Times are in {{ schedule.zone() || 'your time zone' }}.</p>
    </section>
  `,
  styles: `
    :host {
      display: grid;
      gap: 28px;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
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
  `,
})
export class PlanPage {
  protected readonly schedule = inject(Schedule);
  protected readonly brew = inject(Brew);
  protected readonly dayTitle = computed(() => (this.schedule.day() ? formatDay(this.schedule.day(), 'long') : 'Your day'));
  protected readonly ms = (iso: string) => Date.parse(iso);
}
