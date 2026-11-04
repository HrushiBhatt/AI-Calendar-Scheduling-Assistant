import { TestBed } from '@angular/core/testing';
import { Store, STORAGE_KEY } from '../data/store';
import { Brew } from './brew';

describe('Brew session flow', () => {
  let brew: Brew;
  let store: Store;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem(STORAGE_KEY);
    store = TestBed.inject(Store);
    brew = TestBed.inject(Brew);
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem(STORAGE_KEY);
  });

  /** Start a 25-minute block and let it run out. */
  const runBlock = () => {
    brew.beginFocus('Ship it', null, false);
    vi.advanceTimersByTime(25 * 60_000);
  };

  it('shows the selected mode, full, when idle', () => {
    expect(brew.phase()).toBe('focus');
    expect(brew.display()).toEqual({ durationMs: 25 * 60_000, remainingMs: 25 * 60_000 });
    expect(brew.fill()).toBe(1);
  });

  it('asks for an intention, then starts the timer', () => {
    brew.primary();
    expect(brew.dialog()).toBe('intention');
    brew.beginFocus('Ship it', null, false);
    expect(brew.dialog()).toBeNull();
    expect(brew.timer.state().status).toBe('running');
    expect(brew.intention()).toBe('Ship it');
  });

  it('breathes first when asked to', () => {
    brew.beginFocus('Ship it', null, true);
    expect(brew.dialog()).toBe('breathe');
    expect(brew.timer.state().status).toBe('idle');
    brew.launch();
    expect(brew.timer.state().status).toBe('running');
  });

  it('opens the reflection prompt when a block finishes, with an empty mug', () => {
    runBlock();
    expect(brew.dialog()).toBe('reflect');
    expect(brew.reflecting()?.unlocked).toBe('sprout');
    expect(brew.fill()).toBe(0);
    expect(brew.busy()).toBe(true);
    expect(brew.stats().total.sessions).toBe(1);
  });

  it('saves the reflection and moves on to the break, where the mug refills', () => {
    runBlock();
    brew.finishReflection('Went well');
    expect(store.sessions()[0].reflection).toBe('Went well');
    expect(brew.dialog()).toBeNull();
    expect(brew.phase()).toBe('break');
    expect(brew.timer.state().status).toBe('running');
    expect(brew.fill()).toBeCloseTo(0, 2);
  });

  it('waits for the play button when auto-start breaks is off', async () => {
    await brew.updateSettings({ autoBreak: false });
    runBlock();
    brew.finishReflection('');
    expect(brew.pendingBreak()).toBe(true);
    expect(brew.phase()).toBe('break');
    brew.skip();
    expect(brew.pendingBreak()).toBe(false);
    expect(brew.phase()).toBe('focus');
  });

  it('keeps tasks and modes in step with the store', () => {
    brew.addTask('Write the report', 2);
    expect(brew.tasks().map((t) => t.title)).toEqual(['Write the report']);
    brew.toggleTask(brew.tasks()[0]);
    expect(brew.tasks()[0].done).toBe(true);
    brew.removeTask(brew.tasks()[0]);
    expect(brew.tasks()).toEqual([]);

    brew.createMode('Thesis', 75, 15);
    expect(brew.presets().length).toBe(1);
    expect(brew.mode().name).toBe('Thesis');
    brew.deleteMode(brew.mode());
    expect(brew.presets()).toEqual([]);
    expect(brew.mode().name).toBe('Pomodoro');
  });

  it('shows a mistake instead of throwing', () => {
    brew.addTask('   ', 1);
    expect(brew.tasks()).toEqual([]);
  });
});
