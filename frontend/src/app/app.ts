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
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { AssistantBar } from './calendar/assistant-bar';
import { Auth } from './core/auth';
import { Brew } from './core/brew';
import { LiveEvents } from './core/live';
import { Theme } from './core/theme';
import { Toasts } from './core/toast';
import { BreathingDialog } from './dialogs/breathing-dialog';
import { IntentionDialog } from './dialogs/intention-dialog';
import { ReflectionDialog } from './dialogs/reflection-dialog';
import { SettingsDialog } from './dialogs/settings-dialog';
import { Icon, IconName } from './shared/icon';
import { MiniTimer } from './shared/mini-timer';
import { StartingBanner } from './shared/starting-banner';
import { ThemeToggle } from './shared/theme-toggle';

const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: '/calendar', label: 'Calendar', icon: 'calendar' },
  { path: '/focus', label: 'Focus', icon: 'mug' },
  { path: '/progress', label: 'Progress', icon: 'chart' },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, AssistantBar, Icon, MiniTimer, StartingBanner, ThemeToggle, IntentionDialog, BreathingDialog, ReflectionDialog, SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(Auth);
  protected readonly brew = inject(Brew);
  protected readonly live = inject(LiveEvents);
  protected readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  protected readonly nav = NAV;
  private readonly toast = viewChild.required<ElementRef<HTMLElement>>('toast');

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  /** Which tab is open, for the thumb that glides to it. The plan screen belongs to the calendar. */
  protected readonly activeIndex = computed(() => {
    const path = this.url().split(/[?#]/)[0];
    return NAV.findIndex((n) => n.path === (path === '/plan' ? '/calendar' : path));
  });
  protected readonly focusing = computed(() => {
    const { status, phase } = this.brew.timer.state();
    return status === 'running' && phase === 'focus';
  });

  constructor() {
    inject(Theme); // applies the choice and follows the system from the moment the app starts

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

  protected openSettings(): void {
    this.brew.settingsTab.set('general');
    this.brew.dialog.set('settings');
  }
}
