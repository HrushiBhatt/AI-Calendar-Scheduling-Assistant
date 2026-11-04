import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Ambience } from '../../core/sound/ambience';
import { tick } from '../../core/sound/audio';
import { Brew } from '../../core/state/brew';
import { TickStyle } from '../../core/data/models';

const LAYERS = [
  { id: 'rain', label: 'Rain', icon: '🌧️' },
  { id: 'cafe', label: 'Café', icon: '☕' },
  { id: 'fire', label: 'Fireplace', icon: '🔥' },
  { id: 'lofi', label: 'Lo-fi keys', icon: '🎹' },
];

const TICKS: { id: TickStyle; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'clock', label: 'Clock' },
  { id: 'ominous', label: 'Ominous' },
];

/**
 * Background sound: rain, café, fireplace and lo-fi layers mixed together, plus your own audio
 * file and an optional tick. The sound is synthesized in core/sound, so there are no audio files.
 */
@Component({
  selector: 'app-ambience-mixer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ambience-mixer.html',
  styleUrl: './ambience-mixer.css',
})
export class AmbienceMixer {
  protected readonly ambience = inject(Ambience);
  protected readonly brew = inject(Brew);
  protected readonly layers = LAYERS;
  protected readonly ticks = TICKS;

  protected volume(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  /** Plays a file from the user's own disk. It stays in the browser and is never uploaded. */
  protected pickTrack(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.ambience.loadTrack(file);
  }

  protected chooseTick(style: TickStyle): void {
    void this.brew.updateSettings({ tick: style });
    if (style !== 'off') tick(style, 1, false); // preview
  }
}
