import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimerState } from '../api/models';
import { Timer } from './timer';

const at = (ms: number) => new Date(ms).toISOString();

function running(serverNow: number, remainingMs: number): TimerState {
  return {
    phase: 'focus',
    status: 'running',
    duration_ms: 1_500_000,
    remaining_ms: remainingMs,
    ends_at: at(serverNow + remainingMs),
    server_time: at(serverNow),
  };
}

describe('Timer', () => {
  let timer: Timer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    timer = TestBed.inject(Timer);
  });

  afterEach(() => vi.useRealTimers());

  it('derives the countdown from the server deadline, corrected for clock skew', () => {
    // The server's clock is 5 s ahead of ours; 60 s remain by its reckoning.
    timer.apply(running(1_005_000, 60_000));
    expect(timer.remainingMs()).toBe(60_000);

    vi.advanceTimersByTime(10_000);
    TestBed.tick();
    expect(timer.remainingMs()).toBe(50_000);
  });

  it('ignores states that arrive out of order', () => {
    timer.apply(running(1_000_000, 60_000));
    timer.apply({ ...running(999_000, 90_000), status: 'paused' });
    expect(timer.state().status).toBe('running');
  });

  it('uses the stored remaining time while paused', () => {
    timer.apply({ ...running(1_000_000, 42_000), status: 'paused', ends_at: undefined });
    vi.advanceTimersByTime(10_000);
    expect(timer.remainingMs()).toBe(42_000);
  });

  it('sends commands to the server and adopts the reply', async () => {
    const http = TestBed.inject(HttpTestingController);
    const pausing = timer.control('pause');
    const req = http.expectOne('/api/timer/pause');
    expect(req.request.method).toBe('POST');
    req.flush({ ...running(1_000_000, 30_000), status: 'paused' });
    await pausing;
    expect(timer.state().status).toBe('paused');
    http.verify();
  });
});
