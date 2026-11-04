import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { environment } from '../../environments/environment';
import { Auth } from '../core/auth';
import { Brew, SettingsTab } from '../core/brew';
import { Settings } from '../core/models';
import { Theme, ThemeChoice } from '../core/theme';
import { browserZone } from '../core/time';
import { Modal } from '../shared/modal';
import { AccountSecurity } from './account-security';
import { CalendarSettings } from './calendar-settings';

type Toggle = 'sound' | 'notify' | 'autoBreak' | 'strict';
type Flag = 'protectLunch' | 'assistantEnabled';
type NumberSetting = 'bufferMin' | 'minGapMin' | 'maxBlocksPerDay' | 'maxFocusMinPerDay';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'planning', label: 'Planning' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'account', label: 'Account' },
];

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const TOGGLES: { key: Toggle; label: string; title: string }[] = [
  { key: 'sound', label: 'Sound', title: 'A chime when time is up' },
  { key: 'notify', label: 'Notifications', title: 'When time is up and this tab is in the background' },
  { key: 'autoBreak', label: 'Auto-start breaks', title: 'Start the break after your reflection' },
  { key: 'strict', label: 'Strict mode', title: 'Log tab switches as distractions, and ask before closing' },
];

const NUMBERS: { key: NumberSetting; label: string; min: number; max: number; unit: string }[] = [
  { key: 'bufferMin', label: 'Meeting buffer', min: 0, max: 60, unit: 'min' },
  { key: 'minGapMin', label: 'Gap between blocks', min: 0, max: 120, unit: 'min' },
  { key: 'maxBlocksPerDay', label: 'Blocks per day', min: 1, max: 12, unit: '' },
  { key: 'maxFocusMinPerDay', label: 'Focus per day', min: 25, max: 720, unit: 'min' },
];

function zones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    return [browserZone()];
  }
}

/** Settings: a panel with one short list per tab, saved as you go. */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal, CalendarSettings, AccountSecurity],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="Settings" sheet (closed)="brew.dialog.set(null)">
      <div class="panel">
        <div class="segmented" role="tablist" aria-label="Settings" [style.--n]="tabs.length" [style.--i]="tabIndex()">
          @for (t of tabs; track t.id) {
            <button role="tab" [attr.aria-selected]="tab() === t.id" (click)="brew.settingsTab.set(t.id)">{{ t.label }}</button>
          }
        </div>

        @for (current of [tab()]; track current) {
          <div class="pane" role="tabpanel">
            @switch (current) {
              @case ('general') {
                <div class="row">
                  <span id="set-theme">Appearance</span>
                  <div class="segmented theme" role="radiogroup" aria-labelledby="set-theme" [style.--n]="themes.length" [style.--i]="themeIndex()">
                    @for (t of themes; track t.id) {
                      <button role="radio" [attr.aria-checked]="theme.choice() === t.id" (click)="theme.set(t.id, $event)">{{ t.label }}</button>
                    }
                  </div>
                </div>
                @for (t of toggles; track t.key) {
                  <label class="row" [title]="t.title">
                    <span>{{ t.label }}</span>
                    <input type="checkbox" class="switch" [checked]="brew.settings()[t.key]" (change)="toggle(t.key, $event)" />
                  </label>
                }
                <p class="keys"><kbd>Space</kbd> start or pause <kbd>R</kbd> reset <kbd>S</kbd> finish</p>
              }
              @case ('planning') {
                <label class="row">
                  <span>Time zone</span>
                  <select class="input zone" (change)="text('timeZone', $event)">
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
                    <input class="input" type="time" step="900" aria-label="Workday starts" [value]="brew.settings().workdayStart" (change)="text('workdayStart', $event)" />
                    <input class="input" type="time" step="900" aria-label="Workday ends" [value]="brew.settings().workdayEnd" (change)="text('workdayEnd', $event)" />
                  </span>
                </div>
                @for (n of numbers; track n.key) {
                  <label class="row">
                    <span>{{ n.label }}</span>
                    <span class="pair">
                      <input class="input num" type="number" [min]="n.min" [max]="n.max" [value]="brew.settings()[n.key]" (change)="number(n.key, $event)" />
                      <span class="unit">{{ n.unit }}</span>
                    </span>
                  </label>
                }
                <label class="row" title="Keep 12:00 to 13:00 free">
                  <span>Protect lunch</span>
                  <input type="checkbox" class="switch" [checked]="brew.settings().protectLunch" (change)="flag('protectLunch', $event)" />
                </label>
                <label class="row">
                  <span>{{ browserOnly ? 'Plain-language requests' : 'Plan with Claude' }}</span>
                  <input type="checkbox" class="switch" [checked]="brew.settings().assistantEnabled" (change)="flag('assistantEnabled', $event)" />
                </label>
              }
              @case ('calendar') {
                <app-calendar-settings />
              }
              @case ('account') {
                @if (browserOnly) {
                  <p class="muted">Demo data stays in this browser.</p>
                  <button class="btn btn-sm self" (click)="resetDemo()">Reset the demo</button>
                } @else {
                  <div class="row">
                    <span class="email">{{ auth.user()?.email }}</span>
                    <button class="btn btn-sm" (click)="logout()">Log out</button>
                  </div>
                  <app-account-security />
                }
                <button class="btn btn-sm btn-danger self" (click)="brew.clearData()">Delete all sessions</button>
              }
            }
          </div>
        }
      </div>
    </app-modal>
  `,
  styles: `
    .panel {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 18px;
      height: 100%;
      min-height: 0;
    }
    .pane {
      display: grid;
      align-content: start;
      gap: 16px;
      padding-right: 4px;
      overflow-y: auto;
      animation: rise 0.3s var(--ease-out) both;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 16px;
      min-height: 38px;
      font-size: 0.875rem;
      cursor: default;
    }
    label.row {
      cursor: pointer;
    }
    .theme {
      width: 210px;
    }
    .zone {
      width: auto;
      max-width: 220px;
    }
    .pair {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pair .input {
      width: auto;
    }
    .pair .num {
      width: 72px;
    }
    .unit {
      min-width: 1.8em;
      font-size: 0.75rem;
      color: var(--text-3);
    }
    .email {
      overflow-wrap: anywhere;
      color: var(--text-2);
    }
    .self {
      justify-self: start;
    }
    .keys {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      font-size: 0.75rem;
      color: var(--text-3);
    }
    .keys kbd:not(:first-child) {
      margin-left: 8px;
    }
  `,
})
export class SettingsDialog {
  protected readonly brew = inject(Brew);
  protected readonly auth = inject(Auth);
  protected readonly theme = inject(Theme);
  protected readonly themes = THEMES;
  protected readonly themeIndex = computed(() => THEMES.findIndex((t) => t.id === this.theme.choice()));
  protected readonly tabs = TABS;
  protected readonly toggles = TOGGLES;
  protected readonly numbers = NUMBERS;
  protected readonly zoneList = zones();
  protected readonly browserOnly = environment.browserBackend;
  protected readonly tab = this.brew.settingsTab;
  protected readonly tabIndex = computed(() => TABS.findIndex((t) => t.id === this.tab()));

  protected toggle(key: Toggle, event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }

  protected flag(key: Flag, event: Event): void {
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
