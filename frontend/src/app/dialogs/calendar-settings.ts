import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { Api, errorMessage } from '../core/api';
import { Brew } from '../core/brew';
import { Calendars } from '../core/calendars';
import { CalendarAccount } from '../core/models';
import { Toasts } from '../core/toast';
import { ConnectCalendarButton } from '../shared/connect-calendar-button';

/** The calendar part of the settings dialog. */
@Component({
  selector: 'app-calendar-settings',
  imports: [DatePipe, ConnectCalendarButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="group" aria-labelledby="set-cal">
      <h3 id="set-cal">Calendar</h3>
      @if (calendars.info(); as s) {
        @for (a of s.accounts; track a.id) {
          <div class="acct px">
            <div class="who">
              <b>{{ a.external_id }}</b>
              <span class="setting-hint">{{ a.provider === 'google' ? 'Google' : a.provider }}</span>
            </div>
            @if (a.sync_error) {
              <p class="err" role="alert">{{ a.sync_error }}</p>
            } @else {
              <p class="setting-hint">{{ a.last_sync_at ? 'Synced ' + (a.last_sync_at | date: 'MMM d, h:mm a') : 'Not synced yet' }}</p>
            }
            <div class="actions">
              <button class="btn btn-sm px" (click)="syncNow()" [disabled]="busy()">Sync now</button>
              @if (!browserOnly) {
                <button class="btn btn-sm btn-danger px" (click)="disconnect(a)" [disabled]="busy()">Disconnect</button>
              }
            </div>
          </div>
        } @empty {
          <p class="setting-hint">
            Connect a calendar so the planner can place focus blocks in the real gaps between your meetings. Access is
            read-only, plus one separate calendar for focus blocks if you turn on write-back.
          </p>
        }
        @if (s.configured) {
          <app-connect-calendar-button />
        } @else if (!s.accounts.length) {
          <p class="setting-hint">Google Calendar isn't set up on this server (see the README). The planner still works around an empty calendar.</p>
        }
      } @else if (calendars.state.error()) {
        <p class="err">Couldn't load your calendars.</p>
      }
      @if (browserOnly) {
        <p class="setting-hint">This demo plans around a sample calendar. Connecting Google Calendar needs the full app.</p>
      } @else {
      <label class="setting">
        <span class="setting-label">Write blocks back</span>
        <span class="setting-hint">Copy accepted focus blocks to a "Brew Focus" calendar, so colleagues see you're busy.</span>
        <input type="checkbox" class="switch" [checked]="brew.settings().writeBack" (change)="flag('writeBack', $event)" />
      </label>
      <label class="setting">
        <span class="setting-label">Share meeting titles with the assistant</span>
        <span class="setting-hint">Off, the assistant's model sees only "Busy". The planner works the same either way.</span>
        <input type="checkbox" class="switch" [checked]="brew.settings().shareEventTitles" (change)="flag('shareEventTitles', $event)" />
      </label>
      }
    </section>
  `,
  styles: `
    .group {
      display: grid;
      gap: 14px;
      padding-bottom: 18px;
      border-bottom: 2px dashed var(--gray-700);
    }
    h3 {
      font-family: var(--font-pixel);
      font-size: 0.55rem;
      color: var(--accent);
      text-transform: uppercase;
    }
    .acct {
      display: grid;
      gap: 6px;
      margin: 3px;
      padding: 12px;
      background: var(--gray-850);
    }
    .who {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 6px;
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }
    .actions {
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .err {
      font-size: 0.75rem;
      color: var(--danger);
    }
  `,
})
export class CalendarSettings {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly brew = inject(Brew);
  protected readonly calendars = inject(Calendars);
  protected readonly busy = signal(false);
  protected readonly browserOnly = environment.browserBackend;

  protected async syncNow(): Promise<void> {
    await this.run(async () => {
      await this.api.calendarSync();
      this.toasts.show('Calendar synced.');
    });
    this.calendars.state.reload();
  }

  protected async disconnect(a: CalendarAccount): Promise<void> {
    if (!confirm(`Disconnect ${a.external_id}? Its meetings are removed from Brew Focus and our access is revoked.`)) return;
    await this.run(async () => {
      await this.api.calendarDisconnect(a.id);
      this.toasts.show('Calendar disconnected.');
    });
    this.calendars.state.reload();
  }

  protected flag(key: 'writeBack' | 'shareEventTitles', event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toasts.show(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
