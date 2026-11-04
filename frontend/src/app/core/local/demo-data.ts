import { CalendarEvent, Session, Settings, Task } from '../models';
import { browserZone } from '../time';
import { dayIn, shiftDay, zonedInstant } from '../zoned';

/**
 * The GitHub Pages demo's starting data, mirroring backend/internal/demo: a few tasks, a
 * month of history and two weeks of meetings, generated around today in the visitor's zone.
 */

export const defaultSettings = (): Settings => ({
  sound: true,
  notify: false,
  autoBreak: true,
  strict: false,
  breathe: true,
  tick: 'off',
  timeZone: browserZone(),
  workdayStart: '09:00',
  workdayEnd: '17:00',
  minGapMin: 0,
  bufferMin: 10,
  maxBlocksPerDay: 4,
  maxFocusMinPerDay: 240,
  protectLunch: true,
  writeBack: false,
  assistantEnabled: true,
  shareEventTitles: false,
});

/** Sunday is 0, as in JavaScript and Go. */
export const weekdayOf = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const isWeekend = (day: string) => [0, 6].includes(weekdayOf(day));

export type StoredTask = Omit<Task, 'brews' | 'minutes'>;

export function demoTasks(now: number, tz: string, nextId: () => number): StoredTask[] {
  const due = (days: number) => new Date(zonedInstant(shiftDay(dayIn(now, tz), days), '17:00', tz)).toISOString();
  return [
    { id: nextId(), title: 'Compiler project: register allocator', estimate: 4, done: false, due_at: due(3), priority: 2, energy: 'deep' },
    { id: nextId(), title: 'Write the design doc for sync', estimate: 2, done: false, due_at: due(6), priority: 1, energy: 'deep' },
    { id: nextId(), title: 'Review open pull requests', estimate: 2, done: false, due_at: null, priority: 1, energy: 'light' },
    { id: nextId(), title: 'Inbox zero', estimate: 1, done: false, due_at: null, priority: 0, energy: 'light' },
  ];
}

/** A small seeded generator, so every visitor gets the same believable history. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strong mornings and a weak afternoon slump: the pattern the scheduler's history term should find. */
const COMPLETION_BY_HOUR: Record<number, number> = { 9: 0.9, 10: 0.85, 11: 0.7, 14: 0.45, 15: 0.35, 16: 0.4 };

export function demoHistory(now: number, tz: string, nextId: () => number): Session[] {
  const random = seeded(711);
  const today = dayIn(now, tz);
  const sessions: Session[] = [];
  for (let d = -30; d < 0; d++) {
    const day = shiftDay(today, d);
    if (isWeekend(day)) continue;
    for (const hour of [9, 10, 11, 14, 15, 16]) {
      if (random() < 0.35) continue;
      const completed = random() < COMPLETION_BY_HOUR[hour];
      const start = zonedInstant(day, `${String(hour).padStart(2, '0')}:00`, tz);
      sessions.push({
        id: nextId(),
        task_id: null,
        mode: 'Pomodoro',
        planned: 1500,
        focused: completed ? 1500 : 300 + Math.floor(random() * 900),
        completed,
        intention: '',
        reflection: '',
        distractions: 0,
        day,
        scheduled_id: null,
        created_at: new Date(start).toISOString(),
      });
    }
  }
  return sessions;
}

type Meeting = [title: string, start: string, minutes: number];

const WEEKLY: Record<number, Meeting[]> = {
  1: [['Sprint planning', '13:00', 90], ['1:1 with Sam', '16:00', 30]],
  2: [['Design review', '11:00', 60], ['Interview loop', '14:30', 60]],
  3: [['All hands', '15:00', 60]],
  4: [['Architecture sync', '10:30', 90], ['Customer call', '14:00', 45]],
  5: [['Sprint demo', '15:30', 60]],
};

/** Stable IDs for meetings: they're regenerated around today, not stored. */
const eventId = (day: string, index: number) => Number(day.replaceAll('-', '')) * 10 + index;

/** Three weeks of a plausible calendar around now, in tz. */
export function demoMeetings(now: number, tz: string): CalendarEvent[] {
  const today = dayIn(now, tz);
  const events: CalendarEvent[] = [];
  const add = (day: string, index: number, title: string, start: string, minutes: number, busy = true) => {
    const at = zonedInstant(day, start, tz);
    events.push({
      id: eventId(day, index),
      title,
      starts_at: new Date(at).toISOString(),
      ends_at: new Date(at + minutes * 60_000).toISOString(),
      all_day: false,
      busy,
    });
  };
  for (let d = -2; d < 21; d++) {
    const day = shiftDay(today, d);
    if (isWeekend(day)) continue;
    add(day, 0, 'Team standup', '09:30', 15);
    (WEEKLY[weekdayOf(day)] ?? []).forEach(([title, start, minutes], i) => add(day, i + 1, title, start, minutes));
    if (weekdayOf(day) === 4) add(day, 8, 'Optional: brown bag talk', '12:00', 60, false); // declined, so not busy
  }
  // One all-day event, as context: it doesn't block time.
  const offsite = shiftDay(today, 5);
  events.push({
    id: eventId(offsite, 9),
    title: 'Team offsite (remote)',
    starts_at: new Date(zonedInstant(offsite, '00:00', tz)).toISOString(),
    ends_at: new Date(zonedInstant(shiftDay(offsite, 1), '00:00', tz)).toISOString(),
    all_day: true,
    busy: false,
  });
  return events.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.id - b.id);
}
