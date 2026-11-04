import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Subject, from, mergeMap, of, throwError } from 'rxjs';
import {
  CalendarAccounts,
  DaySchedule,
  Insights,
  LiveEvent,
  Phase,
  PlanArgs,
  PlanResponse,
  PlanView,
  Preset,
  Rate,
  ScheduledBlock,
  Session,
  Settings,
  Stats,
  Task,
  TimerState,
  User,
} from '../models';
import { CAFE } from '../sprites';
import { dayIn, formatTime, shiftDay, wallTime, zonedInstant } from '../zoned';
import { StoredTask, defaultSettings, demoHistory, demoMeetings, demoTasks, weekdayOf } from './demo-data';
import { LocalPlanner, PlannerViolation } from './planner-wasm';

/**
 * The Go API, running inside the browser, for the GitHub Pages demo (static hosting only).
 * Same routes, rules, status codes and events as backend/internal/api, with these swaps:
 *
 *  - Data lives in localStorage instead of SQLite, and starts from a sample account.
 *  - The scheduler is the real Go planner, compiled to WebAssembly (./planner-wasm).
 *  - Timer deadlines are setTimeouts in every open tab, and a Web Lock makes exactly one tab
 *    finish each block (the server uses one goroutine per timer).
 *  - Events reach other tabs over a BroadcastChannel (the server uses SSE).
 *  - A phrase matcher stands in for the model, as ASSISTANT_PROVIDER=stub does on the server.
 *
 * There are no accounts, so nothing here ever asks for or stores a password.
 */

export const LOCAL_DB_KEY = 'brew:pages-demo-v1';
const MIN_LOGGED_MS = 60_000;
const HEATMAP_DAYS = 371;
const HISTORY_DAYS = 90;
const DAY_MS = 86_400_000;
const WARN_MS = 60_000; // backend/internal/scheduler: Warn
const LATE_MS = 60_000; // Late
const TICK_MS = 30_000; // Tick
const USER = { id: 1, email: 'demo@brewfocus.dev', name: 'Demo', has_password: false, google_linked: false, assistant_available: true };
const WINDOWS = ['today', 'tomorrow', 'this_week', 'next_week', 'custom'];
const BUILTIN_MODES = [
  { name: 'Pomodoro', focus_min: 25, rest_min: 5 },
  { name: '52 / 17', focus_min: 52, rest_min: 17 },
  { name: 'Animedoro', focus_min: 50, rest_min: 10 },
  { name: 'Deep Work', focus_min: 90, rest_min: 20 },
];
const MOVABLE = ['proposed', 'accepted', 'conflicted'];
const LIVE_BLOCKS = ['accepted', 'started'];
const VISIBLE_BLOCKS = ['accepted', 'started', 'done', 'conflicted'];
const NOT_PROPOSED = 'that plan is no longer open';

interface PlannerMode {
  name: string;
  focus_min: number;
  rest_min: number;
}

interface ActiveTimer {
  phase: Phase;
  status: 'running' | 'paused';
  duration_ms: number;
  remaining_ms: number; // while paused
  ends_at?: string; // while running
  started_at: string;
  session_id?: number;
  scheduled_id?: number;
  mode?: string;
  intention?: string;
  task_id?: number | null;
  day?: string;
  distractions: number;
}

type StoredPlan = Omit<PlanView, 'blocks'> & { allow_evening: boolean; allow_weekend: boolean };

interface Db {
  nextId: number;
  settings: Settings;
  presets: Preset[];
  tasks: StoredTask[];
  sessions: Session[]; // finished focus blocks
  timer: ActiveTimer | null;
  plans: StoredPlan[];
  blocks: ScheduledBlock[];
  assistantTurns: number;
  plannerMicros: number[]; // how long each scheduler run took
}

type Body = Record<string, unknown>;

/** A planning request. fill is the quick action's: it isn't part of the form or the model's tool. */
type LocalArgs = PlanArgs & { fill?: boolean };

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
  private readonly planner = inject(LocalPlanner);
  private readonly events = new Subject<LiveEvent>();
  private readonly channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(LOCAL_DB_KEY);
  private memory?: Db; // used when localStorage is unavailable
  private alarm?: ReturnType<typeof setTimeout>;
  private dispatchAlarm?: ReturnType<typeof setTimeout>;
  private readonly warned = new Set<number>();

  /** Events from this tab and every other open tab. */
  readonly events$ = this.events.asObservable();

  constructor() {
    this.channel?.addEventListener('message', (e: MessageEvent<LiveEvent>) => this.events.next(e.data));
    addEventListener('storage', (e) => {
      if (e.key === LOCAL_DB_KEY) this.arm(); // another tab changed the timer
    });
    this.arm(); // also finishes a block whose deadline passed while no tab was open
    this.dispatch();
  }

  /** Answer one API request. */
  async handle(method: string, url: string, body: unknown): Promise<LocalResponse> {
    try {
      const { pathname, searchParams } = new URL(url, 'http://local');
      const parts = pathname.replace(/^\/api\//, '').split('/');
      const ids = parts.filter((p) => /^\d+$/.test(p)).map(Number);
      const route = `${method} ${parts.map((p) => (/^\d+$/.test(p) ? ':id' : p)).join('/')}`;
      const result = await this.route(route, ids[0], parts.at(-1), searchParams, (body ?? {}) as Body);
      const created = route === 'POST presets' || route === 'POST tasks';
      return { status: result === undefined ? 204 : created ? 201 : 200, body: result ?? null };
    } catch (err) {
      if (err instanceof ApiError) return { status: err.status, body: { error: err.message, ...err.extra } };
      return { status: 503, body: { error: "The demo's scheduler couldn't load. Check your connection and try again." } };
    }
  }

  private async route(route: string, id: number, last: string | undefined, query: URLSearchParams, body: Body): Promise<unknown> {
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
        return this.stats(db, query.get('today') ?? dayIn(Date.now(), db.settings.timeZone));
      case 'GET insights':
        return this.insights(db);

      case 'GET calendar/accounts':
        return this.calendarAccounts();
      case 'POST calendar/sync':
        return this.calendarAccounts();
      case 'GET schedule':
        return this.schedule(db, query);

      case 'POST assistant/plan':
        return this.requestPlan(db, body);
      case 'GET plans/live':
        return db.plans
          .filter((p) => p.status === 'proposed')
          .slice(-1)
          .map((p) => this.view(db, p));
      case 'GET plans/:id':
        return this.view(db, this.plan(db, id));
      case 'POST plans/:id/accept':
        return this.accept(db, id, body);
      case 'POST plans/:id/reject':
        return this.reject(db, id);
      case 'PATCH scheduled/:id':
        return this.move(db, id, body);
      case 'DELETE scheduled/:id':
        return this.drop(db, id);
      case 'POST scheduled/:id/start':
        return this.startBlock(db, id);
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
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: next.timeZone });
    } catch {
      throw new ApiError(400, 'timeZone must be an IANA name such as Europe/Berlin');
    }
    if (!/^\d\d:\d\d$/.test(next.workdayStart) || !/^\d\d:\d\d$/.test(next.workdayEnd)) {
      throw new ApiError(400, 'the workday must be given as HH:MM times');
    }
    if (minutesOf(next.workdayEnd) - minutesOf(next.workdayStart) < 60) {
      throw new ApiError(400, 'the workday must end at least an hour after it starts');
    }
    inRange('minGapMin', next.minGapMin, 0, 120);
    inRange('bufferMin', next.bufferMin, 0, 60);
    inRange('maxBlocksPerDay', next.maxBlocksPerDay, 1, 12);
    inRange('maxFocusMinPerDay', next.maxFocusMinPerDay, 25, 720);
    db.settings = next;
    this.save(db, 'settings');
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
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
      due_at: due(body),
      priority: whole(body, 'priority', 0, 3, 0),
      energy: energy(body),
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
    if (body['due_at'] !== undefined) task.due_at = due(body);
    if (body['priority'] !== undefined) task.priority = whole(body, 'priority', 0, 3);
    if (body['energy'] !== undefined) task.energy = energy(body);
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

  /** The planning numbers, from the same rows backend/internal/api/insights.go reads. */
  private insights(db: Db): Insights {
    const decided = db.blocks.filter((b) => b.status !== 'proposed');
    const accepted = decided.filter((b) => b.status !== 'rejected');
    const acceptedPlans = db.plans.filter((p) => p.status === 'accepted');
    const partial = acceptedPlans.filter((p) =>
      db.blocks.some((b) => b.plan_id === p.id && b.status === 'rejected' && b.note === 'not picked'),
    );
    const planned = db.sessions.filter((s) => s.scheduled_id !== null);
    const adHoc = db.sessions.filter((s) => s.scheduled_id === null);
    const finished = db.tasks.filter((t) => t.done);
    const brewsOf = (id: number) => db.sessions.filter((s) => s.task_id === id && s.completed).length;
    const within = finished.filter((t) => Math.abs(brewsOf(t.id) - t.estimate) <= 1);
    const ratioSum = finished.reduce((n, t) => n + brewsOf(t.id) / Math.max(1, t.estimate), 0);
    const micros = [...db.plannerMicros].sort((a, b) => a - b);
    const percentile = (p: number) => micros[Math.min(micros.length - 1, Math.floor(micros.length * p))] ?? 0;
    return {
      acceptance: rate(accepted.length, decided.length),
      partial_accept: rate(partial.length, acceptedPlans.length),
      completion: {
        planned: rate(planned.filter((s) => s.completed).length, planned.length),
        ad_hoc: rate(adHoc.filter((s) => s.completed).length, adHoc.length),
      },
      estimate_accuracy: {
        within_one: rate(within.length, finished.length),
        mean_actual_over_estimate: finished.length ? ratioSum / finished.length : null,
      },
      tool_call_validity: rate(db.assistantTurns, db.assistantTurns),
      assistant: { turns: db.assistantTurns, degraded: 0, failures: {} },
      conflicts: rate(0, accepted.length), // the demo's sample calendar never changes under a plan
      scheduler_latency: { p50_us: percentile(0.5), p99_us: percentile(0.99), samples: micros.length },
    };
  }

  // ---- calendar ----------------------------------------------------------------------------

  private calendarAccounts(): CalendarAccounts {
    const now = new Date().toISOString();
    return {
      configured: false,
      provider: '',
      accounts: [{ id: 1, provider: 'sample calendar', external_id: 'demo@brewfocus.dev', last_sync_at: now, sync_error: '', created_at: now }],
    };
  }

  private schedule(db: Db, query: URLSearchParams): DaySchedule {
    const tz = db.settings.timeZone;
    const fromDay = query.get('from') ?? dayIn(Date.now(), tz);
    const toDay = query.get('to') ?? fromDay;
    const start = zonedInstant(fromDay, '00:00', tz);
    const end = zonedInstant(shiftDay(toDay, 1), '00:00', tz);
    return {
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      time_zone: tz,
      events: demoMeetings(Date.now(), tz).filter((e) => Date.parse(e.starts_at) < end && Date.parse(e.ends_at) > start),
      blocks: db.blocks
        .filter((b) => VISIBLE_BLOCKS.includes(b.status) && Date.parse(b.starts_at) < end && Date.parse(b.starts_at) >= start - DAY_MS)
        .sort(byStart),
    };
  }

  // ---- planning (mirrors backend/internal/plans) ---------------------------------------------

  private async requestPlan(db: Db, body: Body): Promise<PlanResponse> {
    const planText = typeof body['text'] === 'string' ? body['text'].trim() : '';
    if (planText.length > 4000) throw new ApiError(400, 'text must be at most 4000 characters');
    if (body['ask']) {
      return { plan: await this.propose(db, body['ask'] as PlanArgs, 'form'), narration: '', degraded: false };
    }
    if (body['quick'] === 'fill_today') {
      return { plan: await this.propose(db, { window: 'today', fill: true }, 'quick'), narration: '', degraded: false };
    }
    if (!planText) throw new ApiError(400, 'send text, ask or quick');
    if (!db.settings.assistantEnabled) {
      const args = { window: this.afterHours(db) ? 'tomorrow' : 'today', total_blocks: 3 } as PlanArgs;
      return {
        plan: await this.propose(db, args, 'form', planText),
        narration: '',
        degraded: true,
        notice: "The planning assistant is off in your settings, so this plan uses the form's defaults.",
      };
    }
    const plan = await this.propose(db, phraseMatch(planText), 'assistant', planText);
    const blocks = plan.blocks.length;
    const unplaced = plan.unplaced?.length ?? 0;
    const narration =
      `Planned ${blocks} focus ${blocks === 1 ? 'block' : 'blocks'}.` +
      (unplaced ? ` ${unplaced} task(s) didn't fully fit.` : '') +
      ' (This demo reads your request with a simple phrase matcher, not the AI model.)';
    plan.rationale = narration;
    this.plan(db, plan.id).rationale = narration;
    db.assistantTurns++;
    this.write(db);
    return { plan, narration, degraded: false };
  }

  private afterHours(db: Db): boolean {
    const tz = db.settings.timeZone;
    return Date.now() + 3_600_000 > zonedInstant(dayIn(Date.now(), tz), db.settings.workdayEnd, tz);
  }

  private async propose(db: Db, args: LocalArgs, source: PlanView['source'], request = ''): Promise<PlanView> {
    const modes = this.modes(db);
    this.validate(db, args, modes);
    const input = this.buildInput(db, args, modes, []);
    const started = performance.now();
    const result = await this.planner.plan(input);
    db.plannerMicros = [...db.plannerMicros.slice(-199), Math.round((performance.now() - started) * 1000)];

    // One live proposal at a time: asking again replaces the one on screen.
    for (const stale of db.plans.filter((p) => p.status === 'proposed')) {
      stale.status = 'superseded';
      for (const b of db.blocks.filter((x) => x.plan_id === stale.id && x.status === 'proposed')) {
        b.status = 'rejected';
        b.note = 'superseded by a newer plan';
      }
    }
    const window = this.resolve(db, args);
    const tz = db.settings.timeZone;
    const now = new Date().toISOString();
    const plan: StoredPlan = {
      id: db.nextId++,
      status: 'proposed',
      source,
      window_start: new Date(zonedInstant(window.from, '00:00', tz)).toISOString(),
      window_end: new Date(zonedInstant(shiftDay(window.to, 1), '00:00', tz)).toISOString(),
      request: request.slice(0, 500),
      rationale: '',
      unplaced: (result.unplaced ?? null) as PlanView['unplaced'],
      notes: result.notes,
      created_at: now,
      allow_evening: !!args.allow_evening,
      allow_weekend: !!args.allow_weekend,
    };
    db.plans.push(plan);
    for (const b of result.blocks ?? []) {
      db.blocks.push({
        id: db.nextId++,
        plan_id: plan.id,
        task_id: b.task_id,
        new_task: b.task_id === null && b.task !== '',
        session_id: null,
        mode: b.mode,
        starts_at: new Date(b.starts_at).toISOString(),
        focus_min: b.focus_min,
        rest_min: b.rest_min,
        intention: b.task.slice(0, 140),
        status: 'proposed',
        explain: b.explain.slice(0, 300),
        score: b.score,
        note: '',
        created_at: now,
      });
    }
    this.write(db);
    this.publish({ type: 'plan.proposed', data: { plan_id: plan.id } });
    return this.view(db, plan);
  }

  private validate(db: Db, args: LocalArgs, modes: PlannerMode[]): void {
    const fail = (field: string, message: string): never => {
      throw new ApiError(400, `${field} ${message}`, { field });
    };
    if (!WINDOWS.includes(args.window)) fail('window', `must be one of ${WINDOWS.join(', ')}`);
    if (args.window === 'custom' && !args.start_date) fail('start_date', 'is required when window is custom (YYYY-MM-DD)');
    this.resolve(db, args);
    for (const key of ['total_blocks', 'blocks_per_task'] as const) {
      const n = args[key] ?? 0;
      if (n < 0 || n > 12) fail(key, 'must be between 1 and 12');
    }
    for (const key of ['avoid_before', 'avoid_after'] as const) {
      if (args[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(args[key])) {
        fail(key, "must be an HH:MM time in the user's zone, e.g. 13:30");
      }
    }
    if (args.avoid_before && args.avoid_after && args.avoid_after <= args.avoid_before) {
      fail('avoid_after', 'must be later than avoid_before');
    }
    const hint = args.mode_hint?.trim().toLowerCase();
    if (hint && hint !== 'deep' && hint !== 'short' && !modes.some((m) => m.name.toLowerCase() === hint)) {
      fail('mode_hint', `must be one of: deep, short, ${modes.map((m) => m.name).join(', ')}`);
    }
    if ((args.new_tasks?.length ?? 0) > 5) fail('new_tasks', 'at most 5 new tasks per request');
    for (const title of args.new_tasks ?? []) {
      if (!title.trim() || [...title.trim()].length > 120) fail('new_tasks', 'each title must be 1 to 120 characters');
    }
    for (const id of args.task_ids ?? []) {
      if (!db.tasks.some((t) => t.id === id && !t.done)) fail('task_ids', `task ${id} is not one of your open tasks`);
    }
  }

  /** Turns a named window into local days, as plans.Args.Resolve. */
  private resolve(db: Db, args: LocalArgs): { from: string; to: string } {
    const today = dayIn(Date.now(), db.settings.timeZone);
    const weekday = weekdayOf(today);
    switch (args.window) {
      case 'today':
        return { from: today, to: today };
      case 'tomorrow':
        return { from: shiftDay(today, 1), to: shiftDay(today, 1) };
      case 'this_week':
        return { from: today, to: shiftDay(today, (7 - weekday) % 7) }; // through Sunday
      case 'next_week': {
        const monday = shiftDay(today, (8 - weekday) % 7 || 7);
        return { from: monday, to: shiftDay(monday, 6) };
      }
      case 'custom': {
        const fail = (field: string, message: string): never => {
          throw new ApiError(400, `${field} ${message}`, { field });
        };
        const start = args.start_date ?? '';
        const end = args.end_date || start;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('start_date', 'must be a YYYY-MM-DD date');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) fail('end_date', 'must be a YYYY-MM-DD date');
        if (end < start) fail('end_date', 'must not be before start_date');
        if (end < today) fail('end_date', `is in the past (today is ${today}); plans can only cover today onward`);
        if (start > shiftDay(today, 60)) fail('start_date', 'is more than 60 days ahead');
        if (end >= shiftDay(start, 14)) fail('end_date', 'a plan covers at most 14 days');
        return { from: start < today ? today : start, to: end };
      }
    }
    throw new ApiError(400, `window must be one of ${WINDOWS.join(', ')}`, { field: 'window' });
  }

  /** The user's rhythms, the one they've finished most lately first: the default when nothing is asked. */
  private modes(db: Db): PlannerMode[] {
    const modes = [...BUILTIN_MODES];
    for (const p of db.presets) {
      if (!modes.some((m) => m.name.toLowerCase() === p.name.toLowerCase())) {
        modes.push({ name: p.name, focus_min: p.focus, rest_min: p.rest });
      }
    }
    const since = Date.now() - HISTORY_DAYS * DAY_MS;
    const used = new Map<string, number>();
    for (const s of db.sessions) {
      if (Date.parse(s.created_at) > since) used.set(s.mode, (used.get(s.mode) ?? 0) + 1);
    }
    const ranked = [...used].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [name] of ranked) {
      const i = modes.findIndex((m) => m.name === name);
      if (i >= 0) {
        modes.unshift(...modes.splice(i, 1));
        break;
      }
    }
    return modes;
  }

  /** Everything the planner needs for a request, as plans.BuildInput. The JSON is planner.Input's. */
  private buildInput(db: Db, args: LocalArgs, modes: PlannerMode[], exclude: number[]) {
    const tz = db.settings.timeZone;
    const s = db.settings;
    const now = Date.now();
    const window = this.resolve(db, args);
    const start = zonedInstant(window.from, '00:00', tz);
    const end = zonedInstant(shiftDay(window.to, 1), '00:00', tz);
    const hours = Array.from({ length: 24 }, () => ({ sessions: 0, completed: 0 }));
    for (const session of db.sessions) {
      if (Date.parse(session.created_at) <= now - HISTORY_DAYS * DAY_MS) continue;
      const hour = hours[wallTime(session.created_at, tz).hour];
      hour.sessions++;
      if (session.completed) hour.completed++;
    }
    const taskIds = [...new Set(args.task_ids ?? [])].sort((a, b) => a - b);
    const open = db.tasks.filter((t) => !t.done).sort((a, b) => a.id - b.id);
    const tasks: unknown[] = open.map((t) => {
      const brews = db.sessions.filter((x) => x.task_id === t.id && x.completed).length;
      const ahead = db.blocks.filter((b) => b.task_id === t.id && LIVE_BLOCKS.includes(b.status) && Date.parse(b.starts_at) > now).length;
      return {
        id: t.id,
        title: t.title,
        remaining: Math.max(0, t.estimate - brews - ahead),
        ...(t.due_at ? { due_at: t.due_at } : {}),
        ...(t.priority ? { priority: t.priority } : {}),
        ...(t.energy ? { energy: t.energy } : {}),
      };
    });
    for (const raw of args.new_tasks ?? []) {
      const title = raw.trim();
      const existing = open.find((t) => t.title.toLowerCase() === title.toLowerCase());
      if (existing) taskIds.push(existing.id); // they meant the existing one
      else tasks.push({ id: 0, title, remaining: 0 }); // created only if they accept
    }
    return {
      zone: tz,
      now: new Date(now).toISOString(),
      window,
      busy: demoMeetings(now, tz)
        .filter((e) => Date.parse(e.starts_at) < end + DAY_MS && Date.parse(e.ends_at) > start - DAY_MS)
        .map((e) => ({ start: e.starts_at, end: e.ends_at, ...(e.all_day ? { all_day: true } : {}), ...(e.busy ? {} : { free: true }) })),
      booked: db.blocks
        .filter((b) => LIVE_BLOCKS.includes(b.status) && !exclude.includes(b.id))
        .filter((b) => Date.parse(b.starts_at) < end + DAY_MS && Date.parse(b.starts_at) >= start - DAY_MS)
        .sort(byStart)
        .map(booked),
      tasks,
      prefs: {
        workday_start: s.workdayStart,
        workday_end: s.workdayEnd,
        buffer_min: s.bufferMin,
        min_gap_min: s.minGapMin,
        max_blocks_per_day: s.maxBlocksPerDay,
        max_focus_min_per_day: s.maxFocusMinPerDay,
        protect_lunch: s.protectLunch,
      },
      modes,
      request: {
        ...(taskIds.length ? { task_ids: taskIds } : {}),
        ...(args.total_blocks ? { total_blocks: args.total_blocks } : {}),
        ...(args.blocks_per_task ? { blocks_per_task: args.blocks_per_task } : {}),
        ...(args.mode_hint?.trim() ? { mode_hint: args.mode_hint.trim() } : {}),
        ...(args.allow_evening ? { allow_evening: true } : {}),
        ...(args.allow_weekend ? { allow_weekend: true } : {}),
        ...(args.avoid_before ? { avoid_before: args.avoid_before } : {}),
        ...(args.avoid_after ? { avoid_after: args.avoid_after } : {}),
        ...(args.fill ? { fill: true } : {}),
      },
      history: { hours },
    };
  }

  private plan(db: Db, id: number): StoredPlan {
    const plan = db.plans.find((p) => p.id === id);
    if (!plan) throw new ApiError(404, 'not found');
    return plan;
  }

  private view(db: Db, plan: StoredPlan): PlanView {
    const { allow_evening: _evening, allow_weekend: _weekend, ...rest } = plan;
    return { ...rest, blocks: db.blocks.filter((b) => b.plan_id === plan.id).sort(byStart) };
  }

  /** Checks a block at a start time against the planner's own rules, as plans.checkSlot. */
  private async checkSlot(db: Db, plan: StoredPlan, block: ScheduledBlock, startsAt: string, mode: PlannerMode, extra: ScheduledBlock[]): Promise<void> {
    const tz = db.settings.timeZone;
    const day = dayIn(startsAt, tz);
    if (day < dayIn(Date.now(), tz)) {
      throw new ApiError(409, "that's in the past", { code: 'too_soon', block_id: block.id });
    }
    const args = { window: 'custom', start_date: day, allow_evening: plan.allow_evening, allow_weekend: plan.allow_weekend } as PlanArgs;
    const input = this.buildInput(db, args, [mode], [block.id]);
    input.booked.push(...extra.map(booked));
    const violation = await this.planner.check(input, startsAt, mode);
    if (violation.code) {
      throw new ApiError(409, this.describe(db, violation), { code: violation.code, block_id: block.id });
    }
  }

  private describe(db: Db, v: PlannerViolation): string {
    const s = db.settings;
    const hm = (t?: string) => (t ? formatTime(t, s.timeZone) : '');
    switch (v.code) {
      case 'too_soon':
        return "that's too soon: a block needs at least 5 minutes' notice";
      case 'off_grid':
        return 'blocks start on the quarter hour';
      case 'weekend':
        return "that's a weekend, and this plan doesn't include weekends";
      case 'outside_workday':
        return v.at ? `that runs outside your day (${hm(v.at)}–${hm(v.end)})` : "that's outside the days this plan covers";
      case 'lunch':
        return `that overlaps your protected lunch (${hm(v.at)}–${hm(v.end)})`;
      case 'meeting': {
        const hit = demoMeetings(Date.now(), s.timeZone).find(
          (e) => e.busy && !e.all_day && v.at && v.end && Date.parse(e.starts_at) < Date.parse(v.end) && Date.parse(e.ends_at) > Date.parse(v.at),
        );
        return `that overlaps ${hit?.title ?? 'a meeting'} (${hm(v.at)}–${hm(v.end)}) or its ${s.bufferMin}-minute buffer`;
      }
      case 'too_close':
        return `that's too close to another focus block (${hm(v.at)}–${hm(v.end)})`;
      case 'day_cap':
        return `that day is already at your cap of ${s.maxBlocksPerDay} blocks or ${s.maxFocusMinPerDay} focus minutes`;
    }
    return 'that slot breaks one of your planning limits';
  }

  private async accept(db: Db, id: number, body: Body): Promise<PlanView> {
    const plan = this.plan(db, id);
    if (plan.status !== 'proposed') throw new ApiError(409, NOT_PROPOSED);
    const open = db.blocks.filter((b) => b.plan_id === id && b.status === 'proposed').sort(byStart);
    const ids = Array.isArray(body['block_ids']) ? (body['block_ids'] as number[]) : [];
    const chosen = ids.length ? open.filter((b) => ids.includes(b.id)) : open;
    for (const blockId of ids) {
      if (!open.some((b) => b.id === blockId)) {
        throw new ApiError(400, `block_ids block ${blockId} is not an open block of this plan`, { field: 'block_ids' });
      }
    }
    if (!chosen.length) throw new ApiError(400, 'block_ids pick at least one block to accept', { field: 'block_ids' });
    const okSoFar: ScheduledBlock[] = [];
    for (const b of chosen) {
      await this.checkSlot(db, plan, b, b.starts_at, modeOf(b), okSoFar);
      okSoFar.push(b);
    }
    let createdTasks = false;
    for (const b of chosen) {
      if (b.new_task) {
        const title = b.intention;
        let task = db.tasks.find((t) => !t.done && t.title.toLowerCase() === title.toLowerCase());
        if (!task) {
          const count = chosen.filter((x) => x.intention === title).length;
          task = { id: db.nextId++, title, estimate: clamp(count, 1, 20), done: false, due_at: null, priority: 0, energy: '' };
          db.tasks.push(task);
          createdTasks = true;
        }
        b.task_id = task.id;
        b.new_task = false;
      }
      b.status = 'accepted';
    }
    for (const b of open.filter((x) => x.status === 'proposed')) {
      b.status = 'rejected';
      b.note = 'not picked';
    }
    plan.status = 'accepted';
    this.write(db);
    this.publish({ type: 'plan.accepted', data: { plan_id: id, block_ids: chosen.map((b) => b.id) } });
    if (createdTasks) this.publish({ type: 'changed', data: { kind: 'tasks' } });
    this.dispatch();
    return this.view(db, plan);
  }

  private reject(db: Db, id: number): PlanView {
    const plan = this.plan(db, id);
    if (plan.status !== 'proposed') throw new ApiError(409, NOT_PROPOSED);
    for (const b of db.blocks.filter((x) => x.plan_id === id && x.status === 'proposed')) {
      b.status = 'rejected';
      b.note = 'plan rejected';
    }
    plan.status = 'rejected';
    this.write(db);
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
    return this.view(db, plan);
  }

  private block(db: Db, id: number): ScheduledBlock {
    const block = db.blocks.find((b) => b.id === id);
    if (!block) throw new ApiError(404, 'not found');
    return block;
  }

  private async move(db: Db, id: number, body: Body): Promise<ScheduledBlock> {
    const block = this.block(db, id);
    const startsAt = typeof body['starts_at'] === 'string' ? body['starts_at'] : '';
    if (!startsAt || Number.isNaN(Date.parse(startsAt))) throw new ApiError(400, 'starts_at is required');
    if (!MOVABLE.includes(block.status)) {
      throw new ApiError(409, "a block that has started or ended can't be moved", { code: 'not_movable', block_id: id });
    }
    const plan = this.plan(db, block.plan_id);
    if (block.status === 'proposed' && plan.status !== 'proposed') throw new ApiError(409, NOT_PROPOSED);
    let mode = modeOf(block);
    if (typeof body['mode'] === 'string' && body['mode']) {
      const name = body['mode'].toLowerCase();
      const found = this.modes(db).find((m) => m.name.toLowerCase() === name);
      if (!found) throw new ApiError(400, 'mode is not one of your rhythms', { field: 'mode' });
      mode = found;
    }
    // A proposed block must also keep clear of the other blocks in its proposal.
    const siblings = block.status === 'proposed' ? db.blocks.filter((b) => b.plan_id === plan.id && b.status === 'proposed' && b.id !== id) : [];
    const iso = new Date(startsAt).toISOString();
    await this.checkSlot(db, plan, block, iso, mode, siblings);
    Object.assign(block, { starts_at: iso, mode: mode.name, focus_min: mode.focus_min, rest_min: mode.rest_min });
    this.warned.delete(id);
    this.write(db);
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
    this.dispatch();
    return block;
  }

  private drop(db: Db, id: number): undefined {
    const block = this.block(db, id);
    if (block.status === 'proposed') {
      block.status = 'rejected';
      block.note = 'removed from the proposal';
    } else if (block.status === 'accepted' || block.status === 'conflicted') {
      block.status = 'skipped';
      block.note = 'skipped';
    } else {
      throw new ApiError(409, "a block that has started or ended can't be dropped", { code: 'not_droppable', block_id: id });
    }
    this.write(db);
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
    this.dispatch();
    return undefined;
  }

  private startBlock(db: Db, id: number): TimerState {
    const block = this.block(db, id);
    if (block.status !== 'accepted') throw new ApiError(409, 'only an accepted block can be started');
    return this.beginBlock(db, block);
  }

  private beginBlock(db: Db, block: ScheduledBlock): TimerState {
    this.ensureIdle(db);
    db.timer = {
      ...this.running(block.focus_min * 60_000),
      phase: 'focus',
      session_id: db.nextId++,
      scheduled_id: block.id,
      mode: block.mode,
      intention: block.intention,
      task_id: block.task_id,
      day: dayIn(Date.now(), db.settings.timeZone),
    };
    block.status = 'started';
    block.session_id = db.timer.session_id!;
    const state = this.commit(db, this.snapshot(db.timer));
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
    return state;
  }

  /**
   * The dispatcher (backend/internal/scheduler): warns 60 seconds before an accepted block,
   * then starts it. A block that came due with no tab open is skipped, not started late,
   * for the same reason as on the server: it would land on whatever you're doing now.
   */
  private dispatch(): void {
    clearTimeout(this.dispatchAlarm);
    const pass = () => {
      const db = this.read();
      const now = Date.now();
      let changed = false;
      const accepted = db.blocks.filter((b) => b.status === 'accepted').sort(byStart);
      for (const b of accepted) {
        const at = Date.parse(b.starts_at);
        if (now - at > LATE_MS) {
          b.status = 'skipped';
          b.note = db.timer ? 'missed: it was due while another timer was running' : 'missed: no tab was open when it was due';
          changed = true;
        } else if (at <= now && !db.timer) {
          this.beginBlock(db, b);
        } else if (at > now && at - now <= WARN_MS && !this.warned.has(b.id)) {
          this.warned.add(b.id);
          // Every open tab reaches this on its own, so this one isn't sent to the others.
          this.events.next({
            type: 'scheduled.starting',
            data: { scheduled_id: b.id, starts_at: b.starts_at, intention: b.intention, focus_min: b.focus_min, mode: b.mode },
          });
        }
      }
      if (changed) {
        this.write(db);
        this.publish({ type: 'changed', data: { kind: 'schedule' } });
      }
      const waits = db.blocks
        .filter((b) => b.status === 'accepted')
        .flatMap((b) => [Date.parse(b.starts_at) - now, Date.parse(b.starts_at) - WARN_MS - now])
        .filter((w) => w > 0);
      this.dispatchAlarm = setTimeout(() => this.dispatch(), Math.max(250, Math.min(TICK_MS, ...waits)));
    };
    // One tab at a time, so a block can't start twice.
    if (typeof navigator !== 'undefined' && navigator.locks) void navigator.locks.request(`${LOCAL_DB_KEY}:dispatch`, pass);
    else pass();
  }

  // ---- the timer engine (mirrors backend/internal/engine) ------------------------------

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
          this.settleBlock(db, t, 'skipped', 'cancelled after it started');
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
      this.settleBlock(db, t, 'skipped', 'cancelled after it started');
      announce = { type: 'session.discarded', data: null };
    } else {
      this.settleBlock(db, t, 'done', completed ? '' : 'ended early');
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
        scheduled_id: t.scheduled_id ?? null,
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

  private settleBlock(db: Db, t: ActiveTimer, status: 'done' | 'skipped', note: string): void {
    const block = db.blocks.find((b) => b.id === t.scheduled_id);
    if (!block) return;
    block.status = status;
    block.note = note;
    this.publish({ type: 'changed', data: { kind: 'schedule' } });
  }

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

function seed(): Db {
  const settings = defaultSettings();
  const now = Date.now();
  let id = 1;
  const nextId = () => id++;
  const tasks = demoTasks(now, settings.timeZone, nextId);
  const sessions = demoHistory(now, settings.timeZone, nextId);
  return { nextId: id, settings, presets: [], tasks, sessions, timer: null, plans: [], blocks: [], assistantTurns: 0, plannerMicros: [] };
}

const STUB_COUNT = /\b(one|two|three|four|five|six|[1-9])\s+(?:\w+\s+)?blocks?\b/i;
const STUB_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
const STUB_WINDOWS: [phrase: string, window: PlanArgs['window']][] = [
  ['today', 'today'],
  ['this afternoon', 'today'],
  ['tomorrow', 'tomorrow'],
  ['this week', 'this_week'],
  ['next week', 'next_week'],
];

/**
 * The demo's stand-in for the model, as backend/internal/assistant/stub.go. It isn't a
 * language model: it spots a few phrases and fills in the same arguments the model's tool
 * call would. The scheduler still picks every time.
 */
export function phraseMatch(input: string): PlanArgs {
  const lower = input.toLowerCase();
  const args: PlanArgs = { window: 'tomorrow' };
  for (const [phrase, window] of STUB_WINDOWS) {
    if (lower.includes(phrase)) args.window = window;
  }
  const count = STUB_COUNT.exec(lower);
  if (count) args.total_blocks = STUB_WORDS[count[1]] ?? Number(count[1]);
  if (lower.includes('deep')) args.mode_hint = 'deep';
  return args;
}

const byStart = (a: { starts_at: string; id: number }, b: { starts_at: string; id: number }) =>
  Date.parse(a.starts_at) - Date.parse(b.starts_at) || a.id - b.id;

const modeOf = (b: ScheduledBlock): PlannerMode => ({ name: b.mode, focus_min: b.focus_min, rest_min: b.rest_min });

const booked = (b: ScheduledBlock) => ({
  start: b.starts_at,
  focus_min: b.focus_min,
  rest_min: b.rest_min,
  ...(b.task_id ? { task_id: b.task_id } : {}),
});

const rate = (count: number, of: number): Rate => ({ count, of, rate: of > 0 ? count / of : null });

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const remainingOf = (t: ActiveTimer) =>
  t.status === 'running' ? Math.max(0, Date.parse(t.ends_at!) - Date.now()) : t.remaining_ms;

function inRange(key: string, value: number, lo: number, hi: number): void {
  if (!Number.isInteger(value)) throw new ApiError(400, `${key} has the wrong type`);
  if (value < lo) throw new ApiError(400, `${key} must be at least ${lo}`);
  if (value > hi) throw new ApiError(400, `${key} must be at most ${hi}`);
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

function due(body: Body): string | null {
  const raw = body['due_at'];
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    throw new ApiError(400, 'due_at must be an RFC 3339 time, e.g. 2026-10-30T17:00:00-05:00');
  }
  return new Date(raw).toISOString();
}

function energy(body: Body): Task['energy'] {
  const raw = body['energy'] ?? '';
  if (raw !== 'deep' && raw !== 'light' && raw !== '') throw new ApiError(400, 'energy must be one of: deep light');
  return raw;
}

/** Current and best runs of consecutive active days; today's streak survives until midnight. */
function streaks(active: Set<string>, today: string): [number, number] {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of [...active].sort()) {
    run = prev && shiftDay(prev, 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  let current = 0;
  for (let cursor = active.has(today) ? today : shiftDay(today, -1); active.has(cursor); cursor = shiftDay(cursor, -1)) {
    current++;
  }
  return [current, best];
}
