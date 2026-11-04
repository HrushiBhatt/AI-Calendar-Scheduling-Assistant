import { ViewTransitionInfo } from '@angular/router';

export type NavKind = 'forward' | 'back' | 'ask';

/** The screens in the order the tab bar shows them, with Home before the tabs. */
const ORDER = ['', 'calendar', 'focus', 'progress'];

/**
 * Which way a move between screens should play: tabs slide in the direction you went, and
 * opening the plan screen has its own transition, because a command should feel like it opened
 * something. The plan screen sits with the calendar, so leaving it counts from there.
 */
export function navKind(from: string, to: string): NavKind {
  if (to === 'plan') return 'ask';
  const a = ORDER.indexOf(from === 'plan' ? 'calendar' : from);
  const b = ORDER.indexOf(to);
  return b < a ? 'back' : 'forward';
}

const leaf = (route: ViewTransitionInfo['to']): string => {
  let r = route;
  while (r.firstChild) r = r.firstChild;
  return r.routeConfig?.path ?? '';
};

/** Tells the stylesheet which animation this move plays, for as long as it lasts. */
export function markNavigation({ transition, from, to }: ViewTransitionInfo): void {
  const root = document.documentElement;
  root.dataset['nav'] = navKind(leaf(from), leaf(to));
  void transition.finished.catch(() => undefined).finally(() => delete root.dataset['nav']);
}
