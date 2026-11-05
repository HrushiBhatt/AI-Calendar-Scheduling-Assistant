import { inject } from '@angular/core';
import { browserBackendInterceptor } from '../app/core/browser/interceptor';
import { Store } from '../app/core/browser/store';
import type { Environment } from './types';

/**
 * The GitHub Pages build (swapped in by angular.json's "pages" configuration). Pages serves
 * static files only, so it can't run the Go server. Here an in-browser store answers the same
 * /api requests and keeps data in localStorage, with no accounts. Only this build bundles it.
 */
export const environment: Environment = {
  browserBackend: true,
  interceptors: [browserBackendInterceptor],
  localEvents: () => inject(Store).events$,
};
