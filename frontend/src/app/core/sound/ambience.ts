import { Injectable, effect, signal } from '@angular/core';
import { audio, loadCustomTrack, mix } from './audio';
import { persistedSignal } from '../state/persisted';

/**
 * The ambience mixer's state. Audio is inherently per-device, so it lives in the
 * browser, in a service so the mix keeps playing when you switch pages.
 */
@Injectable({ providedIn: 'root' })
export class Ambience {
  readonly volumes = persistedSignal<Record<string, number>>('brew:mix', {
    rain: 0.5,
    cafe: 0,
    fire: 0,
    lofi: 0.3,
    custom: 0,
  });
  readonly playing = signal(false);
  readonly track = signal<string | null>(null);

  constructor() {
    effect(() => mix(this.volumes(), this.playing()));
  }

  toggle(): void {
    audio(); // create the AudioContext inside the click so the browser allows it
    this.playing.update((p) => !p);
  }

  setVolume(layer: string, value: number): void {
    this.volumes.update((v) => ({ ...v, [layer]: value }));
  }

  loadTrack(file: File): void {
    loadCustomTrack(file);
    this.track.set(file.name);
    this.volumes.update((v) => ({ ...v, custom: v['custom'] || 0.6 }));
  }
}
