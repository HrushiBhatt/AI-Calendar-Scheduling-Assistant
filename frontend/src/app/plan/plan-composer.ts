import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { Assistant } from '../core/assistant';
import { Brew } from '../core/brew';
import { PlanArgs, PlanResponse, PlanWindow } from '../core/models';
import { Schedule } from '../core/schedule';

const WINDOWS: { value: PlanWindow; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'this_week', label: 'The rest of this week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'custom', label: 'Pick dates' },
];

const EXAMPLES = [
  'Plan my deep work for tomorrow, three blocks on the compiler project',
  'Two short blocks this afternoon for email, nothing after 4',
  'Fit the design doc into this week before it’s due',
];

/**
 * Where a plan request starts: plain words for the assistant, or the form. The form is
 * the same request in structured form, so the planner can't tell them apart.
 */
@Component({
  selector: 'app-plan-composer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel px" aria-labelledby="compose-title">
      <h2 class="panel-title" id="compose-title">
        Plan focus time
        @if (assistant.enabled()) {
          <button type="button" class="switch-mode" (click)="useForm.set(!useForm())">
            {{ useForm() ? 'Type it instead' : 'Use the form' }}
          </button>
        }
      </h2>

      @if (assistant.enabled() && !useForm()) {
        <form class="stack" (submit)="$event.preventDefault(); sendText()">
          <label class="sr-only" for="plan-text">What should I plan?</label>
          <textarea
            id="plan-text"
            class="input px"
            rows="3"
            maxlength="500"
            [placeholder]="placeholder"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
            (keydown.meta.enter)="sendText()"
            (keydown.control.enter)="sendText()"
          ></textarea>
          <p class="hint">The assistant only reads your request. The scheduler picks every time, around your real meetings.</p>
          <button class="btn btn-primary px" [disabled]="assistant.pending() || !text().trim()">
            {{ assistant.pending() ? 'Planning…' : 'Plan it' }}
          </button>
        </form>
      } @else {
        <form class="stack" (submit)="$event.preventDefault(); sendForm()">
          <label class="field">
            When
            <select class="input px" (change)="window.set($any($event.target).value)">
              @for (w of windows; track w.value) {
                <option [value]="w.value" [selected]="w.value === window()">{{ w.label }}</option>
              }
            </select>
          </label>
          @if (window() === 'custom') {
            <div class="pair">
              <label class="field">From <input class="input px" type="date" [min]="today()" [value]="start()" (change)="start.set($any($event.target).value)" /></label>
              <label class="field">To <input class="input px" type="date" [min]="start() || today()" [value]="end()" (change)="end.set($any($event.target).value)" /></label>
            </div>
          }
          <fieldset class="field tasks">
            <legend>Tasks <span class="hint">(none ticked: your open tasks, most urgent first)</span></legend>
            @for (t of openTasks(); track t.id) {
              <label class="check">
                <input type="checkbox" [checked]="picked().has(t.id)" (change)="togglePick(t.id)" />
                {{ t.title }}
              </label>
            } @empty {
              <p class="hint">No open tasks. Blocks will be untasked focus time.</p>
            }
          </fieldset>
          <div class="pair">
            <label class="field">Blocks <input class="input px" type="number" min="1" max="12" [value]="count()" (change)="setCount($event)" /></label>
            <label class="field">
              Rhythm
              <select class="input px" (change)="rhythm.set($any($event.target).value)">
                <option value="" [selected]="!rhythm()">My usual</option>
                <option value="deep" [selected]="rhythm() === 'deep'">Deep (45 min or more)</option>
                <option value="short" [selected]="rhythm() === 'short'">Short (30 min or less)</option>
                @for (m of brew.modes(); track m.key) {
                  <option [value]="m.name" [selected]="rhythm() === m.name">{{ m.name }} {{ m.focus }}/{{ m.rest }}</option>
                }
              </select>
            </label>
          </div>
          <div class="pair">
            <label class="field">Not before <input class="input px" type="time" step="900" [value]="before()" (change)="before.set($any($event.target).value)" /></label>
            <label class="field">Not after <input class="input px" type="time" step="900" [value]="after()" (change)="after.set($any($event.target).value)" /></label>
          </div>
          <div class="pair checks">
            <label class="check"><input type="checkbox" [checked]="evening()" (change)="evening.set(!evening())" /> Evenings</label>
            <label class="check"><input type="checkbox" [checked]="weekend()" (change)="weekend.set(!weekend())" /> Weekends</label>
          </div>
          <button class="btn btn-primary px" [disabled]="assistant.pending()">{{ assistant.pending() ? 'Planning…' : 'Plan it' }}</button>
        </form>
      }
      <button class="btn btn-sm px quick" (click)="quick()" [disabled]="assistant.pending()">Fill my free time today</button>
    </section>
  `,
  styles: `
    .stack {
      display: grid;
      gap: 14px;
    }
    .switch-mode {
      font-family: var(--font-main);
      font-size: 0.75rem;
      text-transform: none;
      color: var(--gray-300);
      text-decoration: underline;
    }
    .hint {
      font-size: 0.72rem;
      color: var(--gray-500);
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .checks {
      display: flex;
      gap: 20px;
    }
    .tasks {
      max-height: 180px;
      padding: 0;
      overflow-y: auto;
      border: none;
    }
    .tasks legend {
      margin-bottom: 8px;
    }
    .tasks .check {
      padding: 4px 0;
    }
    .quick {
      width: 100%;
      margin-top: 18px;
    }
    textarea {
      min-height: 84px;
    }
  `,
})
export class PlanComposer {
  protected readonly assistant = inject(Assistant);
  protected readonly brew = inject(Brew);
  readonly planned = output<PlanResponse>();

  protected readonly windows = WINDOWS;
  protected readonly placeholder = EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)];
  protected readonly today = inject(Schedule).today; // in the user's zone, not the browser's
  protected readonly useForm = signal(false);
  protected readonly text = signal('');

  protected readonly window = signal<PlanWindow>('tomorrow');
  protected readonly start = signal('');
  protected readonly end = signal('');
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly count = signal(3);
  protected readonly rhythm = signal('');
  protected readonly before = signal('');
  protected readonly after = signal('');
  protected readonly evening = signal(false);
  protected readonly weekend = signal(false);

  protected readonly openTasks = computed(() => this.brew.tasks().filter((t) => !t.done));

  protected togglePick(id: number): void {
    this.picked.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected setCount(e: Event): void {
    const n = (e.target as HTMLInputElement).valueAsNumber;
    if (Number.isInteger(n)) this.count.set(Math.min(12, Math.max(1, n)));
  }

  protected async sendText(): Promise<void> {
    const text = this.text().trim();
    if (!text || this.assistant.pending()) return;
    const res = await this.assistant.request({ text });
    if (res) {
      this.text.set('');
      this.planned.emit(res);
    }
  }

  protected async sendForm(): Promise<void> {
    const ask: PlanArgs = { window: this.window(), total_blocks: this.count() };
    if (this.window() === 'custom') {
      ask.start_date = this.start() || this.today();
      if (this.end()) ask.end_date = this.end();
    }
    if (this.picked().size) ask.task_ids = [...this.picked()];
    if (this.rhythm()) ask.mode_hint = this.rhythm();
    if (this.before()) ask.avoid_before = this.before();
    if (this.after()) ask.avoid_after = this.after();
    if (this.evening()) ask.allow_evening = true;
    if (this.weekend()) ask.allow_weekend = true;
    const res = await this.assistant.request({ ask });
    if (res) this.planned.emit(res);
  }

  protected async quick(): Promise<void> {
    const res = await this.assistant.request({ quick: 'fill_today' });
    if (res) this.planned.emit(res);
  }
}
