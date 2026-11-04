import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Brew } from '../core/brew';
import { formatClock } from '../core/time';

/** The running timer, on every other page, one click from the full view. */
@Component({
  selector: 'app-mini-timer',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (running() && !hidden()) {
      <a class="mini glass thin" routerLink="/focus" [class.is-break]="onBreak()" [class.paused]="paused()" [attr.aria-label]="(onBreak() ? 'Break, ' : 'Focus, ') + clock() + ' left'">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <circle class="track" cx="18" cy="18" r="16" pathLength="100" />
          <circle class="value" cx="18" cy="18" r="16" pathLength="100" [style.stroke-dashoffset]="100 - brew.progress() * 100" />
        </svg>
        <span>{{ clock() }}</span>
      </a>
    }
  `,
  styles: `
    .mini {
      position: relative;
      display: grid;
      place-items: center;
      width: 50px;
      height: 50px;
      font-size: 0.66rem;
      border-radius: 50%;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--text);
      text-decoration: none;
      animation: pop 0.4s var(--ease-spring) both;
      transition: transform 0.25s var(--ease-spring);
    }
    .mini:hover {
      transform: scale(1.08);
    }
    svg {
      position: absolute;
      inset: 0;
      transform: rotate(-90deg);
    }
    circle {
      fill: none;
      stroke-width: 3;
    }
    .track {
      stroke: var(--surface-3);
    }
    .value {
      stroke: var(--accent);
      stroke-dasharray: 100;
      stroke-linecap: round;
      transition: stroke-dashoffset 1s linear;
    }
    .is-break .value {
      stroke: var(--break);
    }
    .paused {
      opacity: 0.6;
    }
  `,
})
export class MiniTimer {
  protected readonly brew = inject(Brew);
  /** The Focus page has the big one. */
  readonly hidden = input(false);
  protected readonly running = computed(() => this.brew.timer.state().status !== 'idle');
  protected readonly paused = computed(() => this.brew.timer.state().status === 'paused');
  protected readonly onBreak = computed(() => this.brew.phase() === 'break');
  protected readonly clock = computed(() => formatClock(this.brew.display().remainingMs / 1000));
}
