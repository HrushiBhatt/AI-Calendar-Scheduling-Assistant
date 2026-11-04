import { TestBed } from '@angular/core/testing';
import { STORAGE_KEY } from '../data/store';
import { Timer } from './timer';

describe('Timer', () => {
  let timer: Timer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.removeItem(STORAGE_KEY);
    timer = TestBed.inject(Timer);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(STORAGE_KEY);
  });

  const start = () => timer.startFocus({ mode: 'Pomodoro', planned: 60, intention: '', task_id: null, day: '2026-11-04' });

  it('works out the time left from the deadline', () => {
    start();
    expect(timer.remainingMs()).toBe(60_000);
    vi.advanceTimersByTime(10_000);
    TestBed.tick();
    expect(timer.remainingMs()).toBeGreaterThanOrEqual(50_000);
    expect(timer.remainingMs()).toBeLessThanOrEqual(50_250); // redrawn four times a second
  });

  it('holds still while paused', () => {
    start();
    vi.advanceTimersByTime(18_000);
    timer.control('pause');
    vi.advanceTimersByTime(10_000);
    expect(timer.state().status).toBe('paused');
    expect(timer.remainingMs()).toBe(42_000);
  });

  it('picks up a running timer when the page opens', () => {
    start();
    TestBed.resetTestingModule();
    expect(TestBed.inject(Timer).state().status).toBe('running');
  });
});
