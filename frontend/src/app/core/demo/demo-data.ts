import { Session, Settings, Task } from '../api/models';
import { localDay } from '../state/time';

/**
 * The GitHub Pages demo's starting data, mirroring backend/internal/demo: a few tasks and a
 * month of finished sessions, generated around today.
 */

export const defaultSettings = (): Settings => ({
  sound: true,
  notify: false,
  autoBreak: true,
  strict: false,
  breathe: true,
  tick: 'off',
});

/** A task as stored: the totals are worked out from the sessions when it's read. */
export type StoredTask = Omit<Task, 'brews' | 'minutes'>;

export function demoTasks(nextId: () => number): StoredTask[] {
  return [
    { id: nextId(), title: 'Compiler project: register allocator', estimate: 4, done: false },
    { id: nextId(), title: 'Write the design doc', estimate: 2, done: false },
    { id: nextId(), title: 'Review open pull requests', estimate: 2, done: false },
    { id: nextId(), title: 'Inbox zero', estimate: 1, done: false },
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

/** A month of weekday sessions, some of them ended early. */
export function demoHistory(now: number, nextId: () => number): Session[] {
  const random = seeded(711);
  const sessions: Session[] = [];
  for (let d = -30; d < 0; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    for (const hour of [9, 10, 11, 14, 15, 16]) {
      if (random() < 0.35) continue; // not every slot gets a session
      const completed = random() < 0.7;
      date.setHours(hour, 0, 0, 0);
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
        day: localDay(date),
        created_at: date.toISOString(),
      });
    }
  }
  return sessions;
}
