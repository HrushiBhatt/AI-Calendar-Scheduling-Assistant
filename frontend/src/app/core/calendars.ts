import { DestroyRef, Injectable, computed, inject, resource, signal } from '@angular/core';
import { Api, errorMessage } from './api';
import { Auth } from './auth';
import { LiveEvents } from './live';
import { Toasts } from './toast';

/** Calendars nobody connected: the one `make demo` seeds, and the live demo's. */
const SAMPLE_PROVIDERS = ['demo', 'sample calendar'];

/** The user's connected calendars, and starting the flow that connects another. */
@Injectable({ providedIn: 'root' })
export class Calendars {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);

  readonly state = resource({
    params: () => this.auth.user()?.id,
    loader: () => this.api.calendarAccounts(),
  });
  /** Null until the server answers, and if it can't be reached. */
  readonly info = computed(() => (this.state.hasValue() ? this.state.value() : null));
  /** Whether the planner sees the user's own meetings, not sample ones. */
  readonly connected = computed(() => this.info()?.accounts.some((a) => !SAMPLE_PROVIDERS.includes(a.provider)) ?? false);
  readonly busy = signal(false);

  constructor() {
    const sub = inject(LiveEvents).events$.subscribe((e) => {
      if (e.type === 'calendar.synced') this.state.reload();
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  async connect(): Promise<void> {
    this.busy.set(true);
    try {
      const { auth_url } = await this.api.calendarConnect();
      window.location.assign(auth_url); // the provider sends the browser back to /settings
    } catch (err) {
      this.toasts.show(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
