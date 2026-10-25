import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Brew } from '../core/brew';
import { Energy, Task } from '../core/models';
import { ICONS } from '../core/sprites';
import { MinutesPipe } from '../shared/pipes';
import { Sprite } from '../shared/sprite';

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
  protected readonly moreIcon = ICONS['more'];
  /** The task whose planning details are open. */
  protected readonly editing = signal<number | null>(null);
  protected readonly priorities = ['None', 'Low', 'Medium', 'High'];
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

  protected toggleDetails(task: Task): void {
    this.editing.update((id) => (id === task.id ? null : task.id));
  }

  /** <input type=date> value for a task's deadline, in local time. */
  protected dueValue(task: Task): string {
    if (!task.due_at) return '';
    const d = new Date(task.due_at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** A short "due Fri" label, or "overdue". */
  protected dueLabel(task: Task): string {
    if (!task.due_at) return '';
    const due = new Date(task.due_at);
    if (due.getTime() < Date.now()) return 'overdue';
    return 'due ' + due.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  protected setDue(task: Task, event: Event): void {
    const value = (event.target as HTMLInputElement).value; // YYYY-MM-DD, or "" when cleared
    let due = '';
    if (value) {
      const [y, m, d] = value.split('-').map(Number);
      due = new Date(y, m - 1, d, 23, 59, 0).toISOString(); // the end of that day where the user is
    }
    void this.brew.editTask(task, { due_at: due });
  }

  protected setPriority(task: Task, event: Event): void {
    void this.brew.editTask(task, { priority: Number((event.target as HTMLSelectElement).value) });
  }

  protected setEnergy(task: Task, event: Event): void {
    void this.brew.editTask(task, { energy: (event.target as HTMLSelectElement).value as Energy });
  }

  protected setEstimate(task: Task, event: Event): void {
    const n = (event.target as HTMLInputElement).valueAsNumber;
    if (Number.isInteger(n) && n >= 1 && n <= 20) void this.brew.editTask(task, { estimate: n });
  }

  /** One coffee bean per estimated brew, filled as they're completed (overruns shown too). */
  protected beans(task: Task): boolean[] {
    return Array.from({ length: Math.max(task.estimate, task.brews) }, (_, i) => i < task.brews);
  }
}
