import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Brew } from '../../core/state/brew';
import { ICONS } from '../../shared/pixel-art/sprites';
import { formatClock } from '../../core/state/time';
import { PixelMug } from '../../shared/pixel-art/pixel-mug';
import { MinutesPipe, PluralPipe } from '../../shared/pipes';
import { Sprite } from '../../shared/pixel-art/sprite';

/** How many blocks the progress bar under the mug is drawn with. */
const SEGMENTS = 24;

/**
 * The timer itself: the mug, whose coffee drains as a block runs, the clock on it, the progress
 * bar and the controls. It only displays: the server runs the timer, through the Brew service.
 */
@Component({
  selector: 'app-timer-stage',
  imports: [PixelMug, Sprite, MinutesPipe, PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timer-stage.html',
  styleUrl: './timer-stage.css',
})
export class TimerStage {
  protected readonly brew = inject(Brew);
  protected readonly icons = ICONS;
  protected readonly segments = Array.from({ length: SEGMENTS }, (_, i) => i);

  protected readonly status = computed(() => this.brew.timer.state().status);
  protected readonly onBreak = computed(() => this.brew.phase() === 'break');
  protected readonly lit = computed(() => Math.round(this.brew.progress() * SEGMENTS));
  protected readonly clock = computed(() => formatClock(this.brew.display().remainingMs / 1000).split(':'));

  /** The word under the clock. */
  protected readonly label = computed(() => {
    if (this.brew.reflecting()) return 'NICE!';
    if (this.status() === 'paused') return 'PAUSED';
    if (this.onBreak()) return 'BREAK';
    return this.status() === 'running' ? 'FOCUS!' : 'READY!';
  });

  /** The running block's mode (possibly started on another device), else the selected one. */
  protected readonly modeLabel = computed(() => {
    const running = this.brew.timer.state().mode;
    const m = this.brew.mode();
    return running ?? `${m.name} · ${m.focus}/${m.rest}`;
  });

  /** The line under the mug: the intention while focusing, otherwise what happens next. */
  protected readonly caption = computed(() => {
    if (this.onBreak()) return 'Step away from the screen. Stretch, sip, breathe.';
    if (this.brew.intention()) return `🎯 ${this.brew.intention()}`;
    const task = this.brew.tasks().find((t) => t.id === this.brew.taskId());
    return task ? `Up next: ${task.title}` : 'Press start to set an intention for this brew.';
  });
}
