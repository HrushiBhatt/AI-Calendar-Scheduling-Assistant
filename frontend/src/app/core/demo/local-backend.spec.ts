import { TestBed } from '@angular/core/testing';
import { LiveEvent, Settings, Stats, TimerState } from '../api/models';
import { localDay } from '../state/time';
import { LOCAL_DB_KEY, LocalBackend } from './local-backend';

describe('LocalBackend', () => {
  let backend: LocalBackend;
  let events: LiveEvent[];

  const call = async <T>(method: string, url: string, body?: unknown) => {
    const res = await backend.handle(method, url, body);
    return res as { status: number; body: T };
  };

  beforeEach(() => {
    localStorage.removeItem(LOCAL_DB_KEY);
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
    expect((await call<unknown[]>('GET', '/api/tasks')).body.length).toBe(4);
    expect((await call<Stats>('GET', '/api/stats')).body.total.sessions).toBeGreaterThan(20);
    expect((await call<{ google: boolean }>('GET', '/api/auth/providers')).body.google).toBe(false);
    expect(localStorage.getItem(LOCAL_DB_KEY)).not.toMatch(/password/i);
  });

  it('answers unknown routes and bad input the way the server does', async () => {
    expect((await call('GET', '/api/nope')).status).toBe(404);
    expect((await call('GET', '/api/schedule')).status).toBe(404);
    const bad = await call<{ error: string }>('POST', '/api/tasks', { title: '  ' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('title is required');
    expect((await call('POST', '/api/tasks', { title: 'New' })).status).toBe(201);
    expect((await call('DELETE', '/api/tasks/999')).status).toBe(404);
  });

  it('runs the timer with the same rules as the engine', async () => {
    const focus = { mode: 'Pomodoro', planned: 1500, intention: 'Write', task_id: null, day: localDay() };
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

  it('counts a streak back from today, and yesterday still counts until today ends', async () => {
    const stats = async (today: string) => (await call<Stats>('GET', `/api/stats?today=${today}`)).body;
    const db = JSON.parse(localStorage.getItem(LOCAL_DB_KEY)!);
    const dayOf = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return localDay(d);
    };
    const session = (day: string) => ({ id: 1, task_id: null, mode: 'x', planned: 60, focused: 60, completed: true, intention: '', reflection: '', distractions: 0, day, created_at: '' });
    db.sessions = [session(dayOf(-2)), session(dayOf(-1))];
    localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
    expect((await stats(dayOf(0))).streak).toBe(2);
    expect((await stats(dayOf(1))).streak).toBe(0);
    expect((await stats(dayOf(0))).best_streak).toBe(2);
  });

  it('validates settings as the server does', async () => {
    const { body: me } = await call<{ settings: Settings }>('GET', '/api/me');
    const bad = await call<{ error: string }>('PUT', '/api/me/settings', { ...me.settings, tick: 'loud' });
    expect(bad.status).toBe(400);
    expect((await call('PUT', '/api/me/settings', { ...me.settings, sound: false })).status).toBe(200);
  });
});
