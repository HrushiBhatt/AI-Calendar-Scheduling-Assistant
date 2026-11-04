import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Calendars } from '../core/calendars';
import { GoogleLogo } from './google-logo';

/**
 * Starts connecting a calendar. Without Google keys it stays visible but disabled, so the
 * feature can be found: the parent says what's missing.
 */
@Component({
  selector: 'app-connect-calendar-button',
  imports: [GoogleLogo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (calendars.info()?.configured && calendars.info()?.provider !== 'google') {
      <button class="btn btn-primary" (click)="calendars.connect()" [disabled]="calendars.busy()">Connect a test calendar</button>
    } @else {
      <button class="gbtn" (click)="calendars.connect()" [disabled]="!calendars.info()?.configured || calendars.busy()">
        <app-google-logo />
        Connect Google Calendar
      </button>
    }
  `,
  styles: `
    :host {
      display: grid;
    }
  `,
})
export class ConnectCalendarButton {
  protected readonly calendars = inject(Calendars);
}
