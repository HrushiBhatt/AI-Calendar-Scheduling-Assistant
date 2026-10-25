import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  CalendarAccounts,
  FocusRequest,
  PlanRequest,
  PlanResponse,
  PlanView,
  ScheduledBlock,
  Preset,
  DaySchedule,
  Session,
  Settings,
  Stats,
  Task,
  TimerAction,
  TimerState,
  User,
} from './models';
import { browserZone, localDay } from './time';

export type TaskPatch = Partial<Pick<Task, 'title' | 'estimate' | 'done' | 'priority' | 'energy'>> & {
  due_at?: string; // RFC 3339, or "" to clear
};

/** Typed client for the Go API. Every call resolves to data or rejects with an HttpErrorResponse. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  // accounts
  me = () => this.get<User>('/api/me');
  login = (email: string, password: string) => this.send<User>('POST', '/api/auth/login', { email, password });
  register = (email: string, password: string, name: string) =>
    this.send<User>('POST', '/api/auth/register', { email, password, name, time_zone: browserZone() });
  logout = () => this.send<void>('POST', '/api/auth/logout');
  saveSettings = (settings: Settings) => this.send<Settings>('PUT', '/api/me/settings', settings);

  // custom modes
  presets = () => this.get<Preset[]>('/api/presets');
  createPreset = (p: Omit<Preset, 'id'>) => this.send<Preset>('POST', '/api/presets', p);
  deletePreset = (id: number) => this.send<void>('DELETE', `/api/presets/${id}`);

  // tasks
  tasks = () => this.get<Task[]>('/api/tasks');
  createTask = (title: string, estimate: number) => this.send<Task>('POST', '/api/tasks', { title, estimate });
  updateTask = (id: number, patch: TaskPatch) => this.send<Task>('PATCH', `/api/tasks/${id}`, patch);
  deleteTask = (id: number) => this.send<void>('DELETE', `/api/tasks/${id}`);

  // the server-run timer
  timer = () => this.get<TimerState>('/api/timer');
  startFocus = (req: FocusRequest) => this.send<TimerState>('POST', '/api/timer/focus', req);
  startBreak = (seconds: number) => this.send<TimerState>('POST', '/api/timer/break', { length: seconds });
  control = (action: TimerAction) => this.send<TimerState>('POST', `/api/timer/${action}`);

  // journal & stats
  sessions = (limit = 30) => this.get<Session[]>(`/api/sessions?limit=${limit}`);
  reflect = (id: number, reflection: string) => this.send<Session>('PATCH', `/api/sessions/${id}`, { reflection });
  clearSessions = () => this.send<void>('DELETE', '/api/sessions');
  stats = () => this.get<Stats>(`/api/stats?today=${localDay()}`);

  // calendars
  calendarAccounts = () => this.get<CalendarAccounts>('/api/calendar/accounts');
  calendarConnect = () => this.get<{ auth_url: string }>('/api/calendar/connect');
  calendarDisconnect = (id: number) => this.send<void>('DELETE', `/api/calendar/accounts/${id}`);
  calendarSync = () => this.send<CalendarAccounts>('POST', '/api/calendar/sync');
  // planning
  requestPlan = (req: PlanRequest) => this.send<PlanResponse>('POST', '/api/assistant/plan', req);
  livePlans = () => this.get<PlanView[]>('/api/plans/live');
  plan = (id: number) => this.get<PlanView>(`/api/plans/${id}`);
  /** Accept all of a proposal, or only the listed blocks. */
  acceptPlan = (id: number, blockIds?: number[]) =>
    this.send<PlanView>('POST', `/api/plans/${id}/accept`, blockIds ? { block_ids: blockIds } : {});
  rejectPlan = (id: number) => this.send<PlanView>('POST', `/api/plans/${id}/reject`);
  /** Move (and optionally re-rhythm) one block. The server re-validates; a 409 says why not. */
  moveBlock = (id: number, startsAt: string, mode?: string) =>
    this.send<ScheduledBlock>('PATCH', `/api/scheduled/${id}`, mode ? { starts_at: startsAt, mode } : { starts_at: startsAt });
  dropBlock = (id: number) => this.send<void>('DELETE', `/api/scheduled/${id}`);
  startBlock = (id: number) => this.send<TimerState>('POST', `/api/scheduled/${id}/start`);

  /** The user's calendar and accepted blocks for local days from..to (inclusive). */
  schedule = (from: string, to = from) => this.get<DaySchedule>(`/api/schedule?from=${from}&to=${to}`);

  private get<T>(url: string): Promise<T> {
    return firstValueFrom(this.http.get<T>(url));
  }

  private send<T>(method: string, url: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.http.request<T>(method, url, { body }));
  }
}

/** The human-readable message from an API error. */
export function errorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) return "Can't reach the Brew Focus server.";
    return err.error?.error ?? `Request failed (${err.status})`;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}
