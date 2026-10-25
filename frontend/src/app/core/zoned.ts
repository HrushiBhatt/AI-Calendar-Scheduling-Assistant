/**
 * Wall-clock arithmetic in a named IANA zone, which may differ from the browser's.
 * The planner works in the user's saved zone, so the timeline must draw in it too.
 */

const partsCache = new Map<string, Intl.DateTimeFormat>();
const timeCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const ms = (t: number | string | Date) => (typeof t === 'number' ? t : new Date(t).getTime());

/** What a clock in tz reads at instant t. */
export function wallTime(t: number | string | Date, tz: string): WallTime {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(ms(t))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { year: out['year'], month: out['month'], day: out['day'], hour: out['hour'] % 24, minute: out['minute'], second: out['second'] };
}

/** tz's offset from UTC at instant t, in milliseconds (e.g. -4 h for New York in summer). */
export function offsetMs(t: number, tz: string): number {
  const w = wallTime(t, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(t / 1000) * 1000;
}

/** The instant a clock in tz reads `day` (YYYY-MM-DD) at `time` (HH:MM). */
export function zonedInstant(day: string, time: string, tz: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const asUTC = Date.UTC(y, m - 1, d, hh, mm);
  const guess = asUTC - offsetMs(asUTC, tz);
  return asUTC - offsetMs(guess, tz); // a second pass corrects a guess on the far side of a DST change
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The YYYY-MM-DD day in tz that contains instant t. */
export function dayIn(t: number | string | Date, tz: string): string {
  const w = wallTime(t, tz);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Calendar arithmetic on a YYYY-MM-DD day (no zone involved). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** "14:30" or "2:30 PM", in the browser's locale but tz's wall clock. */
export function formatTime(t: number | string | Date, tz: string): string {
  let f = timeCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    timeCache.set(tz, f);
  }
  return f.format(ms(t));
}

const hourCache = new Map<string, Intl.DateTimeFormat>();

/** "9 AM" or "09", for hour lines. */
export function formatHour(t: number | string | Date, tz: string): string {
  let f = hourCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric' });
    hourCache.set(tz, f);
  }
  return f.format(ms(t));
}

/** "Mon, Oct 26" for a YYYY-MM-DD day. */
export function formatDay(day: string, style: 'short' | 'long' = 'short'): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: style,
    month: style === 'long' ? 'long' : 'short',
    day: 'numeric',
  });
}

/** Whole minutes between two instants. */
export const minutesBetween = (a: number | string, b: number | string) => Math.round((ms(b) - ms(a)) / 60_000);
