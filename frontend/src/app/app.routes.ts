import { Routes } from '@angular/router';

// Pages are lazy-loaded, so opening the timer doesn't download the heatmap.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./features/brew/brew-page').then((m) => m.BrewPage),
  },
  {
    path: 'progress',
    loadComponent: () => import('./features/progress/progress-page').then((m) => m.ProgressPage),
  },
  { path: '**', redirectTo: '' },
];
