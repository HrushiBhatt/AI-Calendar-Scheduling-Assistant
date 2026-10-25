import { dayIn, formatDay, shiftDay, wallTime, zonedInstant } from './zoned';

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
