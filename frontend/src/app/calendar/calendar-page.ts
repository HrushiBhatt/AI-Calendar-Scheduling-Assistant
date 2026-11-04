import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Assistant } from '../core/assistant';
import { Board } from '../core/board';
import { Brew } from '../core/brew';
import { Schedule } from '../core/schedule';
import { Icon } from '../shared/icon';
import { TaskList } from '../tasks/task-list';
import { BlockCard } from './block-card';
import { CalendarBoard } from './calendar-board';
import { CalendarCard } from './calendar-card';

/** The calendar, with tasks beside it. A plan waiting for a decision links to its own screen. */
@Component({
  selector: 'app-calendar-page',
  imports: [BlockCard, CalendarBoard, CalendarCard, Icon, RouterLink, TaskList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-calendar-board />
    <aside class="rail" aria-label="Details and tasks">
      @if (board.selected(); as b) {
        <app-block-card [block]="b" [zone]="schedule.zone()" [busy]="brew.busy()" (start)="board.startBlock(b)" (remove)="board.removeBlock(b)" (closed)="board.selectedId.set(null)" />
      }
      @if (waiting()) {
        <a class="card waiting" routerLink="/plan">
          <app-icon name="sparkle" />
          <span>Plan to review</span>
          <app-icon name="right" />
        </a>
      }
      <app-calendar-card />
      <app-task-list />
    </aside>
  `,
  styles: `
    :host {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
    .rail {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    @media (min-width: 1100px) {
      :host {
        grid-template-columns: minmax(0, 1fr) 310px;
      }
      .rail {
        max-height: calc(100dvh - 172px);
        padding: 0 2px 2px 0;
        overflow-y: auto;
        scrollbar-width: thin;
      }
    }
    .waiting {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 16px;
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--accent-text);
      text-decoration: none;
      border-color: var(--accent-glow);
      animation: pop 0.4s var(--ease-spring) both;
    }
    .waiting span {
      flex: 1;
    }
    .waiting app-icon:last-child {
      transition: transform 0.25s var(--ease-spring);
    }
    .waiting:hover app-icon:last-child {
      transform: translateX(3px);
    }
  `,
})
export class CalendarPage {
  protected readonly schedule = inject(Schedule);
  protected readonly board = inject(Board);
  protected readonly brew = inject(Brew);
  private readonly assistant = inject(Assistant);
  protected readonly waiting = computed(() => !!(this.assistant.proposal() || this.assistant.conflict()));

  constructor() {
    // /calendar?day=YYYY-MM-DD opens that day's week, month or day.
    const day = inject(ActivatedRoute).snapshot.queryParamMap.get('day');
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) this.schedule.show(day);
  }
}
