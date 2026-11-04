import { Injectable, computed, effect } from '@angular/core';
import { persistedSignal } from '../state/persisted';

export type ThemeName = 'light' | 'dark';

/** The browser's address-bar color for each theme. Keep in step with styles.css. */
const COLORS: Record<ThemeName, string> = { light: '#f7f1e8', dark: '#000000' };

/**
 * Light or dark, dark by default. It's a preference of the device, like the ambience volumes,
 * so it's kept separately from the app's data. public/theme-init.js applies the
 * same choice before the first paint, so keep the storage key and colors in step with it.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly stored = persistedSignal<string>('brew:theme', 'dark');

  /** What's on screen. Anything unrecognized in storage means dark. */
  readonly current = computed<ThemeName>(() => (this.stored() === 'light' ? 'light' : 'dark'));

  constructor() {
    effect(() => {
      document.documentElement.dataset['theme'] = this.current();
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[this.current()]);
    });
  }

  toggle(): void {
    this.stored.set(this.current() === 'dark' ? 'light' : 'dark');
  }
}
