import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Api, errorMessage } from '../api/api';
import { audio, chime, tick } from '../sound/audio';
import { Auth } from '../auth/auth';
import { LiveEvents } from '../api/live';
import { BUILTIN_MODES, fromPreset } from './modes';
import { Completed, FocusRequest, LiveEvent, Mode, Phase, Preset, Settings, Stats, Task, TimerAction } from '../api/models';
import { persistedSignal } from './persisted';
import { formatClock, localDay } from './time';
import { Timer } from './timer';
import { Toasts } from './toast';

const DEFAULT_SETTINGS: Settings = {
  sound: true,
  notify: false,
  autoBreak: true,
  strict: false,
  breathe: true,
  tick: 'off',
};

export type Dialog = 'intention' | 'breathe' | 'reflect' | 'settings' | null;
type Resource = 'presets' | 'tasks' | 'sessions' | 'settings' | 'account';

/**
 * The session flow and the user's productivity data. It turns live server events
 * into UI state and runs intention → (breathe) → focus → reflect → break. The
 * timer itself runs on the server, so every tab and device follows along.
 */
@Injectable({ providedIn: 'root' })
export class Brew {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly live = inject(LiveEvents);
  private readonly toasts = inject(Toasts);
  readonly timer = inject(Timer);

  // ---- data ----------------------------------------------------------------------------
  readonly presets = signal<Preset[]>([]);
  readonly tasks = signal<Task[]>([]);
  readonly stats = signal<Stats | null>(null);
  readonly settings = computed(() => this.auth.user()?.settings ?? DEFAULT_SETTINGS);

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
    this.live.events$.subscribe((e) => this.handle(e));
    this.tickClock();
    this.strictMode();
    this.liveTab();
  }

  // ---- lifecycle -------------------------------------------------------------------------

  /** After login: open the live stream and load everything. */
  async start(): Promise<void> {
    this.live.connect();
    await Promise.all((['presets', 'tasks', 'sessions'] as Resource[]).map((r) => this.refresh(r)));
    this.timer.apply(await this.api.timer());
  }

  /** After logout: drop the stream and the user's data. */
  stop(): void {
    this.live.disconnect();
    this.timer.reset();
    this.presets.set([]);
    this.tasks.set([]);
    this.stats.set(null);
    this.reflecting.set(null);
    this.pendingBreak.set(false);
    this.dialog.set(null);
  }

  async refresh(kind: Resource): Promise<void> {
    try {
      if (kind === 'presets') this.presets.set(await this.api.presets());
      if (kind === 'tasks') this.tasks.set(await this.api.tasks());
      if (kind === 'sessions') this.stats.set(await this.api.stats());
      if (kind === 'settings' || kind === 'account') await this.auth.restore();
    } catch {
      // A 401 is handled by the interceptor; anything else is retried on the next event.
    }
  }

  private handle(e: LiveEvent): void {
    switch (e.type) {
      case 'timer':
        this.timer.apply(e.data);
        if (e.data.status !== 'idle') {
          this.pendingBreak.set(false);
          if (this.reflecting()) this.closeReflection(); // another device moved on
        }
        break;
      case 'session.completed':
        if (e.data.session.completed) this.announce('focus', 'Brew complete. Time for a break ☕');
        this.reflecting.set(e.data);
        this.dialog.set('reflect');
        void this.refresh('sessions');
        void this.refresh('tasks');
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
        void this.refresh(e.data.kind);
        break;
    }
  }

  // ---- session flow ----------------------------------------------------------------------

  primary(): void {
    audio(); // unlock Web Audio inside the click so later chimes can play
    const { status } = this.timer.state();
    if (status === 'running') this.control('pause');
    else if (status === 'paused') this.control('resume');
    else if (this.pendingBreak()) void this.startBreak();
    else this.dialog.set('intention');
  }

  beginFocus(intention: string, taskId: number | null, breathe: boolean): void {
    this.taskId.set(taskId);
    if (breathe !== this.settings().breathe) void this.updateSettings({ breathe });
    const m = this.mode();
    this.pending = { mode: m.name, planned: m.focus * 60, intention, task_id: taskId };
    this.distractions = 0;
    if (breathe) this.dialog.set('breathe');
    else void this.launch();
  }

  /** Start the prepared focus block (after the intention, and breathing if chosen). */
  async launch(): Promise<void> {
    this.dialog.set(null);
    const req = this.pending;
    this.pending = undefined;
    if (req) await this.attempt(() => this.timer.startFocus({ ...req, day: localDay() }));
  }

  async finishReflection(note: string): Promise<void> {
    const done = this.reflecting();
    this.closeReflection();
    if (!done) return;
    if (note) this.api.reflect(done.session.id, note).catch((err) => this.toasts.show(errorMessage(err)));
    if (!this.mode().rest) return;
    if (this.settings().autoBreak) await this.startBreak();
    else this.pendingBreak.set(true);
  }

  private closeReflection(): void {
    this.reflecting.set(null);
    if (this.dialog() === 'reflect') this.dialog.set(null);
  }

  async startBreak(): Promise<void> {
    this.pendingBreak.set(false);
    await this.attempt(() => this.timer.startBreak(this.mode().rest * 60));
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
    void this.attempt(() => this.timer.control(action));
  }

  private async attempt(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.toasts.show(errorMessage(err));
    }
  }

  // ---- modes & tasks -----------------------------------------------------------------------

  selectMode(mode: Mode): void {
    this.modeKey.set(mode.key);
  }

  async createMode(name: string, focus: number, rest: number): Promise<void> {
    const preset = await this.api.createPreset({ name, focus, rest }); // errors go back to the form
    this.presets.update((list) => (list.some((p) => p.id === preset.id) ? list : [...list, preset]));
    this.modeKey.set(fromPreset(preset).key);
    this.toasts.show(`Saved “${preset.name}”`);
  }

  async deleteMode(mode: Mode): Promise<void> {
    if (mode.presetId === undefined) return;
    await this.attempt(async () => {
      await this.api.deletePreset(mode.presetId!);
      this.presets.update((list) => list.filter((p) => p.id !== mode.presetId));
      if (mode.key === this.modeKey()) this.modeKey.set(BUILTIN_MODES[0].key);
    });
  }

  async addTask(title: string, estimate: number): Promise<void> {
    await this.attempt(async () => {
      const task = await this.api.createTask(title, estimate);
      // The live "changed" event may have refetched the list already, so add it only if it's missing.
      this.tasks.update((list) =>
        list.some((t) => t.id === task.id) ? list : [...list.filter((t) => !t.done), task, ...list.filter((t) => t.done)],
      );
    });
  }

  async toggleTask(task: Task): Promise<void> {
    this.tasks.update((list) => list.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)));
    await this.attempt(() => this.api.updateTask(task.id, { done: !task.done }));
    if (task.id === this.taskId() && !task.done) this.taskId.set(null);
    void this.refresh('tasks');
  }

  async removeTask(task: Task): Promise<void> {
    await this.attempt(async () => {
      await this.api.deleteTask(task.id);
      this.tasks.update((list) => list.filter((t) => t.id !== task.id));
      if (task.id === this.taskId()) this.taskId.set(null);
    });
  }

  /** Pick a task and open the intention prompt for it. */
  focusOn(task: Task): void {
    this.taskId.set(task.id);
    if (this.timer.state().status === 'idle' && !this.pendingBreak()) this.primary();
  }

  // ---- settings ----------------------------------------------------------------------------

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    const user = this.auth.user();
    if (!user) return;
    if (patch.notify && !user.settings.notify && !(await this.allowNotifications())) {
      this.toasts.show('Notifications are blocked for this site in your browser.');
      return;
    }
    this.auth.user.set({ ...user, settings: { ...user.settings, ...patch } }); // optimistic
    try {
      await this.api.saveSettings({ ...user.settings, ...patch });
    } catch (err) {
      this.auth.user.set(user);
      this.toasts.show(errorMessage(err));
    }
  }

  async clearData(): Promise<void> {
    if (!confirm('Delete every logged session? Tasks and custom modes are kept.')) return;
    await this.attempt(async () => {
      await this.api.clearSessions();
      await Promise.all([this.refresh('sessions'), this.refresh('tasks')]);
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

  /** Strict mode: every tab switch mid-focus is logged on the server, and closing asks first. */
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
