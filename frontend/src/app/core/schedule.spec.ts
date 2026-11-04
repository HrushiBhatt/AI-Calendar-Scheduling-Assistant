import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from './auth';
import { LiveEvents } from './live';
import { LiveEvent, User } from './models';
import { Schedule } from './schedule';
import { shiftDay, shiftMonth } from './zoned';

const KEY = 'brew:calendar-view';

function open() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set({ id: 1, settings: { timeZone: 'America/New_York' } } as User);
  return { schedule: TestBed.inject(Schedule), http: TestBed.inject(HttpTestingController) };
}

describe('Schedule', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('shows one, seven or a month of days', () => {
    const { schedule } = open();
    schedule.show('2026-11-04');
    schedule.setView('day');
    expect(schedule.days()).toEqual(['2026-11-04']);
    schedule.setView('week');
    expect(schedule.days().length).toBe(7);
    expect(schedule.days()).toContain('2026-11-04');
    schedule.setView('month');
    expect(schedule.days().length % 7).toBe(0);
    expect(schedule.days()).toContain('2026-11-30');
  });

  it('steps by the size of the view, and remembers which way', () => {
    const { schedule } = open();
    schedule.show('2026-11-04');
    schedule.setView('day');
    schedule.step(1);
    expect(schedule.day()).toBe(shiftDay('2026-11-04', 1));
    expect(schedule.direction()).toBe('next');
    schedule.setView('week');
    schedule.step(-1);
    expect(schedule.day()).toBe(shiftDay('2026-11-05', -7));
    expect(schedule.direction()).toBe('prev');
    schedule.setView('month');
    const before = schedule.day();
    schedule.step(1);
    expect(schedule.day()).toBe(shiftMonth(before, 1));
  });

  it('asks the server for exactly the days on screen', async () => {
    const { schedule, http } = open();
    schedule.show('2026-11-04');
    schedule.setView('week');
    TestBed.tick();
    const days = schedule.days();
    const req = http.expectOne(`/api/schedule?from=${days[0]}&to=${days[6]}`);
    req.flush({ from: '', to: '', time_zone: '', events: [], blocks: [] });
    await TestBed.inject(Schedule).data.value;
  });

  it('keeps the last answer on screen while the next range loads', async () => {
    const { schedule, http } = open();
    schedule.show('2026-11-04');
    schedule.setView('day');
    TestBed.tick();
    http.expectOne('/api/schedule?from=2026-11-04&to=2026-11-04').flush({ from: '', to: 'first', time_zone: '', events: [], blocks: [] });
    await new Promise((r) => setTimeout(r));
    TestBed.tick();
    expect(schedule.shown()?.to).toBe('first');
    schedule.step(1);
    TestBed.tick();
    expect(schedule.shown()?.to).toBe('first'); // the next one hasn't answered yet
  });

  it('opens one day from the week or month', () => {
    const { schedule } = open();
    schedule.setView('month');
    schedule.openDay('2026-11-20');
    expect(schedule.view()).toBe('day');
    expect(schedule.days()).toEqual(['2026-11-20']);
  });
});
