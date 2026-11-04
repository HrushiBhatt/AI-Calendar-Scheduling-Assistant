import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { Assistant } from '../core/assistant';
import { Brew } from '../core/brew';
import { PlanArgs, PlanRequest, PlanResponse, PlanWindow } from '../core/models';
import { Schedule } from '../core/schedule';
import { dayIn } from '../core/zoned';
import { Icon } from '../shared/icon';

const WINDOWS: { value: PlanWindow; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'this_week', label: 'This week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'custom', label: 'Pick dates' },
];

/**
 * One way to ask for a plan: a sentence for Claude, under the tab bar on every screen but the
 * timer. Sending it opens the plan screen. The options panel is the same request in structured
 * form, so the planner can't tell them apart, and it's what remains when there's no model to ask.
 */
@Component({
  selector: 'app-assistant-bar',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bar glass thin" [class.pending]="assistant.pending()">
      @if (assistant.enabled()) {
        <form class="ask" (submit)="$event.preventDefault(); sendText()">
          <app-icon class="spark" name="sparkle" />
          <label class="sr-only" for="plan-text">{{ browserOnly ? 'What should I plan?' : 'Ask Claude to plan' }}</label>
          <input
            #prompt
            id="plan-text"
            autocomplete="off"
            maxlength="500"
            [placeholder]="assistant.pending() ? 'Planning…' : placeholder"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
          />
          <button class="send" [disabled]="assistant.pending() || !text().trim()" [attr.aria-label]="browserOnly ? 'Plan it' : 'Plan with Claude'">
            <app-icon name="send" style="--icon: 16px" />
          </button>
        </form>
      } @else {
        <button class="plain" (click)="panel.set(!panel())" [attr.aria-expanded]="panel()">
          <app-icon name="sliders" />
          Plan focus time
        </button>
        @if (!browserOnly && !assistant.available()) {
          <span class="setup" title="Add ANTHROPIC_API_KEY to .env and restart">Claude isn't set up. Add ANTHROPIC_API_KEY to .env and restart.</span>
        }
      }
      <span class="tools">
        <button class="icon-btn" (click)="quick()" [disabled]="assistant.pending()" aria-label="Fill my free time today" title="Fill my free time today"><app-icon name="bolt" /></button>
        @if (assistant.enabled()) {
          <button class="icon-btn" (click)="panel.set(!panel())" [class.on]="panel()" [attr.aria-expanded]="panel()" aria-label="Plan options" title="Options"><app-icon name="sliders" /></button>
        }
      </span>
    </div>
    @if (panel()) {
      <form class="options" (submit)="$event.preventDefault(); sendForm()" aria-label="Plan options">
        <label class="field">
          When
          <select class="input" (change)="window.set($any($event.target).value)">
            @for (w of windows; track w.value) {
              <option [value]="w.value" [selected]="w.value === window()">{{ w.label }}</option>
            }
          </select>
        </label>
        @if (window() === 'custom') {
          <div class="pair">
            <label class="field">From <input class="input" type="date" [min]="today()" [value]="start()" (change)="start.set($any($event.target).value)" /></label>
            <label class="field">To <input class="input" type="date" [min]="start() || today()" [value]="end()" (change)="end.set($any($event.target).value)" /></label>
          </div>
        }
        <div class="pair">
          <label class="field">Blocks <input class="input" type="number" min="1" max="12" [value]="count()" (change)="setCount($event)" /></label>
          <label class="field">
            Rhythm
            <select class="input" (change)="rhythm.set($any($event.target).value)">
              <option value="" [selected]="!rhythm()">Usual</option>
              <option value="deep" [selected]="rhythm() === 'deep'">Deep</option>
              <option value="short" [selected]="rhythm() === 'short'">Short</option>
              @for (m of brew.modes(); track m.key) {
                <option [value]="m.name" [selected]="rhythm() === m.name">{{ m.name }} {{ m.focus }}/{{ m.rest }}</option>
              }
            </select>
          </label>
        </div>
        <div class="pair">
          <label class="field">Not before <input class="input" type="time" step="900" [value]="before()" (change)="before.set($any($event.target).value)" /></label>
          <label class="field">Not after <input class="input" type="time" step="900" [value]="after()" (change)="after.set($any($event.target).value)" /></label>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" [checked]="evening()" (change)="evening.set(!evening())" /> Evenings</label>
          <label class="check"><input type="checkbox" [checked]="weekend()" (change)="weekend.set(!weekend())" /> Weekends</label>
        </div>
        @if (openTasks().length) {
          <fieldset class="tasks">
            <legend class="field">Tasks</legend>
            @for (t of openTasks(); track t.id) {
              <label class="check">
                <input type="checkbox" [checked]="picked().has(t.id)" (change)="togglePick(t.id)" />
                {{ t.title }}
              </label>
            }
          </fieldset>
        }
        <button class="btn btn-primary" [disabled]="assistant.pending()">{{ assistant.pending() ? 'Planning…' : 'Plan it' }}</button>
      </form>
    }
  `,
  styles: `
    :host {
      position: relative;
      z-index: 20;
      display: grid;
      justify-items: center;
      max-width: 1320px;
      margin: 12px auto 0;
      padding: 0 20px;
    }
    .bar {
      position: relative;
      display: flex;
      align-items: center;
      width: min(100%, 640px);
      min-height: 52px;
      padding: 6px 8px 6px 16px;
      border-radius: 99px;
      isolation: isolate;
      transition: box-shadow 0.3s, transform 0.3s var(--ease-spring);
      animation: drop-in 0.6s var(--ease-out) 60ms both;
    }
    .bar:focus-within {
      box-shadow: inset 0 0 0 1px var(--accent), var(--shadow), 0 0 0 4px var(--accent-soft), 0 0 42px var(--accent-soft);
    }
    .bar.pending::before {
      content: '';
      position: absolute;
      inset: -2px;
      z-index: -1;
      background: conic-gradient(from var(--spin), var(--accent), transparent 30%, var(--accent-text) 55%, transparent 80%, var(--accent));
      border-radius: inherit;
      animation: spin-border 1.6s linear infinite;
    }
    .ask {
      display: flex;
      flex: 1;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .spark {
      color: var(--accent);
    }
    .pending .spark {
      animation: spark 1.2s ease-in-out infinite;
    }
    input#plan-text {
      flex: 1;
      min-width: 0;
      padding: 6px 0;
      font-size: 0.95rem;
      background: none;
      border: none;
      outline: none;
    }
    input#plan-text::placeholder {
      color: var(--text-3);
    }
    .send {
      display: grid;
      place-items: center;
      flex: none;
      width: 36px;
      height: 36px;
      color: var(--accent-ink);
      background: var(--grad);
      border-radius: 50%;
      transition: transform 0.25s var(--ease-spring), opacity 0.2s, box-shadow 0.25s;
    }
    .send:hover:not(:disabled) {
      box-shadow: 0 4px 18px var(--accent-glow);
      transform: scale(1.08);
    }
    .send:active:not(:disabled) {
      transform: scale(0.94);
    }
    .tools {
      display: flex;
      flex: none;
      margin-left: 4px;
    }
    .tools .on {
      color: var(--accent);
      background: var(--accent-soft);
    }
    .plain {
      display: flex;
      flex: none;
      align-items: center;
      gap: 9px;
      min-height: 38px;
      font-size: 0.92rem;
      font-weight: 500;
    }
    .setup {
      flex: 1;
      min-width: 0;
      margin-left: 14px;
      overflow: hidden;
      font-size: 0.75rem;
      color: var(--text-3);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .options {
      position: absolute;
      top: calc(100% + 8px);
      z-index: 1;
      display: grid;
      gap: 12px;
      width: min(calc(100% - 40px), 420px);
      max-height: min(66dvh, 540px);
      padding: 16px;
      overflow-y: auto;
      background: var(--glass-strong);
      -webkit-backdrop-filter: blur(30px) saturate(170%);
      backdrop-filter: blur(30px) saturate(170%);
      border: 1px solid var(--glass-edge);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      animation: pop 0.3s var(--ease-spring) both;
    }
    .pair {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    .checks {
      display: flex;
      gap: 18px;
    }
    .tasks {
      display: grid;
      gap: 6px;
      max-height: 130px;
      overflow-y: auto;
      border: none;
    }
    .tasks legend {
      margin-bottom: 6px;
    }
    @keyframes spark {
      50% { opacity: 0.45; transform: rotate(20deg) scale(0.86); }
    }
    @keyframes drop-in {
      from { opacity: 0; transform: translateY(-14px); }
    }
    @media (max-width: 760px) {
      :host {
        margin-top: 8px;
        padding: 0 10px;
      }
      .bar {
        min-height: 46px;
      }
      .setup {
        display: none;
      }
    }
  `,
  host: { '(window:keydown)': 'onWindowKey($event)' },
})
export class AssistantBar {
  protected readonly assistant = inject(Assistant);
  protected readonly browserOnly = environment.browserBackend;
  protected readonly brew = inject(Brew);
  private readonly schedule = inject(Schedule);
  private readonly router = inject(Router);

  protected readonly windows = WINDOWS;
  protected readonly placeholder = this.browserOnly ? 'Try: three blocks tomorrow' : 'Ask Claude to plan';
  protected readonly today = this.schedule.today; // in the user's zone, not the browser's
  private readonly prompt = viewChild<ElementRef<HTMLInputElement>>('prompt');

  /** The options panel: a choice, or the only way to ask once there's no model. */
  protected readonly panel = signal(false);
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

  /** "/" jumps to the input from anywhere on the page, and Esc closes the options. */
  protected onWindowKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') this.panel.set(false);
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || this.brew.dialog()) return;
    if ((e.target as HTMLElement).closest?.('input, textarea, select')) return;
    const el = this.prompt()?.nativeElement;
    if (el) {
      e.preventDefault();
      el.focus();
    }
  }

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
    this.text.set('');
    const res = await this.open({ text }, text);
    if (!res) this.text.set(text); // it failed, so don't make them type it again
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
    await this.open({ ask }, '');
  }

  protected async quick(): Promise<void> {
    await this.open({ quick: 'fill_today' }, '');
  }

  /** Every request opens the plan screen at once, and it fills in when the answer arrives. */
  private async open(req: PlanRequest, asked: string): Promise<PlanResponse | null> {
    this.assistant.asked.set(asked);
    this.assistant.reply.set('');
    this.panel.set(false);
    void this.router.navigate(['/plan']);
    const res = await this.assistant.request(req);
    if (res && !res.plan) this.assistant.reply.set(res.narration || 'I can plan focus time around your meetings. Try: three blocks tomorrow.');
    const first = res?.plan?.blocks[0]?.starts_at ?? res?.plan?.window_start;
    if (first && this.schedule.zone()) this.schedule.show(dayIn(first, this.schedule.zone()));
    return res;
  }
}
