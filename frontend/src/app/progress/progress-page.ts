import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { Api } from '../core/api';
import { Brew } from '../core/brew';
import { MinutesPipe, PluralPipe } from '../shared/pipes';
import { CafeShelf } from './cafe-shelf';
import { Heatmap } from './heatmap';
import { PlanningInsights } from './planning-insights';

@Component({
  selector: 'app-progress-page',
  imports: [Heatmap, CafeShelf, PlanningInsights, DatePipe, MinutesPipe, PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './progress-page.html',
  styleUrl: './progress-page.css',
})
export class ProgressPage {
  private readonly api = inject(Api);
  protected readonly brew = inject(Brew);
  protected readonly stats = this.brew.stats;

  /** Reloads whenever stats change, i.e. whenever a session lands on any device. */
  protected readonly journal = resource({
    params: () => this.stats(),
    loader: () => this.api.sessions(),
  });

  /** Planning numbers, refreshed alongside the stats. */
  protected readonly insights = resource({
    params: () => this.stats(),
    loader: () => this.api.insights(),
  });

  private readonly taskTitles = computed(() => new Map(this.brew.tasks().map((t) => [t.id, t.title])));

  constructor() {
    void this.brew.refresh('sessions');
  }

  protected taskTitle(id: number | null): string | undefined {
    return id === null ? undefined : this.taskTitles().get(id);
  }

  protected readonly round = Math.round;
}
