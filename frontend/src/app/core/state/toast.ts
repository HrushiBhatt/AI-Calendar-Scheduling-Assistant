import { Injectable, signal } from '@angular/core';

/** The small message at the bottom of the page. One at a time; a new one replaces the last. */
@Injectable({ providedIn: 'root' })
export class Toasts {
  private timer?: ReturnType<typeof setTimeout>;
  readonly current = signal({ message: '', visible: false });

  show(message: string): void {
    clearTimeout(this.timer);
    this.current.set({ message, visible: true });
    this.timer = setTimeout(() => this.current.update((t) => ({ ...t, visible: false })), 3200);
  }
}
