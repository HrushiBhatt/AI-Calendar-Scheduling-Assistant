import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Theme } from '../core/theme';
import { Icon, IconName } from './icon';

/** One click between light and dark. Settings also offers following the system. */
@Component({
  selector: 'app-theme-toggle',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button class="glass thin glass-round" (click)="theme.toggle($event)" [attr.aria-label]="label()" [title]="label()">
      @for (name of [icon()]; track name) {
        <app-icon class="swap" [name]="name" />
      }
    </button>
  `,
  styles: `
    :host {
      display: block;
    }
    .swap {
      animation: swap 0.5s var(--ease-spring) both;
    }
    @keyframes swap {
      from {
        opacity: 0;
        transform: rotate(-70deg) scale(0.5);
      }
    }
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(Theme);
  protected readonly icon = computed<IconName>(() => (this.theme.current() === 'dark' ? 'sun' : 'moon'));
  protected readonly label = computed(() => (this.theme.current() === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'));
}
