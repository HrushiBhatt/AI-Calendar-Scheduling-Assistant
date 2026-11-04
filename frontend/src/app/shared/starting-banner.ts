import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Countdown } from '../core/countdown';
import { formatClock } from '../core/time';

/** The countdown before a planned block starts by itself. Shown on every page. */
@Component({
  selector: 'app-starting-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (countdown.pending(); as p) {
      <div class="banner px" role="alert" aria-live="assertive">
        <div class="head">
          <span class="label">Focus block starting</span>
          <span class="clock" [attr.aria-label]="countdown.secondsLeft() + ' seconds'">{{ clock() }}</span>
        </div>
        <p class="what">{{ p.intention || 'Focus block' }} · {{ p.focus_min }} min {{ p.mode }}</p>
        <div class="bar" aria-hidden="true"><i [style.width.%]="(countdown.secondsLeft() / 60) * 100"></i></div>
        <div class="actions">
          <button class="btn btn-primary btn-sm px" (click)="countdown.startNow()" [disabled]="countdown.busy()">Start now</button>
          <button class="btn btn-sm px" (click)="countdown.delay()" [disabled]="countdown.busy()">Delay 10 min</button>
          <button class="btn btn-sm px" (click)="countdown.skip()" [disabled]="countdown.busy()">Skip</button>
        </div>
        <p class="hint">Do nothing and it starts on time.</p>
      </div>
    }
  `,
  styles: `
    .banner {
      --bd: var(--accent);
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 40;
      display: grid;
      gap: 10px;
      width: min(340px, calc(100vw - 48px));
      padding: 16px;
      background: var(--gray-900);
      animation: pop 0.25s var(--ease-out);
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    .label {
      font-family: var(--font-pixel);
      font-size: 0.5rem;
      color: var(--accent);
      text-transform: uppercase;
    }
    .clock {
      font-family: var(--font-pixel);
      font-size: 1rem;
      color: var(--cream-light);
    }
    .what {
      font-size: 0.9rem;
      overflow-wrap: anywhere;
    }
    .bar {
      height: 6px;
      background: var(--gray-700);
    }
    .bar i {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 0.25s linear;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .hint {
      font-size: 0.72rem;
      color: var(--gray-500);
    }
  `,
})
export class StartingBanner {
  protected readonly countdown = inject(Countdown);
  protected readonly clock = computed(() => formatClock(this.countdown.secondsLeft()));
}
