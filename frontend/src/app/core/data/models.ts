/** The shapes of everything the app stores. */

export type TickStyle = 'off' | 'clock' | 'ominous';

/** Preferences. */
export interface Settings {
  sound: boolean;
  notify: boolean;
  autoBreak: boolean;
  strict: boolean; // log tab switches during focus as distractions
  breathe: boolean;
  tick: TickStyle;
}

/** A saved custom timing mode, e.g. "Thesis 75/15". */
export interface Preset {
  id: number;
  name: string;
  focus: number; // minutes
  rest: number; // minutes
}

/** A timing mode: built-in or one of the user's presets. */
export interface Mode {
  key: string;
  name: string;
  focus: number;
  rest: number;
  blurb: string;
  presetId?: number;
}

/** Something to get done, with totals worked out from its sessions. */
export interface Task {
  id: number;
  title: string;
  estimate: number; // planned focus blocks
  done: boolean;
  brews: number; // full focus blocks logged against it
  minutes: number;
}

/** One finished focus block. Breaks aren't stored. */
export interface Session {
  id: number;
  task_id: number | null;
  mode: string;
  planned: number; // seconds
  focused: number; // seconds
  completed: boolean; // ran to zero rather than ended early
  intention: string;
  reflection: string;
  distractions: number;
  day: string; // the local calendar day it started, so streaks follow the user's midnight
  created_at: string;
}

/** The numbers behind the Progress page. */
export interface Stats {
  today: { minutes: number; sessions: number };
  streak: number;
  best_streak: number;
  total: { minutes: number; sessions: number; completed: number };
  heatmap: Record<string, number>; // minutes by day
}

export type Phase = 'focus' | 'break';
type TimerStatus = 'idle' | 'running' | 'paused';
export type TimerAction = 'pause' | 'resume' | 'finish' | 'cancel' | 'distraction';

/** The timer. While running, the time left is worked out from ends_at. */
export interface TimerState {
  phase: Phase;
  status: TimerStatus;
  duration_ms: number;
  remaining_ms: number;
  ends_at?: string;
  session_id?: number;
  mode?: string;
  intention?: string;
  task_id?: number;
}

/** What it takes to start a focus block. */
export interface FocusRequest {
  mode: string;
  planned: number; // seconds
  intention: string;
  task_id: number | null;
  day: string;
}

/** A focus block finished and was logged. */
export interface Completed {
  session: Session;
  unlocked?: string; // café decoration earned
}

/** What the store announces, to this tab and every other open tab. */
export type StoreEvent =
  | { type: 'timer'; data: TimerState }
  | { type: 'session.completed'; data: Completed }
  | { type: 'session.discarded'; data: null }
  | { type: 'break.completed'; data: { completed: boolean } }
  | { type: 'session.reflected'; data: { id: number } }
  | { type: 'changed'; data: { kind: 'presets' | 'tasks' | 'sessions' | 'settings' } };
