import { dayIn, firstDayOfWeek, formatDay, monthGrid, shiftDay, shiftMonth, wallTime, weekOf, weekdayOf, zonedInstant } from './zoned';

const NY = 'America/New_York';
const iso = (t: number) => new Date(t).toISOString();

describe('zoned time', () => {
  it('finds wall-clock instants in a zone other than the browser’s', () => {
    expect(iso(zonedInstant('2026-10-26', '09:00', NY))).toBe('2026-10-26T13:00:00.000Z'); // EDT
    expect(iso(zonedInstant('2026-11-02', '09:00', NY))).toBe('2026-11-02T14:00:00.000Z'); // EST
    expect(iso(zonedInstant('2026-10-26', '09:00', 'Asia/Kathmandu'))).toBe('2026-10-26T03:15:00.000Z'); // +5:45
  });

  it('gets DST days right: 23 hours in spring, 25 in autumn', () => {
    const hours = (day: string) => (zonedInstant(shiftDay(day, 1), '00:00', NY) - zonedInstant(day, '00:00', NY)) / 3_600_000;
    expect(hours('2026-03-08')).toBe(23);
    expect(hours('2026-11-01')).toBe(25);
    expect(hours('2026-11-02')).toBe(24);
    // After the spring-forward gap the clock reads 9:00 at 13:00Z, not 14:00Z.
    expect(iso(zonedInstant('2026-03-08', '09:00', NY))).toBe('2026-03-08T13:00:00.000Z');
  });

  it('reads the wall clock and the local day', () => {
    const t = Date.parse('2026-10-27T03:30:00Z'); // 23:30 the evening before, in New York
    expect(wallTime(t, NY)).toEqual({ year: 2026, month: 10, day: 26, hour: 23, minute: 30, second: 0 });
    expect(dayIn(t, NY)).toBe('2026-10-26');
    expect(dayIn(t, 'UTC')).toBe('2026-10-27');
  });

  it('does calendar arithmetic across months and years', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(formatDay('2026-10-26')).toContain('26');
  });
});

describe('calendar ranges', () => {
  it('finds the week around a day, whichever day starts it', () => {
    expect(weekdayOf('2026-11-04')).toBe(3); // a Wednesday
    expect(weekOf('2026-11-04', 0)[0]).toBe('2026-11-01');
    expect(weekOf('2026-11-04', 1)[0]).toBe('2026-11-02');
    expect(weekOf('2026-11-01', 1)[0]).toBe('2026-10-26'); // Sunday is the end of a Monday week
    expect(weekOf('2026-11-04', 0).length).toBe(7);
  });

  it('builds a month grid of whole weeks', () => {
    const nov = monthGrid('2026-11-17', 0); // Nov 1 2026 is a Sunday
    expect(nov[0]).toBe('2026-11-01');
    expect(nov.length).toBe(35);
    expect(nov.at(-1)).toBe('2026-12-05');
    const may = monthGrid('2027-05-10', 0); // starts on a Saturday, so it needs six rows
    expect(may.length).toBe(42);
    expect(may[0]).toBe('2027-04-25');
    expect(monthGrid('2026-02-01', 0).length).toBe(28); // February can fit exactly
  });

  it('never asks the server for more than six weeks', () => {
    for (let m = 1; m <= 12; m++) {
      for (const first of [0, 1, 6]) {
        expect(monthGrid(`2027-${String(m).padStart(2, '0')}-15`, first).length).toBeLessThanOrEqual(42);
      }
    }
  });

  it('steps months, landing on the last day of a shorter one', () => {
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-28');
    expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-15');
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('reads the first day of the week from the locale', () => {
    expect(firstDayOfWeek('en-US')).toBe(0);
    expect(firstDayOfWeek('en-GB')).toBe(1);
    expect(firstDayOfWeek('not a locale')).toBe(0);
  });
});
