/** Shapes of the Go API's JSON. */

export type TickStyle = 'off' | 'clock' | 'ominous';

export interface Settings {
  sound: boolean;
  notify: boolean;
  autoBreak: boolean;
  strict: boolean;
  breathe: boolean;
  tick: TickStyle;
}

export interface User {
  id: number;
  email: string;
  name: string;
  settings: Settings;
  has_password: boolean;
  google_linked: boolean;
}

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

export interface Task {
  id: number;
  title: string;
  estimate: number; // planned focus blocks
  done: boolean;
  brews: number; // full focus blocks logged against it
  minutes: number;
}

export interface Session {
  id: number;
  task_id: number | null;
  mode: string;
  planned: number; // seconds
  focused: number; // seconds
  completed: boolean;
  intention: string;
  reflection: string;
  distractions: number;
  day: string;
  created_at: string;
}

export interface Stats {
  today: { minutes: number; sessions: number };
  streak: number;
  best_streak: number;
  total: { minutes: number; sessions: number; completed: number };
  heatmap: Record<string, number>;
}

export type Phase = 'focus' | 'break';
type TimerStatus = 'idle' | 'running' | 'paused';
export type TimerAction = 'pause' | 'resume' | 'finish' | 'cancel' | 'distraction';

/** The server-run timer. Remaining time is derived from ends_at while running. */
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
  server_time: string;
}

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

/** Everything the server pushes over /api/events. */
export type LiveEvent =
  | { type: 'timer'; data: TimerState }
  | { type: 'session.completed'; data: Completed }
  | { type: 'session.discarded'; data: null }
  | { type: 'break.completed'; data: { completed: boolean } }
  | { type: 'session.reflected'; data: { id: number } }
  | { type: 'changed'; data: { kind: 'presets' | 'tasks' | 'sessions' | 'settings' | 'account' } };
