import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth';

// Pages are lazy-loaded, so the login screen doesn't ship the heatmap.
export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () => import('./login/login-page').then((m) => m.LoginPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    loadComponent: () => import('./home/home-page').then((m) => m.HomePage),
  },
  {
    path: 'calendar',
    canActivate: [authGuard],
    loadComponent: () => import('./calendar/calendar-page').then((m) => m.CalendarPage),
  },
  {
    // Where a command to the assistant bar lands.
    path: 'plan',
    canActivate: [authGuard],
    loadComponent: () => import('./calendar/plan-page').then((m) => m.PlanPage),
  },
  {
    path: 'focus',
    canActivate: [authGuard],
    loadComponent: () => import('./focus/focus-page').then((m) => m.FocusPage),
  },
  {
    path: 'progress',
    canActivate: [authGuard],
    loadComponent: () => import('./progress/progress-page').then((m) => m.ProgressPage),
  },
  {
    // Where the OAuth flows land: reports how it went and moves on to a real page.
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () => import('./dialogs/settings-route').then((m) => m.SettingsRoute),
  },
  { path: '**', redirectTo: '' },
];
