import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { persistedSignal } from './persisted';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ThemeName = 'light' | 'dark';

const COLORS: Record<ThemeName, string> = { light: '#dbe9f6', dark: '#0b1320' };
const prefersLight = () => window.matchMedia?.('(prefers-color-scheme: light)');

type TransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void>; finished: Promise<void> };
};

function paint(theme: ThemeName): void {
  document.documentElement.dataset['theme'] = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[theme]);
}

/**
 * Light, dark or whatever the system says. It's a preference of the device, like the ambience
 * volumes: a phone can follow its own setting while a laptop stays dark. public/theme-init.js
 * applies the same choice before the first paint, so keep the two in step.
 */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly stored = persistedSignal<ThemeChoice>('brew:theme', 'system');
  private readonly systemLight = signal(prefersLight()?.matches ?? false);

  /** What the user picked. Anything unrecognized in storage means the system. */
  readonly choice = computed<ThemeChoice>(() => (['light', 'dark'].includes(this.stored()) ? this.stored() : 'system'));
  /** What's on screen. */
  readonly current = computed<ThemeName>(() => this.resolve(this.choice()));

  constructor() {
    const query = prefersLight();
    const onChange = (e: MediaQueryListEvent) => this.systemLight.set(e.matches);
    query?.addEventListener?.('change', onChange);
    inject(DestroyRef).onDestroy(() => query?.removeEventListener?.('change', onChange));
    effect(() => paint(this.current()));
  }

  /** Switch, with the new theme spreading out from the control that was used. */
  set(choice: ThemeChoice, from?: Event): void {
    const next = this.resolve(choice);
    const doc = document as TransitionDocument;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (next === this.current() || !doc.startViewTransition || still) {
      this.stored.set(choice);
      return;
    }
    const root = document.documentElement;
    const box = (from?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
    if (box) {
      root.style.setProperty('--reveal-x', `${box.left + box.width / 2}px`);
      root.style.setProperty('--reveal-y', `${box.top + box.height / 2}px`);
    }
    root.classList.add('theme-reveal');
    const transition = doc.startViewTransition(() => {
      paint(next);
      this.stored.set(choice);
    });
    transition.ready.catch(() => undefined); // skipped, say by a page change: it just doesn't animate
    void transition.finished.catch(() => undefined).finally(() => root.classList.remove('theme-reveal'));
  }

  /** Light to dark and back. Picking one this way stops following the system. */
  toggle(from?: Event): void {
    this.set(this.current() === 'dark' ? 'light' : 'dark', from);
  }

  private resolve(choice: ThemeChoice): ThemeName {
    if (choice === 'system') return this.systemLight() ? 'light' : 'dark';
    return choice;
  }
}
