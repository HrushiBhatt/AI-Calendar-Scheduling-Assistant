import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

interface Run {
  x: number;
  y: number;
  w: number;
  fill: string;
}

/** Merge each row's same-colored neighbouring pixels into single rects. */
export function runs(rows: readonly string[], palette: Record<string, string>, fill?: string): Run[] {
  const color = (c: string | undefined) => (c === undefined || c === '.' ? null : (fill ?? palette[c]));
  const out: Run[] = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const paint = color(row[x]);
      let w = 1;
      while (x + w < row.length && color(row[x + w]) === paint) w++;
      if (paint) out.push({ x, y, w, fill: paint });
      x += w;
    }
  });
  return out;
}

/** Text pixel art rendered as crisp SVG. Size it with a class on the host. */
@Component({
  selector: 'app-sprite',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.viewBox]="viewBox()"
      shape-rendering="crispEdges"
      [attr.role]="title() ? 'img' : null"
      [attr.aria-label]="title() || null"
      [attr.aria-hidden]="title() ? null : 'true'"
    >
      @for (r of rects(); track $index) {
        <rect [attr.x]="r.x" [attr.y]="r.y" [attr.width]="r.w" height="1" [attr.fill]="r.fill" />
      }
    </svg>
  `,
  styles: `
    :host { display: block; }
    svg { display: block; width: 100%; height: 100%; }
  `,
})
export class Sprite {
  readonly rows = input.required<readonly string[]>();
  readonly palette = input<Record<string, string>>({ x: 'currentColor' });
  /** Paint every pixel this color (e.g. a locked item's silhouette). */
  readonly fill = input<string>();
  readonly title = input<string>();

  protected readonly viewBox = computed(() => `0 0 ${this.rows()[0].length} ${this.rows().length}`);
  protected readonly rects = computed(() => runs(this.rows(), this.palette(), this.fill()));
}
