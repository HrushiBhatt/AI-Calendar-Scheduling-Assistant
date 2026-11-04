import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Brew } from '../core/brew';
import { Toasts } from '../core/toast';

const OUTCOMES: Record<string, string> = {
  connected: 'Calendar connected',
  denied: 'Calendar access not granted',
  expired: 'That took too long. Try again.',
  error: "Couldn't connect the calendar",
};

const GOOGLE_OUTCOMES: Record<string, string> = {
  linked: 'Google sign-in on',
  denied: 'Google sign-in not added',
  expired: 'That took too long. Try again.',
  in_use: 'That Google account is already in use',
  already_linked: 'Remove the connected Google account first',
  unverified: "Google hasn't verified that email",
  failed: "Couldn't connect Google",
};

/**
 * /settings: where the calendar and Google sign-in OAuth flows land. Settings is a panel, not a page, so
 * this reports how the connection went, opens the panel if something needs a second look, and moves on.
 */
@Component({
  selector: 'app-settings-route',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class SettingsRoute {
  constructor() {
    const query = inject(ActivatedRoute).snapshot.queryParamMap;
    const toasts = inject(Toasts);
    const outcome = query.get('calendar') ?? '';
    const google = query.get('google') ?? '';
    if (OUTCOMES[outcome]) toasts.show(OUTCOMES[outcome]);
    if (GOOGLE_OUTCOMES[google]) toasts.show(GOOGLE_OUTCOMES[google]);
    if (outcome !== 'connected') {
      const brew = inject(Brew);
      brew.settingsTab.set(outcome ? 'calendar' : 'account');
      brew.dialog.set('settings');
    }
    void inject(Router).navigate([outcome ? '/calendar' : '/'], { replaceUrl: true });
  }
}
