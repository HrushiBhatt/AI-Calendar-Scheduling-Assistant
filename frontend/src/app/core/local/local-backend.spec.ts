import { TestBed } from '@angular/core/testing';
import { LiveEvent, PlanResponse, PlanView, ScheduledBlock, Settings, Stats, TimerState } from '../models';
import { dayIn, shiftDay, zonedInstant } from '../zoned';
import { LOCAL_DB_KEY, LocalBackend, phraseMatch } from './local-backend';
import { LocalPlanner, PlannerResult, PlannerViolation } from './planner-wasm';

const TZ = 'America/New_York';

/** Stands in for the WebAssembly planner, which the browser test exercises for real. */
class FakePlanner {
  inputs: Record<string, unknown>[] = [];
  violation: PlannerViolation = { code: '' };
  plan(input: Record<string, unknown>): Promise<PlannerResult> {
    this.inputs.push(input);
    const day = (input['window'] as { from: string }).from;
    const zone = input['zone'] as string;
    const at = (time: string) => new Date(zonedInstant(day, time, zone)).toISOString();
    const block = (time: string, task: string, id: number | null) => ({
      task_id: id, task, starts_at: at(time), focus_min: 25, rest_min: 5, mode: 'Pomodoro', score: 2, explain: 'the earliest open slot that fits',
    });
    return Promise.resolve({
      blocks: [block('10:00', 'Inbox zero', 4), block('10:30', 'Inbox zero', 4), block('11:00', 'Brand new', null)],
      unplaced: [],
      notes: ['placed: 3 blocks'],
    });
  }
  check(): Promise<PlannerViolation> {
    return Promise.resolve(this.violation);
  }
}

describe('LocalBackend', () => {
  let backend: LocalBackend;
  let planner: FakePlanner;
  let events: LiveEvent[];

  const call = async <T>(method: string, url: string, body?: unknown) => {
    const res = await backend.handle(method, url, body);
    return res as { status: number; body: T };
  };
  const tomorrow = () => shiftDay(dayIn(Date.now(), TZ), 1);
  const request = () => call<PlanResponse>('POST', '/api/assistant/plan', { text: 'three blocks tomorrow' });

  beforeEach(() => {
    localStorage.removeItem(LOCAL_DB_KEY);
    planner = new FakePlanner();
    TestBed.configureTestingModule({ providers: [{ provide: LocalPlanner, useValue: planner }] });
    backend = TestBed.inject(LocalBackend);
    events = [];
    backend.events$.subscribe((e) => events.push(e));
  });

  afterEach(() => localStorage.removeItem(LOCAL_DB_KEY));

  it('starts with a sample account, and no password anywhere', async () => {
    const me = await call<{ name: string; has_password: boolean; settings: Settings }>('GET', '/api/me');
    expect(me.status).toBe(200);
    expect(me.body.name).toBe('Demo');
    expect(me.body.has_password).toBe(false);
    expect(me.body.settings.timeZone).toBeTruthy();
    expect((await call<unknown[]>('GET', '/api/tasks')).body.length).toBe(4);
    expect((await call<Stats>('GET', '/api/stats')).body.total.sessions).toBeGreaterThan(20);
    expect((await call<{ google: boolean }>('GET', '/api/auth/providers')).body.google).toBe(false);
    expect(localStorage.getItem(LOCAL_DB_KEY)).not.toMatch(/password/i);
  });

  it('answers unknown routes and bad input the way the server does', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    const bad = await call<{ error: string }>('POST', '/api/tasks', { title: '  ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('title is required');
    expect((await call('POST', '/api/tasks', { title: 'New' })).status).toBe(201);
    expect((await call('DELETE', '/api/tasks/999')).status).toBe(404);
  });

  it('reads the same phrases as the stub assistant', () => {
    expect(phraseMatch('Three deep blocks next week')).toEqual({ window: 'next_week', total_blocks: 3, mode_hint: 'deep' });
    expect(phraseMatch('2 short blocks this afternoon')).toEqual({ window: 'today', total_blocks: 2 });
    expect(phraseMatch('whatever you think')).toEqual({ window: 'tomorrow' });
  });

  it('gives the planner what the server would', async () => {
    await request();
    const input = planner.inputs[0];
    expect(input['window']).toEqual({ from: tomorrow(), to: tomorrow() });
    expect((input['modes'] as { name: string }[])[0].name).toBe('Pomodoro'); // the mode used most lately comes first
    expect((input['history'] as { hours: unknown[] }).hours.length).toBe(24);
    expect((input['tasks'] as unknown[]).length).toBe(4);
    expect((input['prefs'] as { protect_lunch: boolean }).protect_lunch).toBe(true);
    expect(input['request']).toEqual({ total_blocks: 3 });
  });

  it('proposes, says the assistant is a stand-in, and replaces the last proposal', async () => {
    const first = await request();
    expect(first.body.plan?.blocks.length).toBe(3);
    expect(first.body.narration).toContain('phrase matcher');
    expect(first.body.plan?.blocks[2].new_task).toBe(true);
    const second = await request();
    const old = await call<PlanView>('GET', `/api/plans/${first.body.plan!.id}`);
    expect(old.body.status).toBe('superseded');
    const live = await call<PlanView[]>('GET', '/api/plans/live');
    expect(live.body.map((p) => p.id)).toEqual([second.body.plan!.id]);
    expect(events.some((e) => e.type === 'plan.proposed')).toBe(true);
  });

  it('accepts some blocks, rejects the rest and creates named tasks only on acceptance', async () => {
    const plan = (await request()).body.plan!;
    const [a, , c] = plan.blocks;
    const res = await call<PlanView>('POST', `/api/plans/${plan.id}/accept`, { block_ids: [a.id, c.id] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accepted');
    expect(res.body.blocks.map((b) => b.status)).toEqual(['accepted', 'rejected', 'accepted']);
    const tasks = await call<{ title: string }[]>('GET', '/api/tasks');
    expect(tasks.body.some((t) => t.title === 'Brand new')).toBe(true);
    expect((await call('POST', `/api/plans/${plan.id}/accept`)).status).toBe(409);
    const schedule = await call<{ blocks: ScheduledBlock[]; events: unknown[] }>('GET', `/api/schedule?from=${tomorrow()}`);
    expect(schedule.body.blocks.length).toBe(2);
    const insights = await call<{ acceptance: { rate: number }; partial_accept: { count: number } }>('GET', '/api/insights');
    expect(insights.body.partial_accept.count).toBe(1);
    expect(insights.body.acceptance.rate).toBeCloseTo(2 / 3);
  });

  it("refuses a move the scheduler's rules reject, with the reason", async () => {
    const plan = (await request()).body.plan!;
    planner.violation = { code: 'off_grid' };
    const res = await call<{ error: string; code: string }>('PATCH', `/api/scheduled/${plan.blocks[0].id}`, { starts_at: plan.blocks[0].starts_at });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('blocks start on the quarter hour');
    planner.violation = { code: '' };
    const moved = new Date(Date.parse(plan.blocks[0].starts_at) + 3_600_000).toISOString();
    const ok = await call<ScheduledBlock>('PATCH', `/api/scheduled/${plan.blocks[0].id}`, { starts_at: moved });
    expect(ok.status).toBe(200);
    expect(ok.body.starts_at).toBe(moved);
  });

  it('drops blocks, and starts one with Start now', async () => {
    const plan = (await request()).body.plan!;
    await call('POST', `/api/plans/${plan.id}/accept`);
    expect((await call('DELETE', `/api/scheduled/${plan.blocks[0].id}`)).status).toBe(204);
    expect((await call('POST', `/api/scheduled/${plan.blocks[0].id}/start`)).status).toBe(409);
    const started = await call<TimerState>('POST', `/api/scheduled/${plan.blocks[1].id}/start`);
    expect(started.body.status).toBe('running');
    expect(started.body.duration_ms).toBe(25 * 60_000);
    const view = await call<PlanView>('GET', `/api/plans/${plan.id}`);
    expect(view.body.blocks.find((b) => b.id === plan.blocks[1].id)?.status).toBe('started');
    expect((await call('POST', `/api/scheduled/${plan.blocks[2].id}/start`)).status).toBe(409); // a timer is running
    await call('POST', '/api/timer/cancel');
    const after = await call<PlanView>('GET', `/api/plans/${plan.id}`);
    expect(after.body.blocks.find((b) => b.id === plan.blocks[1].id)?.status).toBe('skipped');
  });

  it('runs the timer with the same rules as the engine', async () => {
    const focus = { mode: 'Pomodoro', planned: 1500, intention: 'Write', task_id: null, day: dayIn(Date.now(), TZ) };
    const started = await call<TimerState>('POST', '/api/timer/focus', focus);
    expect(started.body.status).toBe('running');
    expect((await call('POST', '/api/timer/focus', focus)).status).toBe(409);
    expect((await call<TimerState>('POST', '/api/timer/pause')).body.status).toBe('paused');
    expect((await call<TimerState>('POST', '/api/timer/resume')).body.status).toBe('running');
    // Ended under a minute in: nothing is logged.
    const before = (await call<Stats>('GET', '/api/stats')).body.total.sessions;
    await call('POST', '/api/timer/finish');
    expect((await call<Stats>('GET', '/api/stats')).body.total.sessions).toBe(before);
    expect(events.some((e) => e.type === 'session.discarded')).toBe(true);
    expect((await call('POST', '/api/timer/pause')).status).toBe(409);
  });

  it('validates settings as the server does', async () => {
    const { body: me } = await call<{ settings: Settings }>('GET', '/api/me');
    const save = (patch: Partial<Settings>) => call<{ error: string }>('PUT', '/api/me/settings', { ...me.settings, ...patch });
    expect((await save({ timeZone: 'Mars/Olympus' })).body.error).toContain('IANA');
    expect((await save({ workdayEnd: '09:30' })).body.error).toContain('at least an hour');
    expect((await save({ maxBlocksPerDay: 99 })).body.error).toBe('maxBlocksPerDay must be at most 12');
    expect((await save({ timeZone: 'Europe/Berlin' })).status).toBe(200);
  });

  it('turns a failed scheduler load into a message instead of a crash', async () => {
    planner.plan = () => Promise.reject(new Error('offline'));
    const res = await request();
    expect(res.status).toBe(503);
    expect((res.body as unknown as { error: string }).error).toContain("couldn't load");
  });
});
