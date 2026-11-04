import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Brew } from '../../core/state/brew';
import { Toasts } from '../../core/state/toast';

/** What the server's ?google= code means. Only these are ever shown. */
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
 * /settings: where adding Google sign-in lands. Settings is a dialog, not a page, so this
 * reports how it went, reopens the dialog, and moves on to the timer.
 */
@Component({
  selector: 'app-settings-route',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
export class SettingsRoute {
  constructor() {
    const message = GOOGLE_OUTCOMES[inject(ActivatedRoute).snapshot.queryParamMap.get('google') ?? ''];
    if (message) inject(Toasts).show(message);
    inject(Brew).dialog.set('settings');
    void inject(Router).navigate(['/'], { replaceUrl: true });
  }
}
