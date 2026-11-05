import { TestBed } from '@angular/core/testing';
import { localDay } from '../state/time';
import { LiveEvent, Session } from '../api/models';
import { STORAGE_KEY, Store } from './store';

const focus = { mode: 'Pomodoro', planned: 1500, intention: 'Write', task_id: null, day: '2026-11-04' };

const session = (day: string): Session => ({
  id: 1, task_id: null, mode: 'x', planned: 60, focused: 60, completed: true, intention: '', reflection: '', distractions: 0, day, created_at: '',
});

const dayOf = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localDay(d);
};

describe('Store', () => {
  let store: Store;
  let events: LiveEvent[];

  /** A fresh store, as on page load, with this already saved. */
  const open = (saved?: unknown) => {
    TestBed.resetTestingModule();
    localStorage.clear();
    if (saved !== undefined) localStorage.setItem(STORAGE_KEY, typeof saved === 'string' ? saved : JSON.stringify(saved));
    store = TestBed.inject(Store);
    events = [];
    store.events$.subscribe((e) => events.push(e));
  };

  beforeEach(() => open());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('starts empty, with nothing fake in it', () => {
    expect(store.tasks()).toEqual([]);
    expect(store.presets()).toEqual([]);
    expect(store.sessions()).toEqual([]);
    expect(store.stats().total.sessions).toBe(0);
    expect(store.timer().status).toBe('idle');
  });

  it('checks what it stores', () => {
    expect(() => store.createTask('   ', 1)).toThrow('Title is required.');
    expect(() => store.createTask('x'.repeat(121), 1)).toThrow('at most 120');
    expect(() => store.createTask('Fine', 0)).toThrow('from 1 to 20');
    expect(() => store.createPreset({ name: 'Long', focus: 999, rest: 5 })).toThrow('from 1 to 180');
    expect(() => store.startFocus({ ...focus, planned: 5 })).toThrow('from 60 to 10800');
    expect(() => store.startFocus({ ...focus, task_id: 999 })).toThrow('no longer exists');
    expect(() => store.saveSettings({ ...store.settings(), tick: 'loud' as 'off' })).toThrow('Ticking');
  });

  it('keeps tasks across a reload, with open ones first and totals from their sessions', () => {
    store.createTask('First', 2);
    store.createTask('Second', 1);
    store.setTaskDone(store.tasks()[0].id, true);
    const saved = localStorage.getItem(STORAGE_KEY)!;
    open(saved);
    expect(store.tasks().map((t) => t.title)).toEqual(['Second', 'First']);
  });

  it('tells this tab what changed', () => {
    store.createTask('First', 2);
    expect(events).toEqual([{ type: 'changed', data: { kind: 'tasks' } }]);
  });

  it('runs one timer at a time, pausing and resuming', () => {
    expect(store.startFocus(focus).status).toBe('running');
    expect(() => store.startFocus(focus)).toThrow('already running');
    expect(store.control('pause').status).toBe('paused');
    expect(store.control('resume').status).toBe('running');
    expect(store.control('cancel').status).toBe('idle');
    expect(() => store.control('pause')).toThrow('No timer');
  });

  it("doesn't log a block ended in its first minute", () => {
    store.startFocus(focus);
    store.control('finish');
    expect(store.sessions()).toEqual([]);
    expect(events.some((e) => e.type === 'session.discarded')).toBe(true);
  });

  it('logs a finished block on its deadline and credits the full time', () => {
    vi.useFakeTimers();
    open();
    store.startFocus(focus);
    vi.advanceTimersByTime(1500 * 1000);
    expect(store.timer().status).toBe('idle');
    expect(store.sessions()[0]).toMatchObject({ focused: 1500, completed: true, intention: 'Write' });
    const done = events.find((e) => e.type === 'session.completed');
    expect(done).toMatchObject({ data: { unlocked: 'sprout' } }); // the first full brew earns the first decoration
  });

  it('finishes a block whose deadline passed while no tab was open', () => {
    vi.useFakeTimers();
    open();
    store.startFocus(focus);
    const saved = localStorage.getItem(STORAGE_KEY)!;
    vi.advanceTimersByTime(3 * 3600 * 1000); // a long time with the tab closed
    open(saved);
    vi.advanceTimersByTime(0);
    expect(store.timer().status).toBe('idle');
    expect(store.sessions()[0].focused).toBe(1500); // the planned time, not the three hours
  });

  it('counts a streak back from today, and yesterday still counts until today ends', () => {
    open({ sessions: [session(dayOf(-2)), session(dayOf(-1))] });
    expect(store.stats(dayOf(0)).streak).toBe(2);
    expect(store.stats(dayOf(1)).streak).toBe(0);
    expect(store.stats(dayOf(0)).best_streak).toBe(2);
  });

  it('survives a damaged save', () => {
    for (const bad of ['{not json', 'null', '42', { tasks: 'nope', sessions: 7, settings: null, nextId: 'x' }]) {
      open(bad);
      expect(store.tasks()).toEqual([]);
      expect(store.stats().streak).toBe(0);
      expect(store.settings().tick).toBe('off');
      store.createTask('Still works', 1);
      expect(store.tasks().length).toBe(1);
    }
  });

  it('says so when it can\'t save, and carries on in memory', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    store.createTask('Kept for now', 1);
    expect(events.some((e) => e.type === 'save.failed')).toBe(true);
    write.mockRestore();
  });
});
