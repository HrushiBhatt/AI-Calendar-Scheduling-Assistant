import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { UNPLACED_TEXT } from '../core/assistant';
import { PlanView, ScheduledBlock } from '../core/models';
import { dayIn, formatDay, formatTime } from '../core/zoned';

const SOURCE_TITLE: Record<PlanView['source'], string> = {
  assistant: 'Proposed plan',
  form: 'Proposed plan',
  quick: 'Filling your free time',
  conflict: 'A meeting moved',
};

/**
 * Review a proposal before anything is scheduled: every block with the scheduler's reason
 * for it, a checkbox to leave any out, and what didn't fit. The assistant's words sit in
 * their own labelled box; the blocks come from the plan, never from the model's text.
 */
@Component({
  selector: 'app-plan-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel px review" [class.conflict]="plan().source === 'conflict'" aria-labelledby="review-title">
      <h2 class="panel-title" id="review-title">
        {{ title() }}
        <span class="count">{{ chosen() }} of {{ plan().blocks.length }} picked</span>
      </h2>
      @if (plan().source === 'conflict') {
        <p class="notice" role="alert">
          A calendar change now overlaps {{ plan().replaces?.length === 1 ? 'a block' : 'blocks' }} you accepted. Here is a
          replacement. Nothing moves until you accept it.
        </p>
      }
      @if (plan().request) {
        <p class="request">“{{ plan().request }}”</p>
      }
      @if (plan().rationale) {
        <div class="narration">
          <span class="label">Assistant’s note</span>
          <p>{{ plan().rationale }}</p>
        </div>
      }
      @if (notice()) {
        <p class="notice">{{ notice() }}</p>
      }

      @for (group of days(); track group.day) {
        <h3 class="day">
          <button type="button" (click)="showDay.emit(group.day)" [attr.aria-label]="'Show ' + group.label + ' on the timeline'">
            {{ group.label }}
          </button>
        </h3>
        <ul class="blocks">
          @for (b of group.blocks; track b.id) {
            <li [class.off]="excluded().has(b.id)">
              <label class="pick">
                <input type="checkbox" [checked]="!excluded().has(b.id)" (change)="toggle.emit(b.id)" [disabled]="busy()" />
                <span class="time">{{ range(b) }}</span>
                <span class="what">
                  {{ b.intention || 'Focus block' }}
                  @if (b.new_task) {
                    <em>new task</em>
                  }
                </span>
                <span class="mode">{{ b.mode }}</span>
              </label>
              <p class="why">{{ b.explain }}</p>
            </li>
          }
        </ul>
      } @empty {
        <p class="empty">Nothing fit in that window.</p>
      }

      @if (unplaced().length) {
        <div class="unplaced">
          <h3>Didn’t fit</h3>
          <ul>
            @for (u of unplaced(); track $index) {
              <li>
                <b>{{ u.task || 'Focus time' }}</b>: {{ u.placed }} of {{ u.wanted }} placed, because {{ reason(u.reason) }}.
              </li>
            }
          </ul>
        </div>
      }

    </section>
  `,
  styles: `
    .review {
      display: grid;
      gap: 12px;
    }
    .review.conflict {
      --bd: var(--danger);
    }
    .panel-title {
      margin-bottom: 4px;
    }
    .count {
      font-size: 0.45rem;
      color: var(--gray-400);
    }
    .request {
      font-size: 0.85rem;
      font-style: italic;
      color: var(--gray-300);
    }
    .narration {
      padding: 10px 12px;
      background: var(--gray-850);
      border-left: 3px solid var(--break);
    }
    .narration .label {
      font-family: var(--font-pixel);
      font-size: 0.42rem;
      color: var(--break);
      text-transform: uppercase;
    }
    .narration p {
      margin-top: 6px;
      font-size: 0.85rem;
    }
    .notice {
      font-size: 0.8rem;
      color: var(--accent-bright);
    }
    .day button {
      font-family: var(--font-pixel);
      font-size: 0.5rem;
      color: var(--accent);
      text-transform: uppercase;
    }
    .day button:hover {
      text-decoration: underline;
    }
    .blocks,
    .unplaced ul {
      display: grid;
      gap: 8px;
      list-style: none;
    }
    .blocks li {
      padding: 8px 10px;
      background: var(--gray-850);
      border-left: 3px solid var(--accent);
    }
    .blocks li.off {
      border-left-color: var(--gray-600);
      opacity: 0.55;
    }
    .pick {
      display: grid;
      grid-template-columns: auto 1fr auto;
      grid-template-areas: 'box time mode' '. what what';
      align-items: baseline;
      gap: 4px 10px;
      font-size: 0.85rem;
      cursor: pointer;
    }
    .pick input {
      grid-area: box;
    }
    .pick .time {
      grid-area: time;
    }
    .pick .mode {
      grid-area: mode;
    }
    .pick .what {
      grid-area: what;
    }
    .pick input {
      accent-color: var(--accent);
    }
    .time {
      font-family: var(--font-pixel);
      font-size: 0.48rem;
      white-space: nowrap;
      color: var(--accent-bright);
    }
    .what {
      overflow-wrap: anywhere;
    }
    .what em {
      margin-left: 6px;
      font-size: 0.68rem;
      font-style: normal;
      color: var(--break);
    }
    .mode {
      font-size: 0.7rem;
      color: var(--gray-400);
    }
    .why {
      margin: 4px 0 0 26px;
      font-size: 0.75rem;
      color: var(--gray-400);
    }
    .unplaced h3 {
      margin-bottom: 6px;
      font-size: 0.8rem;
      color: var(--danger);
    }
    .unplaced li {
      font-size: 0.8rem;
      color: var(--gray-300);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      margin-top: 6px;
    }
    .hint {
      font-size: 0.72rem;
      color: var(--gray-500);
    }
  `,
})
export class PlanReview {
  readonly plan = input.required<PlanView>();
  readonly zone = input.required<string>();
  readonly excluded = input<ReadonlySet<number>>(new Set());
  readonly busy = input(false);
  readonly notice = input<string | undefined>();

  readonly toggle = output<number>();
  readonly accept = output<void>();
  readonly reject = output<void>();
  readonly showDay = output<string>();

  protected readonly title = computed(() => SOURCE_TITLE[this.plan().source]);
  protected readonly chosen = computed(() => this.plan().blocks.filter((b) => !this.excluded().has(b.id)).length);
  protected readonly unplaced = computed(() => this.plan().unplaced ?? []);
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
