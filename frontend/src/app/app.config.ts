import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withViewTransitions } from '@angular/router';
import { environment } from '../environments/environment';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth';
import { markNavigation } from './core/page-transition';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withViewTransitions({ skipInitialTransition: true, onViewTransitionCreated: markNavigation })),
    provideHttpClient(
      withFetch(),
      // The Pages demo adds an interceptor that answers /api in the browser.
      withInterceptors([authInterceptor, ...environment.interceptors]),
    ),
  ],
};
