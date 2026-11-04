import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { ScheduledBlock } from '../core/models';
import { formatDay, formatTime, dayIn } from '../core/zoned';
import { Icon } from '../shared/icon';

/** One block, chosen on the calendar: when it is, why it's there, and what you can do with it. */
@Component({
  selector: 'app-block-card',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card" [attr.data-status]="block().status" aria-labelledby="block-title">
      <header>
        <h2 id="block-title">{{ block().intention || 'Focus' }}</h2>
        <button class="icon-btn" (click)="closed.emit()" aria-label="Close"><app-icon name="close" /></button>
      </header>
      <p class="when">{{ when() }} · {{ block().mode }}</p>
      @if (block().note) {
        <p class="note" role="alert">{{ block().note }}</p>
      }
      @if (block().explain) {
        <p class="why">{{ block().explain }}</p>
      }
      @if (block().status === 'accepted' || block().status === 'conflicted') {
        <div class="actions">
          @if (block().status === 'accepted') {
            <button class="btn btn-primary btn-sm" (click)="start.emit()" [disabled]="busy()"><app-icon name="play" style="--icon: 14px" /> Start</button>
          }
          <button class="btn btn-sm" (click)="remove.emit()"><app-icon name="trash" style="--icon: 14px" /> Remove</button>
        </div>
      }
    </section>
  `,
  styles: `
    .card {
      display: grid;
      gap: 8px;
      border-color: var(--accent-glow);
      animation: pop 0.3s var(--ease-spring) both;
    }
    .card[data-status='conflicted'] {
      border-color: var(--danger);
    }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }
    h2 {
      padding-top: 6px;
      font-size: 0.95rem;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .when {
      font-size: 0.8rem;
      color: var(--accent-text);
    }
    .note {
      font-size: 0.8rem;
      color: var(--danger);
    }
    .why {
      font-size: 0.8rem;
      color: var(--text-2);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
  `,
})
export class BlockCard {
  readonly block = input.required<ScheduledBlock>();
  readonly zone = input.required<string>();
  /** A session is already running, so this block can't start yet. */
  readonly busy = input(false);
  readonly start = output<void>();
  readonly remove = output<void>();
  readonly closed = output<void>();

  protected readonly when = computed(() => {
    const b = this.block();
    const start = Date.parse(b.starts_at);
    const zone = this.zone();
    return `${formatDay(dayIn(start, zone))}, ${formatTime(start, zone)}–${formatTime(start + b.focus_min * 60_000, zone)}`;
  });
}
