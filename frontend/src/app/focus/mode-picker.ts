import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { errorMessage } from '../core/api';
import { Brew } from '../core/brew';
import { Icon } from '../shared/icon';

@Component({
  selector: 'app-mode-picker',
  imports: [ReactiveFormsModule, Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mode-picker.html',
  styleUrl: './mode-picker.css',
})
export class ModePicker {
  protected readonly brew = inject(Brew);
  protected readonly error = signal('');
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.maxLength(32)]],
    focus: [45, [Validators.required, Validators.min(1), Validators.max(180)]],
    rest: [10, [Validators.required, Validators.min(0), Validators.max(60)]],
  });

  async save(details: HTMLDetailsElement): Promise<void> {
    const { name, focus, rest } = this.form.getRawValue();
    if (this.form.invalid || !name.trim()) {
      this.error.set('Name, 1–180 focus, 0–60 break');
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
