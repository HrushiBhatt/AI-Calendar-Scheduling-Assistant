import { HttpErrorResponse, HttpInterceptorFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { of, throwError } from 'rxjs';
import { FocusRequest, Settings, TimerAction } from '../api/models';
import { Store, StoreError } from './store';

/**
 * Answers /api requests in the browser, for the GitHub Pages build. The screens can't tell the
 * difference: they make the same calls they make to the Go server. Only this build includes it.
 */
export const browserBackendInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const store = inject(Store);
  try {
    const body = route(store, req);
    return of(new HttpResponse({ status: body === undefined ? 204 : 200, body: body ?? null, url: req.url }));
  } catch (err) {
    const status = err instanceof NotFound ? 404 : err instanceof StoreError ? 400 : 500;
    const message = err instanceof Error ? err.message : 'something went wrong';
    return throwError(() => new HttpErrorResponse({ status, error: { error: message }, url: req.url }));
  }
};

class NotFound extends Error {
  constructor() {
    super('not found');
  }
}

/** The same routes as backend/internal/api/router.go, minus accounts. */
function route(store: Store, req: HttpRequest<unknown>): unknown {
  const [path, query] = req.url.replace(/^\/api\//, '').split('?');
  const parts = path.split('/');
  const id = Number(parts[1]);
  // The request comes from the app's own Api service, and the store checks every field itself.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (req.body ?? {}) as any;
  switch (`${req.method} ${parts[0]}${parts.length > 1 ? '/' : ''}`) {
    case 'GET me': // there's no account here, but the app still needs its settings
      return { id: 1, email: '', name: '', settings: store.settings() };
    case 'PUT me/':
      return store.saveSettings(body as Settings);
    case 'GET presets':
      return store.presets();
    case 'POST presets':
      return store.createPreset(body);
    case 'DELETE presets/':
      return store.deletePreset(id);
    case 'GET tasks':
      return store.tasks();
    case 'POST tasks':
      return store.createTask(body.title, body.estimate);
    case 'PATCH tasks/':
      return store.setTaskDone(id, body.done);
    case 'DELETE tasks/':
      return store.deleteTask(id);
    case 'GET timer':
      return store.timer();
    case 'POST timer/':
      if (parts[1] === 'focus') return store.startFocus(body as FocusRequest);
      if (parts[1] === 'break') return store.startBreak(body.length);
      return store.control(parts[1] as TimerAction);
    case 'GET sessions':
      return store.sessions(Number(new URLSearchParams(query).get('limit')) || 30);
    case 'PATCH sessions/':
      return store.reflect(id, body.reflection);
    case 'DELETE sessions':
      return store.clearSessions();
    case 'GET stats':
      return store.stats(new URLSearchParams(query).get('today') ?? undefined);
  }
  throw new NotFound();
}
