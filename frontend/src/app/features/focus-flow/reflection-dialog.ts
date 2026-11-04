import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Brew } from '../../core/state/brew';
import { CAFE } from '../../shared/pixel-art/sprites';
import { Modal } from '../../shared/modal';
import { MinutesPipe } from '../../shared/pipes';
import { Sprite } from '../../shared/pixel-art/sprite';

/** After each block: one sentence for the journal, and any café unlock it earned. */
@Component({
  selector: 'app-reflection-dialog',
  imports: [Modal, ReactiveFormsModule, Sprite, MinutesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (brew.reflecting(); as done) {
      <app-modal [title]="done.session.completed ? 'Brew complete!' : 'Brew ended early'" (closed)="brew.finishReflection('')">
        <p class="summary">
          You focused for <b>{{ round(done.session.focused / 60) | minutes }}</b>
          @if (done.session.intention) {
            on <q>{{ done.session.intention }}</q>
          }.
        </p>
        @if (unlocked(); as item) {
          <div class="unlock px">
            <app-sprite class="unlock-sprite" [rows]="item.rows" [palette]="item.palette" />
            <p>New for your café: <b>{{ item.name }}</b></p>
          </div>
        }
        <form class="modal-form" (submit)="save($event)">
          <label class="field">
            In one sentence, what did you get done?
            <textarea class="input px" data-autofocus rows="2" maxlength="280" [formControl]="note" (keydown.enter)="submitOnEnter($event)"></textarea>
          </label>
          <div class="modal-actions">
            <button type="button" class="btn px" (click)="brew.finishReflection('')">Skip</button>
            <button class="btn btn-primary px">Save to journal</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .summary { line-height: 1.6; color: var(--text-soft); }
    q { color: var(--accent-bright); }
    .unlock {
      --bd: var(--accent);
      display: flex;
      align-items: center;
      gap: 16px;
      margin: 3px;
      padding: 12px 16px;
      background: var(--accent-soft);
      animation: pop 0.4s var(--ease-spring);
    }
    .unlock-sprite { flex: none; width: 44px; height: 44px; }
  `,
})
export class ReflectionDialog {
  protected readonly brew = inject(Brew);
  protected readonly note = new FormControl('', { nonNullable: true, validators: Validators.maxLength(280) });
  protected readonly unlocked = computed(() => CAFE.find((item) => item.id === this.brew.reflecting()?.unlocked));
  protected readonly round = Math.round;

  protected save(e: Event): void {
    e.preventDefault();
    void this.brew.finishReflection(this.note.value.trim());
  }

  /** Enter saves; Shift+Enter adds a line break. */
  protected submitOnEnter(e: Event): void {
    const key = e as KeyboardEvent;
    if (key.shiftKey) return;
    key.preventDefault();
    (key.target as HTMLTextAreaElement).form?.requestSubmit();
  }
}
