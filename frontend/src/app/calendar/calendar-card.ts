import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { Calendars } from '../core/calendars';
import { persistedSignal } from '../core/persisted';
import { ConnectCalendarButton } from '../shared/connect-calendar-button';
import { Icon } from '../shared/icon';

/**
 * Signing in doesn't grant calendar access: that's a separate consent, asked for only when
 * wanted. So this offers it until the user connects or dismisses it, and speaks up again if
 * a connected calendar stops syncing. Settings keeps the full picture.
 */
@Component({
  selector: 'app-calendar-card',
  imports: [ConnectCalendarButton, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (browserOnly) {
      <section class="card">
        <p class="note">Sample calendar. Connecting Google needs the full app.</p>
        <app-connect-calendar-button />
      </section>
    } @else if (syncError(); as error) {
      <section class="card" role="alert">
        <p class="err">{{ error }}</p>
      </section>
    } @else if (show()) {
      <section class="card" aria-labelledby="calendar-title">
        <h2 class="card-title" id="calendar-title">
          Connect your calendar
          <button class="icon-btn dismiss" (click)="dismissed.set(true)" aria-label="Dismiss"><app-icon name="close" style="--icon: 14px" /></button>
        </h2>
        <app-connect-calendar-button />
        @if (!calendars.info()?.configured) {
          <p class="note setup">Not set up yet. Add the Google keys to .env and restart.</p>
        }
      </section>
    } @else if (calendars.state.error()) {
      <section class="card" role="alert">
        <p class="err">Couldn't load your calendars.</p>
      </section>
    }
  `,
  styles: `
    .card {
      display: grid;
      gap: 10px;
      animation: rise 0.45s var(--ease-out) both;
    }
    .card-title {
      margin: 0;
    }
    .dismiss {
      width: 26px;
      height: 26px;
      margin: -4px -4px -4px 0;
    }
    .note {
      font-size: 0.8rem;
      color: var(--text-2);
    }
    .err {
      font-size: 0.8rem;
      color: var(--danger);
    }
  `,
})
export class CalendarCard {
  protected readonly calendars = inject(Calendars);
  protected readonly browserOnly = environment.browserBackend;
  protected readonly dismissed = persistedSignal('brew:calendar-prompt-dismissed', false);

  protected readonly syncError = computed(() => this.calendars.info()?.accounts.find((a) => a.sync_error)?.sync_error ?? '');
  protected readonly show = computed(() => !!this.calendars.info() && !this.calendars.connected() && !this.dismissed());
}
