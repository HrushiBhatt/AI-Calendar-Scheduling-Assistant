/**
 * Every sound is synthesized with the Web Audio API, so there are no audio files to
 * ship or license. Ambience layers are procedurally generated into short buffers
 * that loop seamlessly; baking the random events (crackles, clinks, notes) into the
 * buffer keeps them playing in a background tab, where JS timers get throttled.
 */
import { TickStyle } from '../data/models';

let ctx: AudioContext | undefined;
const supported = typeof AudioContext !== 'undefined';

/** The shared AudioContext. Call it once from a click so browsers allow playback later. */
export function audio(): AudioContext | undefined {
  if (!supported) return undefined; // no Web Audio (old browsers, test runners): stay silent
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function blip(freq: number, delay: number, seconds: number, type: OscillatorType = 'square', volume = 0.12): void {
  const ac = audio();
  if (!ac) return;
  const at = ac.currentTime + delay;
  const osc = new OscillatorNode(ac, { type, frequency: freq });
  const amp = new GainNode(ac);
  amp.gain.setValueAtTime(volume, at);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  osc.connect(amp).connect(ac.destination);
  osc.start(at);
  osc.stop(at + seconds);
}

/** 8-bit jingle: rising when focus ends, falling when a break ends. */
export function chime(phase: 'focus' | 'break'): void {
  const notes = phase === 'focus' ? [523, 659, 784, 1047] : [784, 659, 523];
  notes.forEach((f, i) => blip(f, i * 0.15, i === notes.length - 1 ? 0.35 : 0.15));
}

/** One second of the focus clock. `urgent` (the final minute) plays it louder. */
export function tick(style: TickStyle, second: number, urgent: boolean): void {
  if (style === 'clock') {
    blip(second % 2 ? 2000 : 1500, 0, 0.025, 'square', urgent ? 0.08 : 0.04);
  } else if (style === 'ominous') {
    const volume = urgent ? 0.45 : 0.22;
    blip(110, 0, 0.18, 'triangle', volume); // lub
    blip(92, 0.16, 0.24, 'triangle', volume * 0.8); // dub
  }
}

// ---- procedural ambience ---------------------------------------------------------

type Fill = (d: Float32Array, sampleRate: number) => void;
type Envelope = (t: number, seconds: number) => number;

const noise = () => Math.random() * 2 - 1;

function pink(d: Float32Array, gain = 1): void {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = noise();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    d[i] += (b0 + b1 + b2 + w * 0.1848) * gain;
  }
}

function brown(d: Float32Array, gain = 1): void {
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * noise()) / 1.02;
    d[i] += last * gain;
  }
}

/** Call fn(sampleIndex) at random moments, `perSecond` times per second on average. */
function scatter(d: Float32Array, sr: number, perSecond: number, fn: (at: number) => void): void {
  for (let n = Math.round((d.length / sr) * perSecond); n > 0; n--) fn(Math.floor(Math.random() * d.length));
}

function crackle(d: Float32Array, sr: number, at: number, volume: number): void {
  const len = Math.floor(sr * (0.002 + Math.random() * 0.008));
  for (let j = 0; j < len && at + j < d.length; j++) d[at + j] += noise() * volume * (1 - j / len) ** 2;
}

/** A soft sine voice (plus octave) shaped by env(t, seconds). */
function tone(d: Float32Array, sr: number, start: number, freq: number, seconds: number, volume: number, env: Envelope): void {
  const len = Math.min(Math.floor(seconds * sr), d.length - start);
  const w = 2 * Math.PI * freq;
  for (let i = 0; i < len; i++) {
    const t = i / sr;
    d[start + i] += volume * env(t, seconds) * (Math.sin(w * t) + 0.3 * Math.sin(2 * w * t));
  }
}
const pad: Envelope = (t, len) => Math.max(0, Math.min(1, t / 0.6, (len - t) / 0.9));
const pluck: Envelope = (t) => Math.min(1, t / 0.004) * Math.exp(-t * 6);
const ping: Envelope = (t) => Math.min(1, t / 0.002) * Math.exp(-t * 14);

const CHORDS = [
  [261.6, 329.6, 392.0, 493.9], // Cmaj7
  [220.0, 261.6, 329.6, 392.0], // Am7
  [174.6, 220.0, 261.6, 329.6], // Fmaj7
  [196.0, 246.9, 293.7, 349.2], // G7
];
const ARPEGGIO = [0, 2, 1, 3, 2, 1, 3, 2];

interface Recipe {
  seconds: number;
  filter?: [BiquadFilterType, number];
  fill: Fill;
}

const RECIPES: Record<string, Recipe> = {
  rain: { seconds: 8, filter: ['lowpass', 4500], fill: (d) => pink(d) },
  cafe: {
    seconds: 20,
    filter: ['lowpass', 6000],
    fill(d, sr) {
      // Murmur: low-passed pink noise that swells like distant conversation.
      const murmur = new Float32Array(d.length);
      pink(murmur);
      let lp = 0;
      for (let i = 0; i < d.length; i++) {
        const t = i / sr; // 0.15 and 0.35 Hz complete whole cycles in 20 s, so the loop is seamless
        lp += 0.08 * (murmur[i] - lp);
        d[i] += lp * (0.7 + 0.2 * Math.sin(2 * Math.PI * 0.15 * t) + 0.1 * Math.sin(2 * Math.PI * 0.35 * t + 1));
      }
      // Cups and spoons.
      scatter(d, sr, 0.4, (at) => tone(d, sr, at, 2200 + Math.random() * 2000, 0.4, 0.15 + Math.random() * 0.2, ping));
    },
  },
  fire: {
    seconds: 10,
    fill(d, sr) {
      brown(d, 3);
      scatter(d, sr, 14, (at) => crackle(d, sr, at, 0.05 + Math.random() ** 4 * 1.2));
    },
  },
  lofi: {
    seconds: 16,
    filter: ['lowpass', 2400],
    fill(d, sr) {
      const bar = Math.floor(d.length / CHORDS.length);
      CHORDS.forEach((notes, c) => {
        const start = c * bar;
        notes.forEach((f) => tone(d, sr, start, f, bar / sr, 0.05, pad));
        tone(d, sr, start, notes[0] / 2, bar / sr, 0.09, pad); // bass
        ARPEGGIO.forEach((n, k) => tone(d, sr, start + Math.floor((k * bar) / 8), notes[n] * 2, 0.7, 0.08, pluck));
      });
      scatter(d, sr, 5, (at) => crackle(d, sr, at, 0.1)); // vinyl dust
    },
  },
};

const AMBIENCE = Object.keys(RECIPES);

const FADE = 0.25; // seconds of tail cross-faded over the head so loops have no seam

function render(ac: AudioContext, { seconds, fill }: Recipe): AudioBuffer {
  const sr = ac.sampleRate;
  const len = Math.floor(seconds * sr);
  const fade = Math.floor(FADE * sr);
  const d = new Float32Array(len + fade);
  fill(d, sr);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i] * k + d[len + i] * (1 - k);
  }
  // Normalize loudness (RMS) so the sliders mean the same thing for every layer.
  const body = d.subarray(0, len);
  let sum = 0;
  for (const v of body) sum += v * v;
  const gain = 0.12 / Math.sqrt(sum / len || 1);
  for (let i = 0; i < len; i++) body[i] = Math.max(-1, Math.min(1, body[i] * gain));

  const buffer = new AudioBuffer({ length: len, sampleRate: sr });
  buffer.copyToChannel(body, 0);
  return buffer;
}

const buffers: Record<string, AudioBuffer> = {};
const live: Record<string, { source: AudioBufferSourceNode; gain: GainNode }> = {};
const customTrack = typeof Audio === 'undefined' ? null : Object.assign(new Audio(), { loop: true });

function startLayer(id: string): void {
  const ac = audio();
  if (!ac) return;
  const recipe = RECIPES[id];
  buffers[id] ??= render(ac, recipe);
  const source = new AudioBufferSourceNode(ac, { buffer: buffers[id], loop: true });
  const gain = new GainNode(ac, { gain: 0 });
  let node: AudioNode = source;
  if (recipe.filter) {
    const [type, frequency] = recipe.filter;
    node = node.connect(new BiquadFilterNode(ac, { type, frequency }));
  }
  node.connect(gain).connect(ac.destination);
  source.start(0, Math.random() * recipe.seconds); // random offset so layers don't phase-lock
  live[id] = { source, gain };
}

/** Apply slider volumes (0–1). Layers are created on demand and torn down at zero. */
export function mix(volumes: Record<string, number>, playing: boolean): void {
  for (const id of AMBIENCE) {
    const level = playing ? (volumes[id] ?? 0) ** 2 : 0; // squared ≈ perceptual loudness
    if (level > 0 && !live[id]) startLayer(id);
    const layer = live[id];
    if (!layer) continue;
    const now = layer.gain.context.currentTime;
    layer.gain.gain.setTargetAtTime(level, now, 0.2);
    if (level === 0) {
      layer.source.stop(now + 1);
      delete live[id];
    }
  }
  if (!customTrack) return;
  customTrack.volume = (volumes['custom'] ?? 0) ** 2;
  if (playing && volumes['custom'] > 0 && customTrack.src) void customTrack.play().catch(() => undefined);
  else customTrack.pause();
}

/** Use a local audio file as the "your audio" layer. */
export function loadCustomTrack(file: File): void {
  if (!customTrack) return;
  if (customTrack.src) URL.revokeObjectURL(customTrack.src);
  customTrack.src = URL.createObjectURL(file);
}
