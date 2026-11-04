import { inject } from '@angular/core';
import { LOCAL_DB_KEY, LocalBackend, localBackendInterceptor } from '../app/core/demo/local-backend';
import type { Environment } from './types';

/**
 * The GitHub Pages demo (swapped in by angular.json's "pages" configuration). Pages serves
 * static files only, so an in-browser backend answers /api with sample data. Only this build
 * bundles any of it.
 */
export const environment: Environment = {
  browserBackend: true,
  interceptors: [localBackendInterceptor],
  localEvents: () => inject(LocalBackend).events$,
  resetLocalData: () => {
    try {
      localStorage.removeItem(LOCAL_DB_KEY);
    } catch {
      // Storage is blocked, so the demo's data only lives in memory: reloading clears it.
    }
    location.reload();
  },
};
