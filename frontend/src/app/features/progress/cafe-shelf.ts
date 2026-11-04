import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CAFE } from '../../shared/pixel-art/sprites';
import { PluralPipe } from '../../shared/pipes';
import { Sprite } from '../../shared/pixel-art/sprite';

/** Every full brew furnishes a cozy pixel café. Locked items show as silhouettes. */
@Component({
  selector: 'app-cafe-shelf',
  imports: [Sprite, PluralPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="shelf">
      @for (item of items; track item.id) {
        @let unlocked = completed() >= item.at;
        <li [class.unlocked]="unlocked">
          <app-sprite
            class="sprite"
            [rows]="item.rows"
            [palette]="item.palette"
            [fill]="unlocked ? undefined : '#242424'"
            [title]="unlocked ? item.name : 'Locked: ' + item.at + ' full brews'"
          />
          <span class="name">{{ unlocked ? item.name : (item.at | plural: 'brew') }}</span>
        </li>
      }
    </ul>
    <div class="next">
      <p>
        @if (next(); as item) {
          {{ item.at - completed() | plural: 'more full brew' }} to unlock the {{ item.name }}.
        } @else {
          Your café is fully furnished. ☕
        }
      </p>
      <div class="meter"><span [style.width.%]="progress() * 100"></span></div>
    </div>
  `,
  styleUrl: './cafe-shelf.css',
})
export class CafeShelf {
  readonly completed = input.required<number>();
  protected readonly items = CAFE;
  protected readonly next = computed(() => CAFE.find((item) => this.completed() < item.at));
  protected readonly progress = computed(() => {
    const next = this.next();
    if (!next) return 1;
    const prevAt = CAFE.filter((item) => item.at <= this.completed()).at(-1)?.at ?? 0;
    return (this.completed() - prevAt) / (next.at - prevAt);
  });
}
