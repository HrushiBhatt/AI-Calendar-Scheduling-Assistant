import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Brew } from '../core/brew';
import { CAFE } from '../core/sprites';
import { Modal } from '../shared/modal';
import { MinutesPipe } from '../shared/pipes';
import { Sprite } from '../shared/sprite';

/** After each block: one sentence for the journal, and any café unlock it earned. */
@Component({
  selector: 'app-reflection-dialog',
  imports: [Modal, ReactiveFormsModule, Sprite, MinutesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (brew.reflecting(); as done) {
      <app-modal [title]="done.session.completed ? 'Nice work' : 'Ended early'" (closed)="brew.finishReflection('')">
        <p class="summary">
          <b>{{ round(done.session.focused / 60) | minutes }}</b>
          @if (done.session.intention) {
            on <q>{{ done.session.intention }}</q>
          }
        </p>
        @if (unlocked(); as item) {
          <div class="unlock">
            <app-sprite class="unlock-sprite" [rows]="item.rows" [palette]="item.palette" />
            <p>Unlocked: <b>{{ item.name }}</b></p>
          </div>
        }
        <form class="modal-form" (submit)="save($event)">
          <textarea
            class="input"
            data-autofocus
            rows="2"
            maxlength="280"
            aria-label="What got done?"
            placeholder="What got done?"
            [formControl]="note"
            (keydown.enter)="submitOnEnter($event)"
          ></textarea>
          <div class="modal-actions">
            <button type="button" class="btn btn-ghost" (click)="brew.finishReflection('')">Skip</button>
            <button class="btn btn-primary">Save</button>
          </div>
        </form>
      </app-modal>
    }
  `,
  styles: `
    .summary { font-size: 0.95rem; line-height: 1.5; }
    q { color: var(--accent-text); }
    .unlock {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 10px 14px;
      font-size: 0.875rem;
      background: var(--accent-soft);
      border-radius: var(--radius-sm);
      animation: pop 0.5s var(--ease-spring) both;
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
