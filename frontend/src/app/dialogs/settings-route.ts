import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Brew } from '../core/brew';
import { Toasts } from '../core/toast';

const OUTCOMES: Record<string, string> = {
  connected: 'Calendar connected. Your meetings are on the timeline.',
  denied: 'Calendar access was not granted.',
  expired: 'That sign-in took too long or came from another session. Try connecting again.',
  error: "Couldn't connect the calendar. Try again in a moment.",
};

/**
 * /settings: where the calendar OAuth flow lands. Settings is a dialog, not a page, so
 * this opens it, reports how the connection went and moves on to a real page.
 */
@Component({
  selector: 'app-settings-route',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class SettingsRoute {
  constructor() {
    const outcome = inject(ActivatedRoute).snapshot.queryParamMap.get('calendar') ?? '';
    if (OUTCOMES[outcome]) inject(Toasts).show(OUTCOMES[outcome]);
    if (outcome !== 'connected') inject(Brew).dialog.set('settings');
    void inject(Router).navigate([outcome === 'connected' ? '/plan' : '/'], { replaceUrl: true });
  }
}
