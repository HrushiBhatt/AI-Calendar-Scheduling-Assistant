import type { HttpInterceptorFn } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { LiveEvent } from '../app/core/models';

export interface Environment {
  /** The backend runs in this browser (the GitHub Pages demo) instead of on the Go server. */
  browserBackend: boolean;
  /** Extra HTTP interceptors. The Pages build answers /api requests here. */
  interceptors: HttpInterceptorFn[];
  /** Live events from the in-browser backend. Call in an injection context. */
  localEvents?: () => Observable<LiveEvent>;
  /** Puts the demo back to its starting data. */
  resetLocalData?: () => void;
}
