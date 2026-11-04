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
    <div class="group">
      @if (calendars.info(); as s) {
        @for (a of s.accounts; track a.id) {
          <div class="acct">
            <b>{{ a.external_id }}</b>
            @if (a.sync_error) {
              <p class="err" role="alert">{{ a.sync_error }}</p>
            } @else {
              <p class="muted">{{ a.last_sync_at ? 'Synced ' + (a.last_sync_at | date: 'MMM d, h:mm a') : 'Not synced yet' }}</p>
            }
            <div class="actions">
              <button class="btn btn-sm" (click)="syncNow()" [disabled]="busy()">Sync</button>
              @if (!browserOnly) {
                <button class="btn btn-sm btn-danger" (click)="disconnect(a)" [disabled]="busy()">Disconnect</button>
              }
            </div>
          </div>
        }
        @if (s.configured) {
          <app-connect-calendar-button />
        } @else if (!s.accounts.length) {
          <p class="muted">Not set up yet. Add the Google keys to .env and restart.</p>
        }
      } @else if (calendars.state.error()) {
        <p class="err">Couldn't load your calendars.</p>
      }
      @if (browserOnly) {
        <p class="muted">Sample calendar. Connecting Google needs the full app.</p>
      } @else {
        <label class="setting" title="Copies accepted blocks to a separate Brew Focus calendar">
          <span>Add blocks to Google Calendar</span>
          <input type="checkbox" class="switch" [checked]="brew.settings().writeBack" (change)="flag('writeBack', $event)" />
        </label>
        <label class="setting" title="Off, Claude sees only &quot;Busy&quot;">
          <span>Share meeting titles with Claude</span>
          <input type="checkbox" class="switch" [checked]="brew.settings().shareEventTitles" (change)="flag('shareEventTitles', $event)" />
        </label>
      }
    </div>
  `,
  styles: `
    .group {
      display: grid;
      gap: 14px;
    }
    .acct {
      display: grid;
      gap: 5px;
      padding: 12px;
      font-size: 0.875rem;
      font-weight: 500;
      overflow-wrap: anywhere;
      background: var(--surface-2);
      border-radius: var(--radius-sm);
    }
    .actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    .err {
      font-size: 0.78rem;
      font-weight: 400;
      color: var(--danger);
    }
    .setting {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-size: 0.875rem;
      cursor: pointer;
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
      this.toasts.show('Synced');
    });
    this.calendars.state.reload();
  }

  protected async disconnect(a: CalendarAccount): Promise<void> {
    if (!confirm(`Disconnect ${a.external_id}?`)) return;
    await this.run(async () => {
      await this.api.calendarDisconnect(a.id);
      this.toasts.show('Disconnected');
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
