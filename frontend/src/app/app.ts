import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Auth } from './core/auth';
import { Brew } from './core/brew';
import { LiveEvents } from './core/live';
import { ICONS } from './core/sprites';
import { Toasts } from './core/toast';
import { BreathingDialog } from './dialogs/breathing-dialog';
import { IntentionDialog } from './dialogs/intention-dialog';
import { ReflectionDialog } from './dialogs/reflection-dialog';
import { SettingsDialog } from './dialogs/settings-dialog';
import { Sprite } from './shared/sprite';
import { StartingBanner } from './shared/starting-banner';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Sprite, StartingBanner, IntentionDialog, BreathingDialog, ReflectionDialog, SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(Auth);
  protected readonly brew = inject(Brew);
  protected readonly live = inject(LiveEvents);
  protected readonly toasts = inject(Toasts);
  protected readonly gear = ICONS['gear'];
  private readonly toast = viewChild.required<ElementRef<HTMLElement>>('toast');

  constructor() {
    // Signing in opens the live stream and loads the account; signing out tears it down.
    const userId = computed(() => this.auth.user()?.id);
    effect(() => {
      const id = userId();
      untracked(() => (id ? void this.brew.start() : this.brew.stop()));
    });

    // The toast is a popover, so it shows above any open dialog (both live in the top layer).
    effect(() => {
      if (!this.toasts.current().visible) return;
      const el = this.toast().nativeElement;
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    });
  }
}
