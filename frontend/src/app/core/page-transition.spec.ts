import { navKind } from './page-transition';

describe('navKind', () => {
  it('slides tabs in the direction you went', () => {
    expect(navKind('', 'calendar')).toBe('forward');
    expect(navKind('calendar', 'focus')).toBe('forward');
    expect(navKind('focus', 'progress')).toBe('forward');
    expect(navKind('progress', 'calendar')).toBe('back');
    expect(navKind('focus', '')).toBe('back');
  });

  it('opens the plan screen with its own transition, from anywhere', () => {
    for (const from of ['', 'calendar', 'progress']) expect(navKind(from, 'plan')).toBe('ask');
  });

  it('treats the plan screen as part of the calendar when leaving it', () => {
    expect(navKind('plan', 'calendar')).toBe('forward');
    expect(navKind('plan', 'focus')).toBe('forward');
    expect(navKind('plan', '')).toBe('back');
  });
});
