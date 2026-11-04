import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { audio, chime, tick } from '../sound/audio';
import { Completed, FocusRequest, Mode, Phase, Preset, Settings, Stats, StoreEvent, Task, TimerAction } from '../data/models';
import { Store, errorMessage } from '../data/store';
import { BUILTIN_MODES, fromPreset } from './modes';
import { persistedSignal } from './persisted';
import { formatClock, localDay } from './time';
import { Timer } from './timer';
import { Toasts } from './toast';

export type Dialog = 'intention' | 'breathe' | 'reflect' | 'settings' | null;
type Resource = 'presets' | 'tasks' | 'sessions' | 'settings';

/**
 * The app's state: it turns the store's events into what the screen shows, and runs the focus
 * flow, intention → (breathe) → focus → reflect → break. Every open tab follows along.
 */
@Injectable({ providedIn: 'root' })
export class Brew {
  private readonly store = inject(Store);
  private readonly toasts = inject(Toasts);
  readonly timer = inject(Timer);

  // ---- data ----------------------------------------------------------------------------
  readonly presets = signal<Preset[]>(this.store.presets());
  readonly tasks = signal<Task[]>(this.store.tasks());
  readonly stats = signal<Stats>(this.store.stats());
  readonly settings = signal<Settings>(this.store.settings());

  readonly modes = computed<Mode[]>(() => [...BUILTIN_MODES, ...this.presets().map(fromPreset)]);
  private readonly modeKey = persistedSignal('brew:mode', BUILTIN_MODES[0].key);
  readonly mode = computed(() => this.modes().find((m) => m.key === this.modeKey()) ?? BUILTIN_MODES[0]);
  /** The task the next focus block is for. */
  readonly taskId = signal<number | null>(null);

  // ---- flow ----------------------------------------------------------------------------
  readonly dialog = signal<Dialog>(null);
  readonly reflecting = signal<Completed | null>(null);
  /** A break is due but auto-start is off, so it waits for the play button. */
  readonly pendingBreak = signal(false);
  private pending?: Omit<FocusRequest, 'day'>; // set by the intention dialog, sent after breathing
  private distractions = 0;

  readonly phase = computed<Phase>(() => {
    const s = this.timer.state();
    if (s.status !== 'idle') return s.phase;
    return this.pendingBreak() ? 'break' : 'focus';
  });
  /** Mid-session: modes can't change. */
  readonly busy = computed(() => this.timer.state().status !== 'idle' || this.pendingBreak() || !!this.reflecting());
  readonly display = computed(() => {
    const s = this.timer.state();
    if (s.status !== 'idle') return { durationMs: s.duration_ms, remainingMs: this.timer.remainingMs() };
    if (this.reflecting()) return { durationMs: 1, remainingMs: 0 }; // just drained the mug
    const ms = (this.pendingBreak() ? this.mode().rest : this.mode().focus) * 60_000;
    return { durationMs: ms, remainingMs: ms };
  });
  readonly progress = computed(() => {
    const { durationMs, remainingMs } = this.display();
    return durationMs ? 1 - remainingMs / durationMs : 0;
  });
  /** Coffee drains while focusing and refills on a break. */
  readonly fill = computed(() => (this.phase() === 'focus' ? 1 - this.progress() : this.progress()));
  readonly intention = computed(() => this.timer.state().intention ?? '');

  constructor() {
    this.store.events$.subscribe((e) => this.handle(e));
    this.tickClock();
    this.strictMode();
    this.liveTab();
    effect(() => {
      if (this.store.unsaved()) this.toasts.show("This browser won't save, so changes last until you close the tab.");
    });
  }

  /** Read one kind of data from the store again. */
  refresh(kind: Resource): void {
    if (kind === 'presets') this.presets.set(this.store.presets());
    if (kind === 'tasks') this.tasks.set(this.store.tasks());
    if (kind === 'sessions') this.stats.set(this.store.stats());
    if (kind === 'settings') this.settings.set(this.store.settings());
  }

  private handle(e: StoreEvent): void {
    switch (e.type) {
      case 'timer':
        this.timer.apply(e.data);
        if (e.data.status !== 'idle') {
          this.pendingBreak.set(false);
          if (this.reflecting()) this.closeReflection(); // another tab moved on
        }
        break;
      case 'session.completed':
        if (e.data.session.completed) this.announce('focus', 'Brew complete. Time for a break ☕');
        this.reflecting.set(e.data);
        this.dialog.set('reflect');
        this.refresh('sessions');
        this.refresh('tasks');
        break;
      case 'session.discarded':
        this.toasts.show('Under a minute, so not logged.');
        break;
      case 'break.completed':
        if (e.data.completed) this.announce('break', 'Break over. Ready for another brew?');
        break;
      case 'session.reflected':
        if (this.reflecting()?.session.id === e.data.id) this.closeReflection();
        break;
      case 'changed':
        this.refresh(e.data.kind);
        break;
    }
  }

  // ---- session flow ----------------------------------------------------------------------

  primary(): void {
    audio(); // unlock Web Audio inside the click so later chimes can play
    const { status } = this.timer.state();
    if (status === 'running') this.control('pause');
    else if (status === 'paused') this.control('resume');
    else if (this.pendingBreak()) this.startBreak();
    else this.dialog.set('intention');
  }

  beginFocus(intention: string, taskId: number | null, breathe: boolean): void {
    this.taskId.set(taskId);
    if (breathe !== this.settings().breathe) void this.updateSettings({ breathe });
    const m = this.mode();
    this.pending = { mode: m.name, planned: m.focus * 60, intention, task_id: taskId };
    this.distractions = 0;
    if (breathe) this.dialog.set('breathe');
    else this.launch();
  }

  /** Start the prepared focus block (after the intention, and breathing if chosen). */
  launch(): void {
    this.dialog.set(null);
    const req = this.pending;
    this.pending = undefined;
    if (req) this.attempt(() => this.timer.startFocus({ ...req, day: localDay() }));
  }

  /** Save the note, then move on to the break. */
  finishReflection(note: string): void {
    const done = this.reflecting();
    this.closeReflection();
    if (!done) return;
    if (note) this.attempt(() => this.store.reflect(done.session.id, note));
    if (!this.mode().rest) return;
    if (this.settings().autoBreak) this.startBreak();
    else this.pendingBreak.set(true);
  }

  private closeReflection(): void {
    this.reflecting.set(null);
    if (this.dialog() === 'reflect') this.dialog.set(null);
  }

  startBreak(): void {
    this.pendingBreak.set(false);
    this.attempt(() => this.timer.startBreak(this.mode().rest * 60));
  }

  /** Finish focus early (logged if at least a minute) or skip a break. */
  skip(): void {
    if (this.timer.state().status !== 'idle') this.control('finish');
    else this.pendingBreak.set(false);
  }

  /** Abandon the current block without logging it. */
  reset(): void {
    if (this.timer.state().status !== 'idle') this.control('cancel');
    else this.pendingBreak.set(false);
  }

  /** Space, R and S, when focus isn't in a form control. */
  onKey(e: KeyboardEvent): void {
    if (this.dialog() || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, button, summary')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.primary();
    } else if (e.key === 'r') this.reset();
    else if (e.key === 's') this.skip();
  }

  private control(action: TimerAction): void {
    this.attempt(() => this.timer.control(action));
  }

  /** Runs an action, showing any mistake as a toast. */
  private attempt(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.toasts.show(errorMessage(err));
    }
  }

  // ---- modes & tasks -----------------------------------------------------------------------

  selectMode(mode: Mode): void {
    this.modeKey.set(mode.key);
  }

  /** Mistakes are thrown back to the form, which shows them beside the fields. */
  createMode(name: string, focus: number, rest: number): void {
    const preset = this.store.createPreset({ name, focus, rest });
    this.modeKey.set(fromPreset(preset).key);
    this.toasts.show(`Saved “${preset.name}”`);
  }

  deleteMode(mode: Mode): void {
    if (mode.presetId === undefined) return;
    this.attempt(() => {
      this.store.deletePreset(mode.presetId!);
      if (mode.key === this.modeKey()) this.modeKey.set(BUILTIN_MODES[0].key);
    });
  }

  addTask(title: string, estimate: number): void {
    this.attempt(() => this.store.createTask(title, estimate));
  }

  toggleTask(task: Task): void {
    this.attempt(() => this.store.setTaskDone(task.id, !task.done));
    if (task.id === this.taskId() && !task.done) this.taskId.set(null);
  }

  removeTask(task: Task): void {
    this.attempt(() => this.store.deleteTask(task.id));
    if (task.id === this.taskId()) this.taskId.set(null);
  }

  /** Pick a task and open the intention prompt for it. */
  focusOn(task: Task): void {
    this.taskId.set(task.id);
    if (this.timer.state().status === 'idle' && !this.pendingBreak()) this.primary();
  }

  // ---- settings ----------------------------------------------------------------------------

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    if (patch.notify && !this.settings().notify && !(await this.allowNotifications())) {
      this.toasts.show('Notifications are blocked for this site in your browser.');
      return;
    }
    this.attempt(() => this.store.saveSettings({ ...this.settings(), ...patch }));
  }

  clearData(): void {
    if (!confirm('Delete every logged session? Tasks and custom modes are kept.')) return;
    this.attempt(() => {
      this.store.clearSessions();
      this.refresh('tasks'); // their totals came from those sessions
      this.toasts.show('All sessions deleted.');
    });
  }

  private async allowNotifications(): Promise<boolean> {
    if (!('Notification' in window)) return false;
    return Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted';
  }

  // ---- side effects: sound, strict mode, the browser tab ------------------------------------

  private announce(phase: Phase, message: string): void {
    const { sound, notify } = this.settings();
    if (sound) chime(phase);
    if (notify && document.hidden && Notification.permission === 'granted') {
      new Notification('Brew Focus', { body: message, icon: 'favicon.svg' });
    }
  }

  /** Optional ticking for auditory pressure; the final minute ticks louder. */
  private tickClock(): void {
    const second = computed(() => Math.ceil(this.timer.remainingMs() / 1000));
    effect(() => {
      const s = second(); // the only dependency: runs once per second
      untracked(() => {
        const { status, phase } = this.timer.state();
        const style = this.settings().tick;
        if (status === 'running' && phase === 'focus' && style !== 'off') tick(style, s, s <= 60);
      });
    });
  }

  /** Strict mode: every tab switch mid-focus is logged as a distraction, and closing asks first. */
  private strictMode(): void {
    const active = computed(() => {
      const { status, phase } = this.timer.state();
      return this.settings().strict && status === 'running' && phase === 'focus';
    });
    effect((onCleanup) => {
      if (!active()) return;
      const onVisibility = () => {
        if (document.hidden) {
          this.distractions += 1;
          this.control('distraction');
        } else {
          this.toasts.show(`Welcome back. Distraction #${this.distractions} logged.`);
        }
      };
      const onLeave = (e: BeforeUnloadEvent) => e.preventDefault(); // "Leave site?"
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('beforeunload', onLeave);
      onCleanup(() => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('beforeunload', onLeave);
      });
    });
  }

  /** The web's answer to a lock-screen widget: a counting-down title and a draining favicon. */
  private liveTab(): void {
    const title = computed(() => {
      const { status, phase } = this.timer.state();
      if (status === 'idle') return 'Brew Focus';
      return `${formatClock(this.timer.remainingMs() / 1000)} · ${phase === 'focus' ? 'Focus' : 'Break'}`;
    });
    effect(() => (document.title = title()));

    const level = computed(() => Math.round(this.fill() * 10));
    effect(() => {
      const link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (link) link.href = mugIcon(level());
    });
  }
}

/** A 16×16 pixel mug whose coffee level (0–10 rows) mirrors the timer. */
function mugIcon(level: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const g = canvas.getContext('2d');
  if (!g) return 'favicon.svg';
  g.scale(2, 2);
  const px = (color: string, x: number, y: number, w: number, h: number) => {
    g.fillStyle = color;
    g.fillRect(x, y, w, h);
  };
  px('#2A2A2A', 1, 3, 12, 12); // outline
  px('#FFFFFF', 2, 4, 10, 10); // cup
  if (level > 0) {
    px('#6F4E37', 2, 14 - level, 10, level); // coffee
    px('#A67C52', 2, 14 - level, 10, 1); // surface
  }
  px('#2A2A2A', 13, 5, 3, 7); // handle
  g.clearRect(13, 7, 1, 3);
  return canvas.toDataURL();
}
