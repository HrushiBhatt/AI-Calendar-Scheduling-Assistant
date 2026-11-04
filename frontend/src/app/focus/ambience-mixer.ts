import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Ambience } from '../core/ambience';
import { tick } from '../core/audio';
import { Brew } from '../core/brew';
import { TickStyle } from '../core/models';
import { Icon } from '../shared/icon';

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

@Component({
  selector: 'app-ambience-mixer',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ambience-mixer.html',
  styleUrl: './ambience-mixer.css',
})
export class AmbienceMixer {
  protected readonly ambience = inject(Ambience);
  protected readonly brew = inject(Brew);
  protected readonly layers = LAYERS;
  protected readonly ticks = TICKS;
  protected readonly tickIndex = computed(() => TICKS.findIndex((t) => t.id === this.brew.settings().tick));

  protected volume(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected pickTrack(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) this.ambience.loadTrack(file);
  }

  protected chooseTick(style: TickStyle): void {
    void this.brew.updateSettings({ tick: style }); // saved to the account, so it follows you
    if (style !== 'off') tick(style, 1, false); // preview
  }
}
