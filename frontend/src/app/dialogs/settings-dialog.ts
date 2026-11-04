import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { Auth } from '../core/auth';
import { Brew } from '../core/brew';
import { Settings } from '../core/models';
import { browserZone } from '../core/time';
import { Modal } from '../shared/modal';
import { AccountSecurity } from './account-security';
import { CalendarSettings } from './calendar-settings';

type Toggle = 'sound' | 'notify' | 'autoBreak' | 'strict';
type NumberSetting = 'bufferMin' | 'minGapMin' | 'maxBlocksPerDay' | 'maxFocusMinPerDay';

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

const NUMBERS: { key: NumberSetting; label: string; min: number; max: number; unit: string }[] = [
  { key: 'bufferMin', label: 'Buffer around meetings', min: 0, max: 60, unit: 'min' },
  { key: 'minGapMin', label: 'Extra gap between blocks', min: 0, max: 120, unit: 'min' },
  { key: 'maxBlocksPerDay', label: 'Most blocks in a day', min: 1, max: 12, unit: '' },
  { key: 'maxFocusMinPerDay', label: 'Most focus in a day', min: 25, max: 720, unit: 'min' },
];

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [browserZone()];
  }
}

@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, CalendarSettings, AccountSecurity],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="Settings" (closed)="brew.dialog.set(null)">
      <div class="scroll">
        <section class="group" aria-labelledby="set-timer">
          <h3 id="set-timer">Timer</h3>
          @for (t of toggles; track t.key) {
            <label class="setting">
              <span class="setting-label">{{ t.label }}</span>
              <span class="setting-hint">{{ t.hint }}</span>
              <input type="checkbox" class="switch" [checked]="brew.settings()[t.key]" (change)="toggle(t.key, $event)" />
            </label>
          }
        </section>

        <section class="group" aria-labelledby="set-plan">
          <h3 id="set-plan">Planning</h3>
          <p class="setting-hint">The planner never places a block outside these.</p>
          <label class="row">
            <span>Time zone</span>
            <select class="input px" (change)="text('timeZone', $event)">
              @if (!zoneList.includes(brew.settings().timeZone)) {
                <option [value]="brew.settings().timeZone" selected>{{ brew.settings().timeZone || 'Not set' }}</option>
              }
              @for (z of zoneList; track z) {
                <option [value]="z" [selected]="z === brew.settings().timeZone">{{ z }}</option>
              }
            </select>
          </label>
          <div class="row">
            <span>Workday</span>
            <span class="pair">
              <input class="input px" type="time" step="900" aria-label="Workday starts" [value]="brew.settings().workdayStart" (change)="text('workdayStart', $event)" />
              <span aria-hidden="true">to</span>
              <input class="input px" type="time" step="900" aria-label="Workday ends" [value]="brew.settings().workdayEnd" (change)="text('workdayEnd', $event)" />
            </span>
          </div>
          @for (n of numbers; track n.key) {
            <label class="row">
              <span>{{ n.label }}</span>
              <span class="pair">
                <input class="input px num" type="number" [min]="n.min" [max]="n.max" [value]="brew.settings()[n.key]" (change)="number(n.key, $event)" />
                <span class="unit">{{ n.unit }}</span>
              </span>
            </label>
          }
          <label class="setting">
            <span class="setting-label">Protect lunch</span>
            <span class="setting-hint">Keep 12:00 to 13:00 free of focus blocks.</span>
            <input type="checkbox" class="switch" [checked]="brew.settings().protectLunch" (change)="flag('protectLunch', $event)" />
          </label>
          <label class="setting">
            <span class="setting-label">Planning assistant</span>
            <span class="setting-hint">Type requests in plain words. Off, the planner uses the form only.</span>
            <input type="checkbox" class="switch" [checked]="brew.settings().assistantEnabled" (change)="flag('assistantEnabled', $event)" />
          </label>
        </section>

        <app-calendar-settings />

        @if (!browserOnly) {
          <app-account-security />
          <p class="setting-hint">Settings are saved to your account, so they follow you to every device.</p>
        }
        <p class="shortcuts"><kbd>Space</kbd> start / pause · <kbd>R</kbd> reset · <kbd>S</kbd> finish or skip</p>
        @if (browserOnly) {
          <p class="setting-hint">
            This is a demo: everything is saved in this browser, with no account. The full app adds sign-in, Google
            Calendar, the AI assistant and timers that keep running on a server.
          </p>
          <button class="btn btn-sm px" (click)="resetDemo()">Reset the demo</button>
        } @else {
          <div class="account">
            <span>Signed in as <b>{{ auth.user()?.email }}</b></span>
            <button class="btn btn-sm px" (click)="logout()">Log out</button>
          </div>
        }
        <button class="btn btn-danger px" (click)="brew.clearData()">Delete all sessions</button>
      </div>
    </app-modal>
  `,
  styles: `
    .scroll {
      display: grid;
      gap: 20px;
      max-height: calc(100dvh - 160px);
      margin: -6px;
      padding: 6px;
      overflow-y: auto;
    }
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
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 14px;
      font-size: 0.85rem;
      color: var(--gray-300);
    }
    .row select {
      width: auto;
      max-width: 230px;
    }
    .pair {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .pair .input {
      width: auto;
    }
    .num {
      width: 74px !important;
    }
    .unit {
      min-width: 2.2em;
      font-size: 0.75rem;
      color: var(--gray-500);
    }
    .account {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 0.85rem;
      color: var(--gray-300);
    }
  `,
})
export class SettingsDialog {
  protected readonly brew = inject(Brew);
  protected readonly auth = inject(Auth);
  protected readonly toggles = TOGGLES;
  protected readonly numbers = NUMBERS;
  protected readonly zoneList = zones();
  protected readonly browserOnly = environment.browserBackend;

  protected toggle(key: Toggle, event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }

  protected flag(key: 'protectLunch' | 'assistantEnabled', event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }

  protected text(key: 'timeZone' | 'workdayStart' | 'workdayEnd', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    if (value) void this.brew.updateSettings({ [key]: value } as Partial<Settings>);
  }

  protected number(key: NumberSetting, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.valueAsNumber;
    if (Number.isFinite(value)) void this.brew.updateSettings({ [key]: Math.round(value) } as Partial<Settings>);
    else input.value = String(this.brew.settings()[key]);
  }

  protected resetDemo(): void {
    environment.resetLocalData?.();
  }

  protected async logout(): Promise<void> {
    this.brew.dialog.set(null);
    await this.auth.logout();
  }
}
