import type { HttpInterceptorFn } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { LiveEvent } from '../app/core/api/models';

/**
 * What differs between the two builds. Every screen is shared, and talks to /api either way, so
 * these few lines are the whole difference between running on the Go server and on GitHub Pages.
 */
export interface Environment {
  /** The backend runs in this browser (GitHub Pages) instead of on the Go server. */
  browserBackend: boolean;
  /** Extra HTTP interceptors. The Pages build answers /api requests here. */
  interceptors: HttpInterceptorFn[];
  /** Live events from the in-browser backend. Call in an injection context. */
  localEvents?: () => Observable<LiveEvent>;
}
