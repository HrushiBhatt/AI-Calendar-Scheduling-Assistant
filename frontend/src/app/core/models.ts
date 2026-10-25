/** Shapes of the Go API's JSON. */

export type TickStyle = 'off' | 'clock' | 'ominous';

export interface Settings {
  sound: boolean;
  notify: boolean;
  autoBreak: boolean;
  strict: boolean;
  breathe: boolean;
  tick: TickStyle;
  // planning: the scheduler's hard constraints
  timeZone: string; // IANA, e.g. "America/Chicago"
  workdayStart: string; // "09:00"
  workdayEnd: string;
  minGapMin: number;
  bufferMin: number;
  maxBlocksPerDay: number;
  maxFocusMinPerDay: number;
  protectLunch: boolean;
  writeBack: boolean;
  assistantEnabled: boolean;
  shareEventTitles: boolean;
}

export interface User {
  id: number;
  email: string;
  name: string;
  settings: Settings;
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

export type Energy = 'deep' | 'light' | '';

export interface Task {
  id: number;
  title: string;
  estimate: number; // planned focus blocks
  done: boolean;
  due_at: string | null;
  priority: number; // 0 (none) to 3 (urgent)
  energy: Energy;
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
  scheduled_id: number | null;
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

// ---- calendars & planning ------------------------------------------------------------

export interface CalendarAccount {
  id: number;
  provider: string;
  external_id: string; // the account's email
  last_sync_at: string | null;
  sync_error: string;
  created_at: string;
}

export interface CalendarAccounts {
  configured: boolean;
  provider: string;
  accounts: CalendarAccount[];
}

/** A meeting (or other event) from a connected calendar. */
export interface CalendarEvent {
  id: number;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  busy: boolean;
}

export type BlockStatus = 'proposed' | 'accepted' | 'rejected' | 'started' | 'done' | 'skipped' | 'conflicted';

/** One planned focus block. */
export interface ScheduledBlock {
  id: number;
  plan_id: number;
  task_id: number | null;
  new_task: boolean;
  session_id: number | null;
  mode: string;
  starts_at: string;
  focus_min: number;
  rest_min: number;
  intention: string;
  status: BlockStatus;
  explain: string;
  score: number;
  note: string;
  created_at: string;
}

/** GET /api/schedule: one or more of the user's days. */
export interface DaySchedule {
  from: string;
  to: string;
  time_zone: string;
  events: CalendarEvent[];
  blocks: ScheduledBlock[];
}

/** Everything the server pushes over /api/events. */
export type LiveEvent =
  | { type: 'timer'; data: TimerState }
  | { type: 'session.completed'; data: Completed }
  | { type: 'session.discarded'; data: null }
  | { type: 'break.completed'; data: { completed: boolean } }
  | { type: 'session.reflected'; data: { id: number } }
  | { type: 'changed'; data: { kind: 'presets' | 'tasks' | 'sessions' | 'settings' | 'schedule' } }
  | { type: 'calendar.synced'; data: { account_id: number; changed: number } }
  | { type: 'plan.proposed'; data: { plan_id: number } }
  | { type: 'plan.accepted'; data: { plan_id: number; block_ids: number[] } }
  | { type: 'plan.conflict'; data: { plan_id: number; block_ids: number[]; replacement_plan_id: number | null } }
  | { type: 'scheduled.starting'; data: { scheduled_id: number; starts_at: string } };
