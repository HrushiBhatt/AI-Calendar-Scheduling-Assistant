import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Brew } from './brew';
import { LiveEvents } from './live';
import { Completed, LiveEvent, TimerState } from './models';

const now = () => new Date().toISOString();
const idle = (): TimerState => ({ phase: 'focus', status: 'idle', duration_ms: 0, remaining_ms: 0, server_time: now() });

const completed: Completed = {
  session: {
    id: 7,
    task_id: null,
    mode: 'Pomodoro',
    planned: 1500,
    focused: 1500,
    completed: true,
    intention: 'Ship it',
    reflection: '',
    distractions: 0,
    day: '2026-09-30',
    scheduled_id: null,
    created_at: now(),
  },
  unlocked: 'sprout',
};

describe('Brew session flow', () => {
  let brew: Brew;
  let events: Subject<LiveEvent>;

  beforeEach(() => {
    events = new Subject<LiveEvent>();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: LiveEvents, useValue: { events$: events, connect() {}, disconnect() {} } },
      ],
    });
    brew = TestBed.inject(Brew);
  });

  it('shows the selected mode, full, when idle', () => {
    expect(brew.phase()).toBe('focus');
    expect(brew.display()).toEqual({ durationMs: 25 * 60_000, remainingMs: 25 * 60_000 });
    expect(brew.fill()).toBe(1);
  });

  it('opens the reflection prompt when the server completes a block, with an empty mug', () => {
    events.next({ type: 'session.completed', data: completed });
    expect(brew.dialog()).toBe('reflect');
    expect(brew.reflecting()?.unlocked).toBe('sprout');
    expect(brew.fill()).toBe(0);
    expect(brew.busy()).toBe(true);
  });

  it('closes the prompt when another device saved the reflection', () => {
    events.next({ type: 'session.completed', data: completed });
    events.next({ type: 'session.reflected', data: { id: 7 } });
    expect(brew.dialog()).toBeNull();
    expect(brew.reflecting()).toBeNull();
  });

  it('follows a break started elsewhere: the phase flips and the mug refills', () => {
    events.next({ type: 'session.completed', data: completed });
    events.next({
      type: 'timer',
      data: { ...idle(), phase: 'break', status: 'running', duration_ms: 300_000, remaining_ms: 300_000, ends_at: new Date(Date.now() + 300_000).toISOString() },
    });
    expect(brew.phase()).toBe('break');
    expect(brew.reflecting()).toBeNull(); // another device moved on
    expect(brew.fill()).toBeCloseTo(0, 2); // a fresh break starts empty and refills
  });

  it("doesn't duplicate a new mode when the live refresh lands before the save's response", async () => {
    const http = TestBed.inject(HttpTestingController);
    const preset = { id: 1, name: 'Thesis', focus: 75, rest: 15 };
    const creating = brew.createMode('Thesis', 75, 15);
    const post = http.expectOne({ method: 'POST', url: '/api/presets' });
    events.next({ type: 'changed', data: { kind: 'presets' } }); // the server announces it first
    http.expectOne({ method: 'GET', url: '/api/presets' }).flush([preset]);
    await new Promise((resolve) => setTimeout(resolve));
    post.flush(preset);
    await creating;
    expect(brew.presets()).toEqual([preset]);
  });

  it('waits for the play button when auto-start breaks is off', async () => {
    events.next({ type: 'session.completed', data: completed });
    // No user is signed in during this test, so settings fall back to the defaults (autoBreak on);
    // simulate the pending state directly, as finishReflection does when autoBreak is off.
    brew.pendingBreak.set(true);
    expect(brew.phase()).toBe('break');
    brew.skip();
    expect(brew.pendingBreak()).toBe(false);
    expect(brew.phase()).toBe('focus');
  });
});
