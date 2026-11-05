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
import { Auth } from './core/auth/auth';
import { Brew } from './core/state/brew';
import { LiveEvents } from './core/api/live';
import { ICONS } from './shared/pixel-art/sprites';
import { Toasts } from './core/state/toast';
import { Theme } from './core/theme/theme';
import { BreathingDialog } from './features/focus-flow/breathing-dialog';
import { IntentionDialog } from './features/focus-flow/intention-dialog';
import { ReflectionDialog } from './features/focus-flow/reflection-dialog';
import { SettingsDialog } from './features/settings/settings-dialog';
import { Sprite } from './shared/pixel-art/sprite';

/** The page frame: the header on every signed-in page, the routed page, and the dialogs. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Sprite, IntentionDialog, BreathingDialog, ReflectionDialog, SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(Auth);
  protected readonly brew = inject(Brew);
  protected readonly live = inject(LiveEvents);
  protected readonly toasts = inject(Toasts);
  protected readonly theme = inject(Theme); // applies the saved theme as the app starts
  protected readonly gear = ICONS['gear'];
  protected readonly sun = ICONS['sun'];
  protected readonly moon = ICONS['moon'];
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
