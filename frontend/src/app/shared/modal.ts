import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  booleanAttribute,
  input,
  output,
  viewChild,
} from '@angular/core';
import { Icon } from './icon';

/** A native <dialog>: focus trapping, Esc to close and a backdrop for free. */
@Component({
  selector: 'app-modal',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal" [class.sheet]="sheet()" [attr.aria-label]="title()" (close)="closed.emit()" (click)="onBackdrop($event)">
      <div class="modal-card">
        <header class="modal-header">
          <h2>{{ title() }}</h2>
          <button class="icon-btn" type="button" (click)="closed.emit()" aria-label="Close">
            <app-icon name="close" />
          </button>
        </header>
        <div class="modal-body"><ng-content /></div>
      </div>
    </dialog>
  `,
})
export class Modal {
  readonly title = input.required<string>();
  /** A full-height panel from the side, instead of a card in the middle. */
  readonly sheet = input(false, { transform: booleanAttribute });
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => {
      const el = this.dialog().nativeElement;
      el.showModal();
      el.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    });
  }

  protected onBackdrop(e: MouseEvent): void {
    if (e.target === e.currentTarget) this.closed.emit(); // a click outside the card
  }
}
