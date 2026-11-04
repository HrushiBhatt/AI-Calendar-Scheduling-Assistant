import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Countdown } from '../core/countdown';
import { formatClock } from '../core/time';

/** The countdown before a planned block starts by itself. Shown on every page. */
@Component({
  selector: 'app-starting-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (countdown.pending(); as p) {
      <div class="banner" role="alert" aria-live="assertive">
        <div class="head">
          <span class="what">{{ p.intention || 'Focus' }}</span>
          <span class="clock" [attr.aria-label]="'Starts in ' + countdown.secondsLeft() + ' seconds'">{{ clock() }}</span>
        </div>
        <div class="bar" aria-hidden="true"><i [style.width.%]="(countdown.secondsLeft() / 60) * 100"></i></div>
        <div class="actions">
          <button class="btn btn-primary btn-sm" (click)="countdown.startNow()" [disabled]="countdown.busy()">Start now</button>
          <button class="btn btn-sm" (click)="countdown.delay()" [disabled]="countdown.busy()">+10 min</button>
          <button class="btn btn-ghost btn-sm" (click)="countdown.skip()" [disabled]="countdown.busy()">Skip</button>
        </div>
      </div>
    }
  `,
  styles: `
    .banner {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 40;
      display: grid;
      gap: 10px;
      width: min(320px, calc(100vw - 40px));
      padding: 14px;
      background: var(--glass-strong);
      -webkit-backdrop-filter: blur(26px) saturate(170%);
      backdrop-filter: blur(26px) saturate(170%);
      border: 1px solid var(--accent-glow);
      border-radius: var(--radius);
      box-shadow: var(--shadow), 0 0 40px var(--accent-soft);
      animation: pop 0.4s var(--ease-spring) both;
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .what {
      font-size: 0.9rem;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .clock {
      font-size: 1.1rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--accent-text);
    }
    .bar {
      height: 4px;
      overflow: hidden;
      background: var(--surface-3);
      border-radius: 99px;
    }
    .bar i {
      display: block;
      height: 100%;
      background: var(--accent);
      border-radius: 99px;
      transition: width 0.25s linear;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
  `,
})
export class StartingBanner {
  protected readonly countdown = inject(Countdown);
  protected readonly clock = computed(() => formatClock(this.countdown.secondsLeft()));
}
