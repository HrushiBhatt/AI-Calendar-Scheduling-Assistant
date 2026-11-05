import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Brew } from '../../core/state/brew';
import { Task } from '../../core/api/models';
import { ICONS } from '../../shared/pixel-art/sprites';
import { MinutesPipe } from '../../shared/pipes';
import { Sprite } from '../../shared/pixel-art/sprite';

/** What you're working on: add a task with an estimate of focus blocks, brew it, tick it off. */
@Component({
  selector: 'app-task-list',
  imports: [ReactiveFormsModule, Sprite, MinutesPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList {
  protected readonly brew = inject(Brew);
  protected readonly closeIcon = ICONS['close'];
  protected readonly playIcon = ICONS['play'];
  protected readonly form = inject(NonNullableFormBuilder).group({
    title: ['', [Validators.required, Validators.maxLength(120)]],
    estimate: [1, [Validators.required, Validators.min(1), Validators.max(20)]],
  });

  protected readonly open = computed(() => this.brew.tasks().filter((t) => !t.done));
  protected readonly done = computed(() => this.brew.tasks().filter((t) => t.done));

  async add(): Promise<void> {
    const { title, estimate } = this.form.getRawValue();
    if (this.form.invalid || !title.trim()) return;
    await this.brew.addTask(title.trim(), estimate);
    this.form.reset();
  }

  /** One coffee bean per estimated brew, filled as they're completed (overruns shown too). */
  protected beans(task: Task): boolean[] {
    return Array.from({ length: Math.max(task.estimate, task.brews) }, (_, i) => i < task.brews);
  }
}
