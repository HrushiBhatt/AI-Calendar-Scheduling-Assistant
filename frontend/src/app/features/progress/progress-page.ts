import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Store } from '../../core/data/store';
import { Brew } from '../../core/state/brew';
import { MinutesPipe, PluralPipe } from '../../shared/pipes';
import { CafeShelf } from './cafe-shelf';
import { Heatmap } from './heatmap';

/** The tracking page: totals, streaks, the year heatmap, the café and the journal. */
@Component({
  selector: 'app-progress-page',
  imports: [Heatmap, CafeShelf, DatePipe, MinutesPipe, PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './progress-page.html',
  styleUrl: './progress-page.css',
})
export class ProgressPage {
  private readonly store = inject(Store);
  protected readonly brew = inject(Brew);
  protected readonly stats = this.brew.stats;

  /** Read again whenever the stats change, which is whenever a session lands in any tab. */
  protected readonly journal = computed(() => {
    this.stats();
    return this.store.sessions();
  });

  /** Task names by ID, so a journal entry can say what it was for. */
  private readonly taskTitles = computed(() => new Map(this.brew.tasks().map((t) => [t.id, t.title])));

  protected taskTitle(id: number | null): string | undefined {
    return id === null ? undefined : this.taskTitles().get(id);
  }

  protected readonly round = Math.round;
}
