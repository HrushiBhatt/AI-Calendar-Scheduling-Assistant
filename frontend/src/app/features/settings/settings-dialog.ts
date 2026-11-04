import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Brew } from '../../core/state/brew';
import { Settings } from '../../core/data/models';
import { Modal } from '../../shared/modal';

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

/** Preferences, saved as you change them, and the one way to clear your history. */
@Component({
  selector: 'app-settings-dialog',
  imports: [Modal],
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
      <p class="shortcuts"><kbd>Space</kbd> start / pause · <kbd>R</kbd> reset · <kbd>S</kbd> finish or skip</p>
      <p class="setting-hint">Everything stays in this browser and is never sent anywhere. Clearing this site's data deletes it.</p>
      <button class="btn btn-danger px" (click)="brew.clearData()">Delete all sessions</button>
    </app-modal>
  `,
})
export class SettingsDialog {
  protected readonly brew = inject(Brew);
  protected readonly toggles = TOGGLES;

  protected set(key: Toggle, event: Event): void {
    void this.brew.updateSettings({ [key]: (event.target as HTMLInputElement).checked });
  }
}
