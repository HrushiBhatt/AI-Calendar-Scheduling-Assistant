import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { environment } from '../../environments/environment';
import { UNPLACED_TEXT } from '../core/assistant';
import { PlanView, ScheduledBlock } from '../core/models';
import { dayIn, formatDay, formatTime } from '../core/zoned';
import { Icon } from '../shared/icon';

/**
 * Review a proposal before anything is scheduled: every block with a checkbox to leave it
 * out, the scheduler's reason on hover or focus, and what didn't fit. The assistant's words
 * sit in their own labelled box; the blocks come from the plan, never from the model's text.
 */
@Component({
  selector: 'app-plan-review',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="card review" [class.conflict]="plan().source === 'conflict'" aria-labelledby="review-title">
      <h2 class="card-title" id="review-title">
        {{ plan().source === 'conflict' ? 'A meeting moved' : 'Proposed plan' }}
        <span class="count">{{ chosen() }} of {{ plan().blocks.length }}</span>
      </h2>
      @if (plan().rationale) {
        <div class="narration">
          <span class="who"><app-icon name="sparkle" style="--icon: 13px" /> {{ browserOnly ? 'Assistant' : 'Claude' }}</span>
          <p>{{ plan().rationale }}</p>
        </div>
      }
      @if (notice()) {
        <p class="notice">{{ notice() }}</p>
      }

      @for (group of days(); track group.day) {
        <h3 class="day">
          <button type="button" (click)="showDay.emit(group.day)" [attr.aria-label]="'Show ' + group.label + ' on the calendar'">
            {{ group.label }}
          </button>
        </h3>
        <ul class="blocks">
          @for (b of group.blocks; track b.id; let i = $index) {
            <li [class.off]="excluded().has(b.id)" [style.--i]="i">
              <label class="pick">
                <input class="tick" type="checkbox" [checked]="!excluded().has(b.id)" (change)="toggle.emit(b.id)" [disabled]="busy()" />
                <span class="what">
                  {{ b.intention || 'Focus' }}
                  @if (b.new_task) {
                    <em>new</em>
                  }
                </span>
                <span class="time">{{ range(b) }}</span>
              </label>
              <p class="why">{{ b.explain }}</p>
            </li>
          }
        </ul>
      } @empty {
        <p class="empty">Nothing fit</p>
      }

      @if (unplaced().length) {
        <div class="unplaced">
          <h3>Didn’t fit</h3>
          <ul>
            @for (line of unplaced(); track $index) {
              <li [title]="line.title">{{ line.text }}</li>
            }
          </ul>
        </div>
      }

      <div class="actions">
        <button class="btn btn-primary" (click)="accept.emit()" [disabled]="busy() || !chosen()">
          Accept {{ chosen() === plan().blocks.length ? (chosen() === 1 ? 'it' : 'all ' + chosen()) : chosen() }}
        </button>
        <button class="btn btn-ghost" (click)="reject.emit()" [disabled]="busy()">{{ plan().source === 'conflict' ? 'Keep mine' : 'Dismiss' }}</button>
      </div>
    </section>
  `,
  styles: `
    .review {
      display: grid;
      gap: 10px;
      border-color: var(--accent-glow);
      box-shadow: 0 0 40px var(--accent-soft);
      animation: tray-in 0.5s var(--ease-out) both;
    }
    .review.conflict {
      border-color: var(--danger);
      box-shadow: 0 0 40px var(--danger-soft);
    }
    .card-title {
      margin-bottom: 2px;
    }
    .count {
      font-size: 0.75rem;
      font-weight: 400;
      color: var(--text-3);
    }
    .narration {
      display: grid;
      gap: 4px;
      padding: 10px 12px;
      background: var(--accent-soft);
      border-radius: var(--radius-sm);
    }
    .who {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.72rem;
      font-weight: 600;
      color: var(--accent-text);
    }
    .narration p {
      font-size: 0.82rem;
      line-height: 1.45;
      color: var(--text);
    }
    .notice {
      font-size: 0.8rem;
      color: var(--accent-text);
    }
    .day button {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-3);
      transition: color 0.2s;
    }
    .day button:hover {
      color: var(--accent);
    }
    .blocks {
      display: grid;
      gap: 5px;
    }
    .blocks li {
      padding: 8px 10px;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
      transition: opacity 0.25s, background 0.2s;
      animation: rise 0.4s var(--ease-out) both;
      animation-delay: calc(var(--i, 0) * 60ms + 120ms);
    }
    .blocks li:hover {
      background: var(--surface-3);
    }
    .blocks li.off {
      opacity: 0.5;
    }
    .pick {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 9px;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .what {
      overflow-wrap: anywhere;
    }
    .what em {
      margin-left: 4px;
      font-size: 0.68rem;
      font-style: normal;
      color: var(--break);
    }
    .time {
      font-size: 0.75rem;
      white-space: nowrap;
      color: var(--accent-text);
    }
    /* The reason unfolds on demand: it's there when wanted, and quiet otherwise. */
    .why {
      display: grid;
      max-height: 0;
      margin-left: 25px;
      overflow: hidden;
      font-size: 0.74rem;
      line-height: 1.4;
      color: var(--text-2);
      opacity: 0;
      transition: max-height 0.3s var(--ease-out), opacity 0.25s, margin 0.3s;
    }
    li:hover .why,
    li:focus-within .why {
      max-height: 90px;
      margin-top: 5px;
      opacity: 1;
    }
    .unplaced h3 {
      margin-bottom: 4px;
      font-size: 0.78rem;
      font-weight: 500;
      color: var(--danger);
    }
    .unplaced ul {
      display: grid;
      gap: 3px;
    }
    .unplaced li {
      font-size: 0.78rem;
      color: var(--text-2);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }
    @keyframes tray-in {
      from { opacity: 0; transform: translateX(18px); }
    }
  `,
})
export class PlanReview {
  /** The demo's phrase matcher isn't Claude, so only the full app says it is. */
  protected readonly browserOnly = environment.browserBackend;
  readonly plan = input.required<PlanView>();
  readonly zone = input.required<string>();
  readonly excluded = input<ReadonlySet<number>>(new Set());
  readonly busy = input(false);
  readonly notice = input<string | undefined>();

  readonly toggle = output<number>();
  readonly accept = output<void>();
  readonly reject = output<void>();
  readonly showDay = output<string>();

  protected readonly chosen = computed(() => this.plan().blocks.filter((b) => !this.excluded().has(b.id)).length);
  /**
   * What didn't fit, one line per task that got some of its blocks, and one line per
   * reason for the tasks that got none: four open tasks crowded out by the same full day
   * read better as one line than four.
   */
  protected readonly unplaced = computed(() => {
    const lines: { text: string; title: string }[] = [];
    const none = new Map<string, string[]>();
    for (const u of this.plan().unplaced ?? []) {
      const task = u.task || 'Focus time';
      if (u.placed > 0) {
        lines.push({ text: `${task}: ${u.placed} of ${u.wanted}, ${this.reason(u.reason)}`, title: '' });
      } else {
        none.set(u.reason, [...(none.get(u.reason) ?? []), task]);
      }
    }
    for (const [reason, tasks] of none) {
      const names = tasks.length <= 2 ? tasks.join(' and ') : `${tasks.length} tasks`;
      lines.push({ text: `${names}: ${this.reason(reason as keyof typeof UNPLACED_TEXT)}`, title: tasks.join(', ') });
    }
    return lines;
  });

  protected readonly days = computed(() => {
    const groups: { day: string; label: string; blocks: ScheduledBlock[] }[] = [];
    for (const b of this.plan().blocks) {
      const day = dayIn(b.starts_at, this.zone());
      let g = groups.find((x) => x.day === day);
      if (!g) groups.push((g = { day, label: formatDay(day, 'long'), blocks: [] }));
      g.blocks.push(b);
    }
    return groups;
  });

  protected range(b: ScheduledBlock): string {
    const start = Date.parse(b.starts_at);
    return `${formatTime(start, this.zone())}–${formatTime(start + b.focus_min * 60_000, this.zone())}`;
  }

  protected reason(r: keyof typeof UNPLACED_TEXT): string {
    return UNPLACED_TEXT[r] ?? r.replace(/_/g, ' ');
  }
}
