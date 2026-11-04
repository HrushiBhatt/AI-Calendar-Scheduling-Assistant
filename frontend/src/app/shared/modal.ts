import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  viewChild,
} from '@angular/core';
import { ICONS } from './pixel-art/sprites';
import { Sprite } from './pixel-art/sprite';

/** A native <dialog>: focus trapping, Esc to close and a backdrop for free. */
@Component({
  selector: 'app-modal',
  imports: [Sprite],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal" [attr.aria-label]="title()" (close)="closed.emit()" (click)="onBackdrop($event)">
      <div class="modal-card px">
        <header class="modal-header">
          <h2>{{ title() }}</h2>
          <button class="icon-btn" type="button" (click)="closed.emit()" aria-label="Close">
            <app-sprite class="icon-sm" [rows]="closeIcon" />
          </button>
        </header>
        <div class="modal-body"><ng-content /></div>
      </div>
    </dialog>
  `,
})
export class Modal {
  readonly title = input.required<string>();
  readonly closed = output<void>();

  protected readonly closeIcon = ICONS['close'];
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
