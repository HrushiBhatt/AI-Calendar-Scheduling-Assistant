import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth/auth';

// Pages are lazy-loaded, so the login screen doesn't ship the heatmap. Everything but the
// login page needs an account, so a signed-out visitor always lands on sign-in first.
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./features/login/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./features/brew/brew-page').then((m) => m.BrewPage),
  },
  {
    path: 'progress',
    canActivate: [authGuard],
    loadComponent: () => import('./features/progress/progress-page').then((m) => m.ProgressPage),
  },
  {
    // Where adding Google sign-in lands: reports how it went and moves on to the timer.
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/settings/settings-route').then((m) => m.SettingsRoute),
  },
  { path: '**', redirectTo: '' },
];
