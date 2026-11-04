import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Assistant } from '../core/assistant';
import { Board } from '../core/board';
import { Brew } from '../core/brew';
import { Schedule } from '../core/schedule';
import { Icon } from '../shared/icon';
import { BlockCard } from './block-card';
import { CalendarBoard } from './calendar-board';
import { PlanReview } from './plan-review';

/**
 * The screen a command opens: first the request being worked on, then the plan on the calendar
 * with the decision beside it. Nothing here is scheduled until it's accepted.
 */
@Component({
  selector: 'app-plan-page',
  imports: [BlockCard, CalendarBoard, Icon, PlanReview, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (assistant.pending()) {
      <section class="card notice thinking" role="status" aria-label="Planning">
        <span class="orb"><app-icon name="sparkle" /></span>
        @if (assistant.asked(); as asked) {
          <p class="asked">{{ asked }}</p>
        }
        <div class="ghosts" aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
        </div>
      </section>
    } @else if (assistant.reply(); as reply) {
      <section class="card notice" role="status">
        <span class="orb still"><app-icon name="sparkle" /></span>
        <p class="asked">{{ reply }}</p>
        <a class="btn" routerLink="/calendar">Calendar</a>
      </section>
    } @else if (assistant.conflict() || assistant.proposal()) {
      <div class="plan">
        <app-calendar-board />
        <aside class="side" aria-label="Plan">
          @if (board.selected(); as b) {
            <app-block-card [block]="b" [zone]="schedule.zone()" [busy]="brew.busy()" (start)="board.startBlock(b)" (remove)="board.removeBlock(b)" (closed)="board.selectedId.set(null)" />
          }
          @if (assistant.conflict(); as c) {
            <app-plan-review
              [plan]="c"
              [zone]="schedule.zone()"
              [excluded]="board.excluded()"
              [busy]="assistant.pending()"
              (toggle)="board.toggle($event)"
              (showDay)="schedule.show($event)"
              (accept)="board.accept(c)"
              (reject)="board.reject(c)"
            />
          }
          @if (assistant.proposal(); as p) {
            <app-plan-review
              [plan]="p"
              [zone]="schedule.zone()"
              [excluded]="board.excluded()"
              [busy]="assistant.pending()"
              [notice]="assistant.last()?.notice"
              (toggle)="board.toggle($event)"
              (showDay)="schedule.show($event)"
              (accept)="board.accept(p)"
              (reject)="board.reject(p)"
            />
          }
        </aside>
      </div>
    } @else {
      <section class="card notice">
        <p class="asked">No plan to review</p>
        <a class="btn" routerLink="/calendar">Calendar</a>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .plan {
      display: grid;
      gap: 16px;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
    .side {
      display: grid;
      gap: 12px;
      min-width: 0;
      order: -1;
    }
    @media (min-width: 1100px) {
      .plan {
        grid-template-columns: minmax(0, 1fr) 340px;
      }
      .side {
        order: 0;
        max-height: calc(100dvh - 172px);
        padding: 0 2px 2px 0;
        overflow-y: auto;
        scrollbar-width: thin;
      }
    }
    .notice {
      display: grid;
      justify-items: center;
      gap: 18px;
      max-width: 560px;
      margin: 7vh auto 0;
      padding: 40px 28px;
      text-align: center;
      animation: pop 0.45s var(--ease-spring) both;
    }
    .orb {
      position: relative;
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      --icon: 28px;
      color: var(--accent-ink);
      background: var(--grad);
      border-radius: 50%;
      box-shadow: 0 8px 30px var(--accent-glow);
    }
    .thinking .orb {
      animation: orb 2.2s ease-in-out infinite;
    }
    .thinking .orb::before {
      content: '';
      position: absolute;
      inset: -7px;
      z-index: -1;
      background: conic-gradient(from var(--spin), var(--accent), transparent 35%, var(--accent-text) 60%, transparent 85%, var(--accent));
      border-radius: 50%;
      animation: spin-border 1.5s linear infinite;
    }
    .asked {
      font-size: 1.1rem;
      font-weight: 500;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .ghosts {
      display: grid;
      gap: 8px;
      width: min(100%, 340px);
    }
    .ghosts i {
      height: 34px;
      background: linear-gradient(100deg, var(--surface-2) 30%, var(--shimmer) 50%, var(--surface-2) 70%);
      background-size: 240% 100%;
      border: 1px dashed var(--accent);
      border-radius: var(--radius-xs);
      animation: ghost 1.7s ease-in-out infinite;
    }
    .ghosts i:nth-child(2) {
      width: 82%;
      animation-delay: 140ms;
    }
    .ghosts i:nth-child(3) {
      width: 66%;
      animation-delay: 280ms;
    }
    @keyframes orb {
      50% { transform: scale(1.07); }
    }
    @keyframes ghost {
      from { background-position: 130% 0; }
      to { background-position: -30% 0; }
    }
  `,
})
export class PlanPage {
  protected readonly assistant = inject(Assistant);
  protected readonly board = inject(Board);
  protected readonly schedule = inject(Schedule);
  protected readonly brew = inject(Brew);
}
