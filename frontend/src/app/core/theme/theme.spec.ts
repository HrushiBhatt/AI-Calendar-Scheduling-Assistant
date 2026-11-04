import { TestBed } from '@angular/core/testing';
import { Theme } from './theme';

describe('Theme', () => {
  const html = document.documentElement;

  /** A fresh service, as on page load, with this already in storage. */
  const start = (stored?: string) => {
    localStorage.clear();
    if (stored) localStorage.setItem('brew:theme', JSON.stringify(stored));
    TestBed.resetTestingModule();
    const theme = TestBed.inject(Theme);
    TestBed.tick();
    return theme;
  };

  afterEach(() => localStorage.clear());

  it('starts dark, whatever the system prefers', () => {
    expect(start().current()).toBe('dark');
    expect(html.dataset['theme']).toBe('dark');
  });

  it('keeps the choice across a reload', () => {
    const theme = start();
    theme.toggle();
    TestBed.tick();
    expect(html.dataset['theme']).toBe('light');
    expect(JSON.parse(localStorage.getItem('brew:theme')!)).toBe('light');

    TestBed.resetTestingModule();
    expect(TestBed.inject(Theme).current()).toBe('light');
  });

  it('treats anything unrecognized in storage as dark', () => {
    expect(start('system').current()).toBe('dark');
    expect(start('nonsense').current()).toBe('dark');
  });
});
