import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, viewChild } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Brew } from './core/state/brew';
import { Toasts } from './core/state/toast';
import { Theme } from './core/theme/theme';
import { BreathingDialog } from './features/focus-flow/breathing-dialog';
import { IntentionDialog } from './features/focus-flow/intention-dialog';
import { ReflectionDialog } from './features/focus-flow/reflection-dialog';
import { SettingsDialog } from './features/settings/settings-dialog';
import { Sprite } from './shared/pixel-art/sprite';
import { ICONS } from './shared/pixel-art/sprites';

/** The page frame: the header, the routed page, and the dialogs that can open over any page. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Sprite, IntentionDialog, BreathingDialog, ReflectionDialog, SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly brew = inject(Brew);
  protected readonly toasts = inject(Toasts);
  protected readonly theme = inject(Theme); // applies the saved theme as the app starts
  protected readonly gear = ICONS['gear'];
  protected readonly sun = ICONS['sun'];
  protected readonly moon = ICONS['moon'];
  private readonly toast = viewChild.required<ElementRef<HTMLElement>>('toast');

  constructor() {
    // The toast is a popover, so it shows above any open dialog (both live in the top layer).
    effect(() => {
      if (!this.toasts.current().visible) return;
      const el = this.toast().nativeElement;
      if (el.matches(':popover-open')) el.hidePopover();
      el.showPopover();
    });
  }
}
