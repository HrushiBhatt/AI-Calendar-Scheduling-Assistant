import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Brew } from '../core/brew';
import { Modal } from '../shared/modal';

/** Before each block: a micro-goal, an optional task, and whether to breathe first. */
@Component({
  selector: 'app-intention-dialog',
  imports: [Modal, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="What's the focus?" (closed)="brew.dialog.set(null)">
      <form class="modal-form" [formGroup]="form" (ngSubmit)="start()">
        <input
          class="input"
          data-autofocus
          formControlName="intention"
          maxlength="140"
          aria-label="Intention"
          [placeholder]="taskTitle() || 'One thing, ' + brew.mode().focus + ' minutes'"
        />
        @if (openTasks().length) {
          <label class="field">
            Task
            <select class="input" formControlName="taskId">
              <option [ngValue]="null">None</option>
              @for (task of openTasks(); track task.id) {
                <option [ngValue]="task.id">{{ task.title }} ({{ task.brews }}/{{ task.estimate }})</option>
              }
            </select>
          </label>
        }
        <label class="check">
          <input type="checkbox" formControlName="breathe" />
          Breathe first
        </label>
        <div class="modal-actions">
          <button class="btn btn-primary">Start</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class IntentionDialog {
  protected readonly brew = inject(Brew);
  protected readonly openTasks = computed(() => this.brew.tasks().filter((t) => !t.done));
  protected readonly form = inject(NonNullableFormBuilder).group({
    intention: ['', Validators.maxLength(140)],
    taskId: this.brew.taskId() as number | null,
    breathe: this.brew.settings().breathe,
  });
  protected readonly taskTitle = computed(
    () => this.brew.tasks().find((t) => t.id === this.brew.taskId())?.title ?? '',
  );

  start(): void {
    const { intention, taskId, breathe } = this.form.getRawValue();
    this.brew.beginFocus(intention.trim(), taskId, breathe);
  }
}
