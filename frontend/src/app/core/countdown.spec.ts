import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Countdown } from './countdown';
import { LiveEvents } from './live';
import { LiveEvent, TimerState } from './models';

describe('Countdown', () => {
  let countdown: Countdown;
  let events: Subject<LiveEvent>;
  let http: HttpTestingController;
  const startsAt = new Date(Date.now() + 45_000).toISOString();
  const starting = { scheduled_id: 9, starts_at: startsAt, intention: 'Compiler project', focus_min: 50, mode: 'Animedoro' };

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
    countdown = TestBed.inject(Countdown);
    http = TestBed.inject(HttpTestingController);
  });

  it('shows the warning with the seconds left', () => {
    events.next({ type: 'scheduled.starting', data: starting });
    expect(countdown.pending()?.scheduled_id).toBe(9);
    expect(countdown.secondsLeft()).toBeGreaterThan(40);
    expect(countdown.secondsLeft()).toBeLessThanOrEqual(45);
  });

  it('goes away when the block starts, here or on another device', () => {
    events.next({ type: 'scheduled.starting', data: starting });
    const running: TimerState = { phase: 'focus', status: 'running', duration_ms: 1, remaining_ms: 1, server_time: new Date().toISOString() };
    events.next({ type: 'timer', data: running });
    expect(countdown.pending()).toBeNull();
  });

  it('delays by ten minutes through the server', async () => {
    events.next({ type: 'scheduled.starting', data: starting });
    const delaying = countdown.delay();
    const req = http.expectOne('/api/scheduled/9');
    expect(req.request.method).toBe('PATCH');
    expect(Date.parse(req.request.body.starts_at) - Date.parse(startsAt)).toBe(10 * 60_000);
    req.flush({});
    await delaying;
    expect(countdown.pending()).toBeNull();
  });

  it('skips by dropping the block, and keeps the warning if that fails', async () => {
    events.next({ type: 'scheduled.starting', data: starting });
    const skipping = countdown.skip();
    http.expectOne({ method: 'DELETE', url: '/api/scheduled/9' }).flush({ error: 'nope' }, { status: 409, statusText: 'Conflict' });
    await skipping;
    expect(countdown.pending()?.scheduled_id).toBe(9);
  });
});
