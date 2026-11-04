import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { Brew } from '../../core/state/brew';
import { Modal } from '../../shared/modal';

const STEPS = ['Breathe in', 'Hold', 'Breathe out', 'Hold'];
const ROUNDS = 2;

/** Box breathing (4-4-4-4) to transition into deep work. The dot traces the box in sync. */
@Component({
  selector: 'app-breathing-dialog',
  imports: [Modal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal title="Breathe" (closed)="brew.launch()">
      <div class="breath">
        <div class="breath-box">
          <div class="breath-fill"></div>
          <span class="breath-dot"></span>
        </div>
        <p class="breath-cue">{{ cue() }}</p>
        <p class="breath-count">{{ 4 - (elapsed() % 4) }}</p>
      </div>
      <div class="modal-actions">
        <button class="btn px" (click)="brew.launch()">Skip to focus</button>
      </div>
    </app-modal>
  `,
  styleUrl: './breathing-dialog.css',
})
export class BreathingDialog {
  protected readonly brew = inject(Brew);
  protected readonly elapsed = signal(0);
  protected readonly cue = computed(() => STEPS[Math.floor(this.elapsed() / 4) % 4]);

  constructor() {
    const id = setInterval(() => this.elapsed.update((s) => s + 1), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
    effect(() => {
      if (this.elapsed() >= ROUNDS * 16) void this.brew.launch();
    });
  }
}
