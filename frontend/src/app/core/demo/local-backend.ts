import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Subject, from, mergeMap, of, throwError } from 'rxjs';
import { LiveEvent, Phase, Preset, Session, Settings, Stats, Task, TimerState, User } from '../api/models';
import { localDay } from '../state/time';
import { CAFE } from '../../shared/pixel-art/sprites';
import { StoredTask, defaultSettings, demoHistory, demoTasks } from './demo-data';

/**
 * The Go API, running inside the browser, for the GitHub Pages demo (static hosting only).
 * Same routes, rules, status codes and events as backend/internal/api, with these swaps:
 *
 *  - Data lives in localStorage instead of SQLite, and starts from a sample account.
 *  - Timer deadlines are setTimeouts in every open tab, and a Web Lock makes exactly one tab
 *    finish each block (the server uses one goroutine per timer).
 *  - Events reach other tabs over a BroadcastChannel (the server uses SSE).
 *
 * There are no accounts, so nothing here ever asks for or stores a password.
 */

export const LOCAL_DB_KEY = 'brew:pages-demo-v2';
const MIN_LOGGED_MS = 60_000; // a block ended earlier than this isn't worth logging
const HEATMAP_DAYS = 371;
const USER = { id: 1, email: 'demo@brewfocus.dev', name: 'Demo', has_password: false, google_linked: false };

/** The running timer, as the engine's actor would hold it. */
interface ActiveTimer {
  phase: Phase;
  status: 'running' | 'paused';
  duration_ms: number;
  remaining_ms: number; // while paused
  ends_at?: string; // while running
  started_at: string;
  session_id?: number;
  mode?: string;
  intention?: string;
  task_id?: number | null;
  day?: string;
  distractions: number;
}

/** Everything the demo keeps, saved as one JSON document. */
interface Db {
  nextId: number;
  settings: Settings;
  presets: Preset[];
  tasks: StoredTask[];
  sessions: Session[]; // finished focus blocks
  timer: ActiveTimer | null;
}

type Body = Record<string, unknown>;

/** Becomes an HTTP error response, as a handler's early return does on the server. */
class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Body = {},
  ) {
    super(message);
  }
}

export interface LocalResponse {
  status: number;
  body: unknown;
}

@Injectable({ providedIn: 'root' })
export class LocalBackend {
  private readonly events = new Subject<LiveEvent>();
  private readonly channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCAL_DB_KEY);
  private memory?: Db; // used when localStorage is unavailable
  private alarm?: ReturnType<typeof setTimeout>;

  /** Events from this tab and every other open tab. */
  readonly events$ = this.events.asObservable();

  constructor() {
    this.channel?.addEventListener('message', (e: MessageEvent<LiveEvent>) => this.events.next(e.data));
    addEventListener('storage', (e) => {
      if (e.key === LOCAL_DB_KEY) this.arm(); // another tab changed the timer
    });
    this.arm(); // also finishes a block whose deadline passed while no tab was open
  }

  /** Answer one API request. */
  async handle(method: string, url: string, body: unknown): Promise<LocalResponse> {
    try {
      const { pathname, searchParams } = new URL(url, 'http://local');
      const parts = pathname.replace(/^\/api\//, '').split('/');
      const ids = parts.filter((p) => /^\d+$/.test(p)).map(Number);
      const route = `${method} ${parts.map((p) => (/^\d+$/.test(p) ? ':id' : p)).join('/')}`;
      const result = this.route(route, ids[0], parts.at(-1), searchParams, (body ?? {}) as Body);
      const created = route === 'POST presets' || route === 'POST tasks';
      return { status: result === undefined ? 204 : created ? 201 : 200, body: result ?? null };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: err.message, ...err.extra } };
      return { status: 500, body: { error: 'something went wrong on our side' } };
    }
  }

  private route(route: string, id: number, last: string | undefined, query: URLSearchParams, body: Body): unknown {
    const db = this.read();
    switch (route) {
      case 'GET health':
        return { ok: true };
      case 'GET me':
      case 'POST auth/login':
      case 'POST auth/register':
        return this.user(db);
      case 'POST auth/logout':
      case 'POST auth/logout-all':
        return undefined;
      case 'GET auth/providers':
        return { google: false };
      case 'PUT me/settings':
        return this.saveSettings(db, body);

      case 'GET presets':
        return db.presets;
      case 'POST presets':
        return this.createPreset(db, body);
      case 'DELETE presets/:id':
        return this.remove(db, 'presets', id);

      case 'GET tasks':
        return this.tasks(db);
      case 'POST tasks':
        return this.createTask(db, body);
      case 'PATCH tasks/:id':
        return this.updateTask(db, id, body);
      case 'DELETE tasks/:id':
        return this.remove(db, 'tasks', id);

      case 'GET timer':
        return this.snapshot(db.timer);
      case 'GET sessions':
        return db.sessions.slice(-clamp(Number(query.get('limit') ?? 20) || 20, 1, 100)).reverse();
      case 'PATCH sessions/:id':
        return this.reflect(db, id, body);
      case 'DELETE sessions':
        db.sessions = [];
        this.save(db, 'sessions');
        return undefined;
      case 'GET stats':
        return this.stats(db, query.get('today') ?? localDay());
    }
    if (route.startsWith('POST timer/') && last) return this.timerAction(db, last, body);
    throw new ApiError(404, 'not found');
  }

  // ---- account ----------------------------------------------------------------------

  private user(db: Db): User {
    return { ...USER, settings: db.settings };
  }

  private saveSettings(db: Db, body: Body): Settings {
    const next = { ...defaultSettings(), ...(body as Partial<Settings>) };
    if (!['off', 'clock', 'ominous'].includes(next.tick)) {
      throw new ApiError(400, 'tick must be one of: off clock ominous');
    }
    db.settings = next;
    this.save(db, 'settings');
    return next;
  }

  // ---- presets & tasks -----------------------------------------------------------------

  private createPreset(db: Db, body: Body): Preset {
    const preset = {
      id: db.nextId,
      name: text(body, 'name', 32, true),
      focus: whole(body, 'focus', 1, 180),
      rest: whole(body, 'rest', 0, 60),
    };
    db.nextId++;
    db.presets.push(preset);
    this.save(db, 'presets');
    return preset;
  }

  /** Open tasks first, each with its totals from finished sessions. */
  private tasks(db: Db): Task[] {
    const totals = new Map<number, { brews: number; seconds: number }>();
    for (const s of db.sessions) {
      if (s.task_id === null) continue;
      const t = totals.get(s.task_id) ?? { brews: 0, seconds: 0 };
      t.brews += s.completed ? 1 : 0;
      t.seconds += s.focused;
      totals.set(s.task_id, t);
    }
    return [...db.tasks]
      .sort((a, b) => Number(a.done) - Number(b.done) || a.id - b.id)
      .map((t) => ({ ...t, brews: totals.get(t.id)?.brews ?? 0, minutes: Math.floor((totals.get(t.id)?.seconds ?? 0) / 60) }));
  }

  private createTask(db: Db, body: Body): Task {
    const task: StoredTask = {
      id: db.nextId,
      title: text(body, 'title', 120, true),
      estimate: whole(body, 'estimate', 1, 20, 1),
      done: false,
    };
    db.nextId++;
    db.tasks.push(task);
    this.save(db, 'tasks');
    return { ...task, brews: 0, minutes: 0 };
  }

  private updateTask(db: Db, id: number, body: Body): StoredTask {
    const task = db.tasks.find((t) => t.id === id);
    if (!task) throw new ApiError(404, 'not found');
    if (body['title'] !== undefined) task.title = text(body, 'title', 120, true);
    if (body['estimate'] !== undefined) task.estimate = whole(body, 'estimate', 1, 20);
    if (typeof body['done'] === 'boolean') task.done = body['done'];
    this.save(db, 'tasks');
    return task;
  }

  private remove(db: Db, kind: 'presets' | 'tasks', id: number): undefined {
    const list = db[kind] as { id: number }[];
    const index = list.findIndex((item) => item.id === id);
    if (index < 0) throw new ApiError(404, 'not found');
    list.splice(index, 1);
    this.save(db, kind);
    return undefined;
  }

  // ---- journal & stats -------------------------------------------------------------------

  private reflect(db: Db, id: number, body: Body): Session {
    const session = db.sessions.find((s) => s.id === id);
    if (!session) throw new ApiError(404, 'not found');
    session.reflection = text(body, 'reflection', 280);
    this.write(db);
    this.publish({ type: 'session.reflected', data: { id } });
    return session;
  }

  /** Today's totals, streaks, all-time totals and a heatmap, as backend/internal/api/stats.go. */
  private stats(db: Db, today: string): Stats {
    const days = new Map<string, { seconds: number; sessions: number; completed: number }>();
    for (const s of db.sessions) {
      const d = days.get(s.day) ?? { seconds: 0, sessions: 0, completed: 0 };
      d.seconds += s.focused;
      d.sessions += 1;
      d.completed += s.completed ? 1 : 0;
      days.set(s.day, d);
    }
    const minutes = Object.fromEntries([...days].map(([day, d]) => [day, Math.floor(d.seconds / 60)]));
    const [streak, best] = streaks(new Set(days.keys()), today);
    const cutoff = shiftDay(today, -HEATMAP_DAYS);
    const sum = (field: 'sessions' | 'completed') => [...days.values()].reduce((n, d) => n + d[field], 0);
    return {
      today: { minutes: minutes[today] ?? 0, sessions: days.get(today)?.sessions ?? 0 },
      streak,
      best_streak: best,
      total: {
        minutes: Object.values(minutes).reduce((n, m) => n + m, 0),
        sessions: sum('sessions'),
        completed: sum('completed'),
      },
      heatmap: Object.fromEntries(Object.entries(minutes).filter(([day]) => day > cutoff)),
    };
  }

  // ---- the timer ---------------------------------------------------------------------------

  /** POST /api/timer/:action, with the same rules as backend/internal/engine. */
  private timerAction(db: Db, action: string, body: Body): TimerState {
    const t = db.timer;
    switch (action) {
      case 'focus': {
        const mode = text(body, 'mode', 32, true);
        const planned = whole(body, 'planned', 60, 10_800) * 1000;
        const intention = text(body, 'intention', 140);
        const day = date(body, 'day');
        const taskId = typeof body['task_id'] === 'number' ? body['task_id'] : null;
        const task = taskId === null ? undefined : db.tasks.find((x) => x.id === taskId);
        if (taskId !== null && !task) throw new ApiError(404, 'not found');
        this.ensureIdle(db);
        db.timer = {
          ...this.running(planned),
          phase: 'focus',
          session_id: db.nextId++,
          mode,
          intention: intention || task?.title || '',
          task_id: taskId,
          day,
        };
        break;
      }
      case 'break': {
        const length = whole(body, 'length', 60, 3600) * 1000;
        this.ensureIdle(db);
        db.timer = { ...this.running(length), phase: 'break' };
        break;
      }
      case 'pause':
      case 'resume':
      case 'finish':
      case 'cancel':
      case 'distraction': {
        if (!t) throw new ApiError(409, 'no timer is running', { timer: this.snapshot(null) });
        if (action === 'finish') return this.end(db, false);
        if (action === 'cancel') {
          db.timer = null;
          return this.commit(db, this.snapshot(null, t.phase));
        }
        if (action === 'distraction' && t.phase === 'focus') {
          t.distractions++;
          this.write(db);
          return this.snapshot(t); // nothing visible changed, so no broadcast
        }
        if (action === 'pause' && t.status === 'running') {
          Object.assign(t, { status: 'paused', remaining_ms: remainingOf(t), ends_at: undefined });
        } else if (action === 'resume' && t.status === 'paused') {
          Object.assign(t, { status: 'running', ends_at: new Date(Date.now() + t.remaining_ms).toISOString() });
        } else {
          throw new ApiError(409, "that action doesn't apply to the timer right now", { timer: this.snapshot(t) });
        }
        break;
      }
      default:
        throw new ApiError(404, 'not found');
    }
    return this.commit(db, this.snapshot(db.timer));
  }

  private running(durationMs: number): Omit<ActiveTimer, 'phase'> {
    const now = Date.now();
    return {
      status: 'running',
      duration_ms: durationMs,
      remaining_ms: durationMs,
      ends_at: new Date(now + durationMs).toISOString(),
      started_at: new Date(now).toISOString(),
      distractions: 0,
    };
  }

  private ensureIdle(db: Db): void {
    if (db.timer) throw new ApiError(409, 'a timer is already running', { timer: this.snapshot(db.timer) });
  }

  /** Save, re-arm the deadline, and broadcast the new timer state. */
  private commit(db: Db, state: TimerState): TimerState {
    this.write(db);
    this.arm();
    this.publish({ type: 'timer', data: state });
    return state;
  }

  /** Arm this tab's alarm for the running timer's deadline (every open tab does). */
  private arm(): void {
    clearTimeout(this.alarm);
    const t = this.read().timer;
    if (t?.status === 'running') this.alarm = setTimeout(() => this.expire(), Math.max(0, Date.parse(t.ends_at!) - Date.now()));
  }

  private expire(): void {
    const finish = () => {
      const db = this.read(); // re-read inside the lock: another tab may have finished it already
      const t = db.timer;
      if (t?.status !== 'running') return;
      if (Date.parse(t.ends_at!) > Date.now()) return this.arm(); // woke early (e.g. resumed elsewhere)
      this.end(db, true);
    };
    // Exactly one tab finishes each block: the server's single goroutine per timer, in browser form.
    if (typeof navigator !== 'undefined' && navigator.locks) void navigator.locks.request(LOCAL_DB_KEY, finish);
    else finish();
  }

  /** Finish the timer: log the focus block (or discard one under a minute ended early) and announce it. */
  private end(db: Db, completed: boolean): TimerState {
    const t = db.timer!;
    db.timer = null;
    const elapsed = t.duration_ms - (completed ? 0 : remainingOf(t));
    let announce: LiveEvent;
    if (t.phase === 'break') {
      announce = { type: 'break.completed', data: { completed } };
    } else if (!completed && elapsed < MIN_LOGGED_MS) {
      announce = { type: 'session.discarded', data: null };
    } else {
      const session: Session = {
        id: t.session_id!,
        task_id: t.task_id ?? null,
        mode: t.mode!,
        planned: Math.round(t.duration_ms / 1000),
        focused: Math.round(elapsed / 1000),
        completed,
        intention: t.intention ?? '',
        reflection: '',
        distractions: t.distractions,
        day: t.day!,
        created_at: t.started_at,
      };
      db.sessions.push(session);
      const full = db.sessions.filter((s) => s.completed).length;
      const unlocked = completed ? CAFE.find((item) => item.at === full)?.id : undefined;
      announce = { type: 'session.completed', data: { session, unlocked } };
    }
    const idle = this.commit(db, this.snapshot(null, t.phase));
    this.publish(announce);
    return idle;
  }

  /** The timer as the API describes it. */
  private snapshot(t: ActiveTimer | null, phase: Phase = 'focus'): TimerState {
    const server_time = new Date().toISOString();
    if (!t) return { phase, status: 'idle', duration_ms: 0, remaining_ms: 0, server_time };
    return {
      phase: t.phase,
      status: t.status,
      duration_ms: t.duration_ms,
      remaining_ms: remainingOf(t),
      ends_at: t.ends_at,
      session_id: t.session_id,
      mode: t.mode,
      intention: t.intention,
      task_id: t.task_id ?? undefined,
      server_time,
    };
  }

  // ---- storage & events --------------------------------------------------------------------

  private read(): Db {
    try {
      const saved = localStorage.getItem(LOCAL_DB_KEY); // the source of truth whenever storage works
      if (saved) this.memory = JSON.parse(saved) as Db;
    } catch {
      // Storage blocked or corrupt: carry on with what's in memory.
    }
    if (!this.memory) {
      this.memory = seed();
      this.write(this.memory);
    }
    return this.memory;
  }

  private write(db: Db): void {
    this.memory = db;
    try {
      localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
    } catch {
      // Private mode or full: the data lasts until the tab closes.
    }
  }

  /** Write, then tell every tab (including this one) to refetch that resource. */
  private save(db: Db, kind: 'presets' | 'tasks' | 'sessions' | 'settings'): void {
    this.write(db);
    this.publish({ type: 'changed', data: { kind } });
  }

  private publish(event: LiveEvent): void {
    this.events.next(event);
    this.channel?.postMessage(event);
  }
}

/** Serves every /api request from the in-browser backend. Provided only in the Pages build. */
export const localBackendInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const backend = inject(LocalBackend);
  return from(backend.handle(req.method, req.urlWithParams, req.body)).pipe(
    mergeMap((res) =>
      res.status < 400
        ? of(new HttpResponse({ status: res.status, body: res.body, url: req.url }))
        : throwError(() => new HttpErrorResponse({ status: res.status, error: res.body, url: req.url })),
    ),
  );
};

// ---- helpers ---------------------------------------------------------------------------------

/** A first visit's data. */
function seed(): Db {
  let id = 1;
  const nextId = () => id++;
  const tasks = demoTasks(nextId);
  const sessions = demoHistory(Date.now(), nextId);
  return { nextId: id, settings: defaultSettings(), presets: [], tasks, sessions, timer: null };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const remainingOf = (t: ActiveTimer) =>
  t.status === 'running' ? Math.max(0, Date.parse(t.ends_at!) - Date.now()) : t.remaining_ms;

/** Moves a YYYY-MM-DD day by n days. Noon, so a clock change can't land on the wrong day. */
function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d + n, 12));
}

/** The current and best runs of consecutive active days. Today doesn't break a streak yet. */
function streaks(active: Set<string>, today: string): [current: number, best: number] {
  let best = 0;
  let run = 0;
  let previous = '';
  for (const day of [...active].sort()) {
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    previous = day;
  }
  let current = 0;
  let cursor = active.has(today) ? today : shiftDay(today, -1);
  while (active.has(cursor)) {
    current++;
    cursor = shiftDay(cursor, -1);
  }
  return [current, best];
}

function whole(body: Body, key: string, lo: number, hi: number, fallback?: number): number {
  const value = body[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new ApiError(400, `${key} must be a whole number from ${lo} to ${hi}`);
  }
  return value;
}

function text(body: Body, key: string, max: number, required = false): string {
  const raw = body[key] ?? '';
  if (typeof raw !== 'string') throw new ApiError(400, `${key} must be text`);
  const value = raw.trim();
  if (required && !value) throw new ApiError(400, `${key} is required`);
  if (value.length > max) throw new ApiError(400, `${key} must be at most ${max} characters`);
  return value;
}

function date(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(400, `${key} must be a YYYY-MM-DD date`);
  }
  return value;
}
