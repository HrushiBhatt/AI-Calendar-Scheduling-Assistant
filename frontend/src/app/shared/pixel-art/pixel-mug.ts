import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

type Rect = readonly [x: number, y: number, w: number, h: number, fill?: string];

// The original Brew Focus mug, drawn on an 8-unit pixel grid in a 200×220 viewBox.
const INK = '#2A2A2A';

const BODY: Rect[] = [
  [32, 40, 120, 8, '#E8E8E8'],
  ...Array.from({ length: 13 }, (_, i): Rect => [24, 48 + i * 8, 136, 8, i % 3 === 2 ? '#F5F5F5' : '#FFFFFF']),
  [24, 152, 136, 8, '#F0F0F0'],
  [24, 160, 136, 8, '#E8E8E8'],
  [32, 168, 120, 8, '#E0E0E0'],
  [40, 176, 104, 8, '#D8D8D8'],
];

const OUTLINE: Rect[] = [
  [32, 32, 120, 8], [24, 40, 8, 8], [152, 40, 8, 8], [16, 48, 8, 136], [160, 48, 8, 120],
  [16, 176, 8, 8], [24, 184, 8, 8], [32, 184, 120, 8], [152, 184, 8, 8], [160, 168, 8, 16],
  // handle
  [160, 56, 8, 8], [168, 48, 16, 8], [184, 56, 8, 16], [192, 72, 8, 56],
  [184, 128, 8, 16], [168, 144, 16, 8], [160, 136, 8, 8],
];

const HANDLE: Rect[] = [
  [168, 56, 16, 8, '#FFFFFF'], [176, 64, 8, 8, '#FFFFFF'], [184, 72, 8, 56, '#F5F5F5'],
  [176, 72, 8, 56, '#E8E8E8'], [176, 128, 8, 8, '#FFFFFF'], [168, 136, 8, 8, '#F0F0F0'],
];

const STEAM = [
  [[10, 30], [10, 24], [14, 18], [10, 12], [6, 6]],
  [[28, 32], [28, 26], [24, 20], [28, 14], [32, 8]],
  [[46, 30], [46, 24], [42, 18], [46, 12], [50, 6]],
];

const FULL = 120; // coffee column height when the mug is full

/** The mug. fill: 0 (empty) → 1 (full), snapped to a 4-unit grid for a chunky, retro drain. */
@Component({
  selector: 'app-pixel-mug',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pixel-mug.html',
  styleUrl: './pixel-mug.css',
  host: {
    '[class.is-running]': 'running()',
    '[class.is-celebrating]': 'celebrate()',
    '[class.is-break]': 'onBreak()',
  },
})
export class PixelMug {
  readonly fill = input.required<number>();
  readonly running = input(false);
  readonly celebrate = input(false);
  readonly onBreak = input(false);

  protected readonly body = BODY;
  protected readonly frame = [...OUTLINE.map(([x, y, w, h]): Rect => [x, y, w, h, INK]), ...HANDLE];
  protected readonly steam = STEAM;

  protected readonly level = computed(() => Math.round((FULL * Math.min(1, Math.max(0, this.fill()))) / 4) * 4);
  protected readonly top = computed(() => 56 + FULL - this.level());
}
