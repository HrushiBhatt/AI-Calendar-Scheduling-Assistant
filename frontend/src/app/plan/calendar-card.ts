import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { Brew } from '../core/brew';
import { Calendars } from '../core/calendars';
import { CalendarAccount } from '../core/models';
import { ConnectCalendarButton } from '../shared/connect-calendar-button';

/** The Plan page's first step: connect a calendar, or see the one that's connected. */
@Component({
  selector: 'app-calendar-card',
  imports: [DatePipe, ConnectCalendarButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel px" aria-labelledby="calendar-title">
      <h2 class="panel-title" id="calendar-title">
        Your calendar
        @if (calendars.connected()) {
          <button type="button" class="manage" (click)="brew.dialog.set('settings')">Manage</button>
        }
      </h2>
      @if (browserOnly) {
        <p class="note">This demo plans around a sample calendar. Connecting your Google Calendar needs the full app.</p>
        <app-connect-calendar-button />
      } @else if (calendars.info(); as s) {
        @for (a of s.accounts; track a.id) {
          <div class="acct">
            <b>{{ label(a) }}</b>
            <span class="note">{{ a.external_id }}</span>
            @if (a.sync_error) {
              <p class="err" role="alert">{{ a.sync_error }}</p>
            } @else {
              <span class="note">{{ a.last_sync_at ? 'Synced ' + (a.last_sync_at | date: 'MMM d, h:mm a') : 'Not synced yet' }}</span>
            }
          </div>
        }
        @if (!calendars.connected()) {
          <p class="note">
            Connect your calendar so focus blocks land in the real gaps between your meetings. Access is read-only, plus one separate
            calendar for focus blocks if you turn on write-back in Settings.
          </p>
          <app-connect-calendar-button />
          @if (!s.configured) {
            <p class="note">
              Google Calendar isn't set up on this server yet. Add the Google keys to .env and restart the server (see the README). Until
              then, the planner works around an empty calendar.
            </p>
          }
        }
      } @else if (calendars.state.error()) {
        <p class="err" role="alert">Couldn't load your calendars.</p>
      }
    </section>
  `,
  styles: `
    section {
      display: grid;
      gap: 12px;
    }
    .panel-title {
      margin-bottom: 0;
    }
    .manage {
      font-family: var(--font-main);
      font-size: 0.75rem;
      text-transform: none;
      color: var(--gray-300);
      text-decoration: underline;
    }
    .acct {
      display: grid;
      gap: 2px;
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }
    .note {
      font-size: 0.78rem;
      color: var(--gray-400);
    }
    .err {
      font-size: 0.78rem;
      color: var(--danger);
    }
  `,
})
export class CalendarCard {
  protected readonly calendars = inject(Calendars);
  protected readonly brew = inject(Brew);
  protected readonly browserOnly = environment.browserBackend;

  protected label(a: CalendarAccount): string {
    if (a.provider === 'google') return 'Google Calendar connected';
    return a.provider === 'demo' ? 'Sample calendar' : 'Test calendar connected';
  }
}
