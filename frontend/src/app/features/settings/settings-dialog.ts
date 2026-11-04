import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { environment } from '../../../environments/environment';
import { Auth } from '../../core/auth/auth';
import { Brew } from '../../core/state/brew';
import { Settings } from '../../core/api/models';
import { Modal } from '../../shared/modal';
import { AccountSecurity } from './account-security';

type Toggle = Exclude<keyof Settings, 'tick'>;

const TOGGLES: { key: Toggle; label: string; hint: string }[] = [
  { key: 'sound', label: 'Sound effects', hint: '8-bit chime when a focus block or break runs out.' },
  { key: 'notify', label: 'Notifications', hint: 'Ping me when time is up and this tab is in the background.' },
  { key: 'autoBreak', label: 'Auto-start breaks', hint: 'Begin the break as soon as you finish your reflection.' },
  {
    key: 'strict',
    label: 'Strict mode',
    hint: 'Log every tab switch mid-focus as a distraction, and ask before closing the tab.',
  },
];

/** Preferences (saved as you change them) and the account. The demo has no account to manage. */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, AccountSecurity],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="Settings" (closed)="brew.dialog.set(null)">
      @for (t of toggles; track t.key) {
        <label class="setting">
          <span class="setting-label">{{ t.label }}</span>
          <span class="setting-hint">{{ t.hint }}</span>
          <input type="checkbox" class="switch" [checked]="brew.settings()[t.key]" (change)="set(t.key, $event)" />
        </label>
      }
      <p class="setting-hint">Settings are saved to your account, so they follow you to every device.</p>
      <p class="shortcuts"><kbd>Space</kbd> start / pause · <kbd>R</kbd> reset · <kbd>S</kbd> finish or skip</p>
      @if (browserOnly) {
        <p class="setting-hint">Demo data stays in this browser.</p>
        <button class="btn btn-sm px" (click)="resetDemo()">Reset the demo</button>
      } @else {
        <div class="account">
          <span>Signed in as <b>{{ auth.user()?.email }}</b></span>
          <button class="btn btn-sm px" (click)="logout()">Log out</button>
        </div>
        <app-account-security />
      }
      <button class="btn btn-danger px" (click)="brew.clearData()">Delete all sessions</button>
    </app-modal>
  `,
  styles: `
    .account {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--text-2);
    }
  `,
})
export class SettingsDialog {
  protected readonly brew = inject(Brew);
  protected readonly auth = inject(Auth);
  protected readonly toggles = TOGGLES;
  protected readonly browserOnly = environment.browserBackend;

  protected set(key: Toggle, event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }

  protected resetDemo(): void {
    environment.resetLocalData?.();
  }

  protected async logout(): Promise<void> {
    this.brew.dialog.set(null);
    await this.auth.logout();
  }
}
