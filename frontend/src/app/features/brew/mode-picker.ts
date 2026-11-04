import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../../core/api/api';
import { Brew } from '../../core/state/brew';
import { ICONS } from '../../shared/pixel-art/sprites';
import { Sprite } from '../../shared/pixel-art/sprite';

/** Choose a timing rhythm (Pomodoro 25/5 and friends), or save your own. */
@Component({
  selector: 'app-mode-picker',
  imports: [ReactiveFormsModule, Sprite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-picker.html',
  styleUrl: './mode-picker.css',
})
export class ModePicker {
  protected readonly brew = inject(Brew);
  protected readonly closeIcon = ICONS['close'];
  protected readonly error = signal('');
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.maxLength(32)]],
    focus: [45, [Validators.required, Validators.min(1), Validators.max(180)]],
    rest: [10, [Validators.required, Validators.min(0), Validators.max(60)]],
  });

  /** Saves a custom mode to the account, then folds the form away. */
  async save(details: HTMLDetailsElement): Promise<void> {
    const { name, focus, rest } = this.form.getRawValue();
    if (this.form.invalid || !name.trim()) {
      this.error.set('Give it a name, 1–180 focus minutes and 0–60 break minutes.');
      return;
    }
    try {
      await this.brew.createMode(name.trim(), focus, rest);
      this.form.reset();
      this.error.set('');
      details.open = false;
    } catch (err) {
      this.error.set(errorMessage(err));
    }
  }
}
