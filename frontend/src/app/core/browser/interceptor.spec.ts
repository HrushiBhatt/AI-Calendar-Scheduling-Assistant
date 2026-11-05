import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { Task, TimerState, User } from '../api/models';
import { browserBackendInterceptor } from './interceptor';
import { STORAGE_KEY } from './store';

describe('browserBackendInterceptor', () => {
  let http: HttpClient;
  const failure = (call: Promise<unknown>) => call.then(() => null, (e: HttpErrorResponse) => e);

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    TestBed.configureTestingModule({ providers: [provideHttpClient(withInterceptors([browserBackendInterceptor]))] });
    http = TestBed.inject(HttpClient);
  });
  afterEach(() => localStorage.removeItem(STORAGE_KEY));

  it('answers the same calls the Go server does, with no password anywhere', async () => {
    const me = await firstValueFrom(http.get<User>('/api/me'));
    expect(me.settings.tick).toBe('off');
    const task = await firstValueFrom(http.post<Task>('/api/tasks', { title: 'Write', estimate: 2 }));
    expect(task).toMatchObject({ title: 'Write', brews: 0 });
    await firstValueFrom(http.patch(`/api/tasks/${task.id}`, { done: true }));
    expect((await firstValueFrom(http.get<Task[]>('/api/tasks')))[0].done).toBe(true);
    const timer = await firstValueFrom(http.post<TimerState>('/api/timer/focus', { mode: 'Pomodoro', planned: 1500, intention: '', task_id: null, day: '2026-11-04' }));
    expect(timer.status).toBe('running');
    expect((await firstValueFrom(http.post<TimerState>('/api/timer/pause', undefined))).status).toBe('paused');
  });

  it('turns mistakes into the same errors the server sends', async () => {
    const bad = await failure(firstValueFrom(http.post('/api/tasks', { title: '  ', estimate: 1 })));
    expect(bad?.status).toBe(400);
    expect(bad?.error.error).toBe('Title is required.');
    expect((await failure(firstValueFrom(http.get('/api/nope'))))?.status).toBe(404);
  });
});
