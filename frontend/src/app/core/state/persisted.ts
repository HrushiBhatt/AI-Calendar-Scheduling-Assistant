import { WritableSignal, effect, signal } from '@angular/core';

/**
 * A signal that survives reloads via localStorage, for per-device preferences
 * (ambience volumes, the selected mode). Objects are merged over `initial` so
 * newly added keys get defaults. Must be created in an injection context.
 */
export function persistedSignal<T>(key: string, initial: T): WritableSignal<T> {
  let value = initial;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      const parsed = JSON.parse(saved) as T;
      value = typeof initial === 'object' && initial !== null ? { ...initial, ...parsed } : parsed;
    }
  } catch {
    // Blocked or corrupt storage: fall back to the default.
  }
  const state = signal(value);
  effect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(state()));
    } catch {
      // Private mode or full: the preference just won't persist.
    }
  });
  return state;
}
