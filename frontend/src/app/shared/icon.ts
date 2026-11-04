import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const PATHS = {
  calendar: 'M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  mug: 'M5 9h11v6a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V9zM16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5M12 3.5c-.6.8-.6 1.7 0 2.5',
  chart: 'M5 20v-7M12 20V5M19 20v-11',
  gear: 'M9.87 5.12 L10.09 2.59 L13.91 2.59 L14.13 5.12 L15.36 5.63 L17.30 4.00 L20.00 6.70 L18.37 8.64 L18.88 9.87 L21.41 10.09 L21.41 13.91 L18.88 14.13 L18.37 15.36 L20.00 17.30 L17.30 20.00 L15.36 18.37 L14.13 18.88 L13.91 21.41 L10.09 21.41 L9.87 18.88 L8.64 18.37 L6.70 20.00 L4.00 17.30 L5.63 15.36 L5.12 14.13 L2.59 13.91 L2.59 10.09 L5.12 9.87 L5.63 8.64 L4.00 6.70 L6.70 4.00 L8.64 5.63zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  sparkle: 'M12 3l1.9 5.6a2 2 0 0 0 1.3 1.3L21 12l-5.8 2.1a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.6a2 2 0 0 0-1.3-1.3L3 12l5.8-2.1a2 2 0 0 0 1.3-1.3L12 3z',
  send: 'M12 19V5M6 11l6-6 6 6',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6l1-7z',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  play: 'M8 5.5v13l10.5-6.5L8 5.5z',
  pause: 'M8 5v14M16 5v14',
  reset: 'M4 5v5h5M4.6 10a8 8 0 1 1-.6 3.5',
  skip: 'M6 5.5v13l9-6.5-9-6.5zM18 5v14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  volume: 'M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11',
  plus: 'M12 5v14M5 12h14',
  flame: 'M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.3 2 2.5-.5-3 0-5.5 1-8z',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4',
  moon: 'M20 14.2A8.5 8.5 0 1 1 9.8 4a7 7 0 0 0 10.2 10.2z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
} as const;

export type IconName = keyof typeof PATHS;

/** A line icon, drawn inline so the page loads nothing from another host. Size it with --icon. */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 24 24" [attr.fill]="solid() ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path [attr.d]="d()" />
    </svg>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
      width: var(--icon, 18px);
      height: var(--icon, 18px);
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
  `,
})
export class Icon {
  readonly name = input.required<IconName>();
  protected readonly d = computed(() => PATHS[this.name()]);
  protected readonly solid = computed(() => this.name() === 'play' || this.name() === 'skip');
}
