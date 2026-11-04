import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { environment } from '../../environments/environment';
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
          <span class="label">{{ browserOnly ? 'Assistant’s note' : 'Claude’s note' }}</span>
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
            @for (line of unplaced(); track $index) {
              <li [title]="line.title">{{ line.text }}</li>
            }
          </ul>
        </div>
      }

      <div class="actions">
        <button class="btn btn-primary px" (click)="accept.emit()" [disabled]="busy() || !chosen()">
          Accept {{ chosen() === plan().blocks.length ? (chosen() === 1 ? 'it' : 'all ' + chosen()) : chosen() }}
        </button>
        <button class="btn px" (click)="reject.emit()" [disabled]="busy()">{{ plan().source === 'conflict' ? 'Keep my blocks' : 'Reject' }}</button>
      </div>
      <p class="hint">Untick a block to leave it out. Drag one on the timeline, or focus it and press Shift with an arrow key, to move it 15 minutes.</p>
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

  protected readonly title = computed(() => SOURCE_TITLE[this.plan().source]);
  protected readonly chosen = computed(() => this.plan().blocks.filter((b) => !this.excluded().has(b.id)).length);
  /**
   * What didn't fit, one line per task that got some of its blocks, and one line per
   * reason for the tasks that got none: four open tasks crowded out by the same full day
   * read better as one sentence than four.
   */
  protected readonly unplaced = computed(() => {
    const lines: { text: string; title: string }[] = [];
    const none = new Map<string, string[]>();
    for (const u of this.plan().unplaced ?? []) {
      const task = u.task || 'Focus time';
      if (u.placed > 0) {
        lines.push({ text: `${task}: ${u.placed} of ${u.wanted} placed, because ${this.reason(u.reason)}.`, title: '' });
      } else {
        none.set(u.reason, [...(none.get(u.reason) ?? []), task]);
      }
    }
    for (const [reason, tasks] of none) {
      const names = tasks.length <= 2 ? tasks.join(' and ') : `${tasks.length} tasks`;
      const text =
        reason === 'total_blocks_reached'
          ? `${names} ${tasks.length === 1 ? 'waits' : 'wait'} for a later plan: this one is full at the number of blocks you asked for.`
          : `${names}: none placed, because ${this.reason(reason as keyof typeof UNPLACED_TEXT)}.`;
      lines.push({ text, title: tasks.join(', ') });
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
