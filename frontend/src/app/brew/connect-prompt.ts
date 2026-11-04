import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { Calendars } from '../core/calendars';
import { persistedSignal } from '../core/persisted';
import { ConnectCalendarButton } from '../shared/connect-calendar-button';

/**
 * Signing in lands here, on the timer, but Google sign-in doesn't grant calendar access:
 * that's a separate consent, asked for only when wanted. So this offers it, once a server
 * can actually do it, until the user connects or says not now.
 */
@Component({
  selector: 'app-connect-prompt',
  imports: [ConnectCalendarButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (show()) {
      <aside class="panel px" aria-label="Connect your calendar">
        <p><b>Plan around your real meetings.</b> Connect your calendar and the planner fits focus time into the gaps.</p>
        <div class="actions">
          <app-connect-calendar-button />
          <button class="btn btn-sm px" (click)="dismissed.set(true)">Not now</button>
        </div>
      </aside>
    }
  `,
  styles: `
    aside {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px 24px;
      margin-bottom: 28px;
      font-size: 0.9rem;
      color: var(--gray-300);
    }
    p {
      flex: 1 1 280px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 14px;
    }
  `,
})
export class ConnectPrompt {
  private readonly calendars = inject(Calendars);
  protected readonly dismissed = persistedSignal('brew:calendar-prompt-dismissed', false);
  protected readonly show = computed(
    () => !environment.browserBackend && !!this.calendars.info()?.configured && !this.calendars.connected() && !this.dismissed(),
  );
}
