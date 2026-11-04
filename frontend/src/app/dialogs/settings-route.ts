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

const GOOGLE_OUTCOMES: Record<string, string> = {
  linked: 'Google sign-in is on. You can use it next time you sign in.',
  denied: 'Google sign-in was not added.',
  expired: 'That took too long or came from another session. Try again.',
  in_use: 'That Google account already belongs to another Brew Focus account.',
  already_linked: 'Another Google account is already connected. Remove it first.',
  unverified: "Google hasn't verified that account's email address yet.",
  failed: "Couldn't connect Google. Try again in a moment.",
};

/**
 * /settings: where the calendar and Google sign-in OAuth flows land. Settings is a dialog, not a page, so
 * this opens it, reports how the connection went and moves on to a real page.
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
    if (outcome !== 'connected') inject(Brew).dialog.set('settings');
    void inject(Router).navigate([outcome === 'connected' ? '/plan' : '/'], { replaceUrl: true });
  }
}
