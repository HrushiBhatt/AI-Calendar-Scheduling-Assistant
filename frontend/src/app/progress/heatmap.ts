import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  viewChild,
} from '@angular/core';
import { formatMinutes, localDay, plural } from '../core/time';

const CELL = 11;
const STEP = CELL + 3;
const LEFT = 30;
const TOP = 18;
const WEEKS = 53;
const LEGEND = ['No focus', 'Under 25m', '25–59m', '1–2h', '2h+'];

const level = (min: number) => (min <= 0 ? 0 : min < 25 ? 1 : min < 60 ? 2 : min < 120 ? 3 : 4);

/** GitHub-style consistency grid: one column per week, one cell per day, shaded by minutes focused. */
@Component({
  selector: 'app-heatmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scroll" #scroll>
      <svg [attr.viewBox]="'0 0 ' + width + ' ' + height" role="img" [attr.aria-label]="summary()">
        @for (m of grid().months; track m.col) {
          <text [attr.x]="left + m.col * step" y="10">{{ m.label }}</text>
        }
        @for (d of dayLabels; track d.row) {
          <text x="0" [attr.y]="top + d.row * step + cell - 2">{{ d.label }}</text>
        }
        @for (c of grid().cells; track c.key) {
          <rect [attr.class]="'heat-' + c.level" [style.--col]="c.col" [attr.x]="left + c.col * step" [attr.y]="top + c.row * step" [attr.width]="cell" [attr.height]="cell">
            <title>{{ c.label }}</title>
          </rect>
        }
      </svg>
    </div>
    <div class="footer">
      <span>{{ summary() }}</span>
      <span class="legend" aria-hidden="true">
        Less
        @for (label of legend; track $index) {
          <span class="swatch heat-{{ $index }}" [title]="label"></span>
        }
        More
      </span>
    </div>
  `,
  styleUrl: './heatmap.css',
})
export class Heatmap {
  readonly minutesByDay = input.required<Record<string, number>>();

  protected readonly cell = CELL;
  protected readonly step = STEP;
  protected readonly left = LEFT;
  protected readonly top = TOP;
  protected readonly width = LEFT + WEEKS * STEP;
  protected readonly height = TOP + 7 * STEP;
  protected readonly legend = LEGEND;
  protected readonly dayLabels = [
    { row: 1, label: 'Mon' },
    { row: 3, label: 'Wed' },
    { row: 5, label: 'Fri' },
  ];

  protected readonly grid = computed(() => {
    const data = this.minutesByDay();
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());

    const cells = [];
    const months = [];
    for (let d = new Date(start), i = 0; d <= today; d.setDate(d.getDate() + 1), i++) {
      const col = Math.floor(i / 7);
      const row = i % 7;
      const key = localDay(d);
      if (row === 0 && d.getDate() <= 7) months.push({ col, label: d.toLocaleString(undefined, { month: 'short' }) });
      const min = data[key] ?? 0;
      const when = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      cells.push({ key, col, row, level: level(min), min, label: `${when}: ${min ? formatMinutes(min) : 'no focus'}` });
    }
    return { cells, months };
  });

  protected readonly summary = computed(() => {
    const active = this.grid().cells.filter((c) => c.min > 0);
    const total = active.reduce((sum, c) => sum + c.min, 0);
    return `${plural(active.length, 'active day')} · ${formatMinutes(total)} this year`;
  });

  private readonly scroll = viewChild.required<ElementRef<HTMLElement>>('scroll');

  constructor() {
    // On narrow screens, start scrolled to the most recent weeks.
    afterNextRender(() => {
      const el = this.scroll().nativeElement;
      el.scrollLeft = el.scrollWidth;
    });
  }
}
