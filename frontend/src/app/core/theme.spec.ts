import { TestBed } from '@angular/core/testing';
import { Theme } from './theme';

const KEY = 'brew:theme';
const root = () => document.documentElement;

/** A stand-in for the browser's preference, with a way to change it later. */
function fakeSystem(light: boolean) {
  const listeners: ((e: MediaQueryListEvent) => void)[] = [];
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query.includes('light') ? light : false,
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  return {
    change: (next: boolean) => listeners.forEach((fn) => fn({ matches: next } as MediaQueryListEvent)),
    restore: () => (window.matchMedia = original),
  };
}

describe('Theme', () => {
  let system: ReturnType<typeof fakeSystem>;

  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => {
    system.restore();
    localStorage.removeItem(KEY);
  });

  it('follows the system until the user picks', () => {
    system = fakeSystem(true);
    const theme = TestBed.inject(Theme);
    TestBed.tick();
    expect(theme.choice()).toBe('system');
    expect(root().dataset['theme']).toBe('light');

    system.change(false);
    TestBed.tick();
    expect(root().dataset['theme']).toBe('dark');
  });

  it('keeps a choice whatever the system does, and saves it', () => {
    system = fakeSystem(false);
    const theme = TestBed.inject(Theme);
    theme.set('light');
    TestBed.tick();
    expect(root().dataset['theme']).toBe('light');
    expect(localStorage.getItem(KEY)).toBe('"light"');

    system.change(true);
    system.change(false);
    TestBed.tick();
    expect(root().dataset['theme']).toBe('light');
  });

  it('toggles from what is on screen, and stops following the system', () => {
    system = fakeSystem(true);
    const theme = TestBed.inject(Theme);
    theme.toggle();
    TestBed.tick();
    expect(theme.choice()).toBe('dark');
    expect(root().dataset['theme']).toBe('dark');
    theme.toggle();
    TestBed.tick();
    expect(theme.choice()).toBe('light');
  });

  it('remembers across a visit', () => {
    system = fakeSystem(false);
    localStorage.setItem(KEY, '"light"');
    TestBed.inject(Theme);
    TestBed.tick();
    expect(root().dataset['theme']).toBe('light');
  });

  it('treats anything else in storage as following the system', () => {
    system = fakeSystem(false);
    localStorage.setItem(KEY, '"purple"');
    const theme = TestBed.inject(Theme);
    TestBed.tick();
    expect(theme.choice()).toBe('system');
    expect(root().dataset['theme']).toBe('dark');
  });

  it('updates the browser colour along with the page', () => {
    system = fakeSystem(false);
    const meta = document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
    const theme = TestBed.inject(Theme);
    theme.set('light');
    TestBed.tick();
    expect(meta.getAttribute('content')).toBe('#dbe9f6');
    meta.remove();
  });
});
