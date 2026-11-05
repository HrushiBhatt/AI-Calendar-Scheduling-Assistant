import { Mode, Preset } from '../api/models';

/** Built-in rhythms. The user's own come from the API as presets. */
export const BUILTIN_MODES: Mode[] = [
  { key: 'pomodoro', name: 'Pomodoro', focus: 25, rest: 5, blurb: 'The classic sprint' },
  { key: '52-17', name: '52 / 17', focus: 52, rest: 17, blurb: 'Long focus, real rest' },
  { key: 'animedoro', name: 'Animedoro', focus: 50, rest: 10, blurb: 'Deep block, then a reward' },
  { key: 'deep-work', name: 'Deep Work', focus: 90, rest: 20, blurb: 'One full ultradian cycle' },
];

export const fromPreset = (p: Preset): Mode => ({
  key: `custom-${p.id}`,
  name: p.name,
  focus: p.focus,
  rest: p.rest,
  blurb: 'Your custom brew',
  presetId: p.id,
});
