import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Brew } from '../core/brew';
import { formatClock } from '../core/time';
import { Icon } from '../shared/icon';
import { PixelMug } from '../shared/pixel-mug';
import { MinutesPipe, PluralPipe } from '../shared/pipes';

@Component({
  selector: 'app-timer-stage',
  imports: [PixelMug, Icon, MinutesPipe, PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timer-stage.html',
  styleUrl: './timer-stage.css',
})
export class TimerStage {
  protected readonly brew = inject(Brew);
  /** Beans thrown from the mug when a session lands: one per angle, as a CSS variable. */
  protected readonly burst = Array.from({ length: 14 }, (_, i) => i * (360 / 14));

  protected readonly status = computed(() => this.brew.timer.state().status);
  protected readonly onBreak = computed(() => this.brew.phase() === 'break');
  protected readonly clock = computed(() => formatClock(this.brew.display().remainingMs / 1000).split(':'));

  protected readonly celebrating = computed(() => !!this.brew.reflecting());

  /** The running block's mode (possibly started on another device), else the selected one. */
  protected readonly modeLabel = computed(() => {
    const running = this.brew.timer.state().mode;
    const m = this.brew.mode();
    return running ?? `${m.name} ${m.focus}/${m.rest}`;
  });

  protected readonly caption = computed(() => {
    if (this.onBreak()) return 'Step away';
    if (this.brew.intention()) return this.brew.intention();
    return this.brew.tasks().find((t) => t.id === this.brew.taskId())?.title ?? '';
  });
}
