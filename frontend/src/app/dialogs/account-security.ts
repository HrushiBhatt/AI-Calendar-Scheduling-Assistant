import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Api, errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { Brew } from '../core/brew';
import { Toasts } from '../core/toast';

/** The account part of the settings dialog: password, Google sign-in, signed-in devices. */
@Component({
  selector: 'app-account-security',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="group" aria-labelledby="set-security">
      <h3 id="set-security">Account security</h3>

      <form class="pw" [formGroup]="form" (ngSubmit)="savePassword()">
        @if (auth.user()?.has_password) {
          <label class="field">
            Current password
            <input class="input px" type="password" formControlName="current" autocomplete="current-password" />
          </label>
        } @else {
          <p class="setting-hint">You sign in with Google. Add a password to have a second way in.</p>
        }
        <label class="field">
          New password
          <input class="input px" type="password" formControlName="next" autocomplete="new-password" />
        </label>
        <p class="setting-hint">At least 12 characters. A few unrelated words work well.</p>
        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }
        <button class="btn btn-sm px" [disabled]="busy()">
          {{ auth.user()?.has_password ? 'Change password' : 'Set password' }}
        </button>
      </form>

      @if (providers.value()?.google || auth.user()?.google_linked) {
        <div class="line">
          <span class="setting-hint">
            {{ auth.user()?.google_linked ? 'Google sign-in is on.' : 'Sign in with your Google account as well.' }}
          </span>
          @if (auth.user()?.google_linked) {
            <button class="btn btn-sm px" (click)="unlink()" [disabled]="busy()">Remove Google sign-in</button>
          } @else {
            <a class="btn btn-sm px" href="/api/auth/google/link">Connect Google sign-in</a>
          }
        </div>
      }

      <div class="line">
        <span class="setting-hint">Lost a device? This ends every session, including this one.</span>
        <button class="btn btn-sm btn-danger px" (click)="signOutEverywhere()" [disabled]="busy()">Sign out everywhere</button>
      </div>
    </section>
  `,
  styles: `
    .group {
      display: grid;
      gap: 14px;
      padding-bottom: 18px;
      border-bottom: 2px dashed var(--gray-700);
    }
    h3 {
      font-family: var(--font-pixel);
      font-size: 0.55rem;
      color: var(--accent);
      text-transform: uppercase;
    }
    .pw {
      display: grid;
      gap: 10px;
    }
    .pw .btn {
      justify-self: start;
    }
    .line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 14px;
    }
    .err {
      font-size: 0.8rem;
      color: var(--danger, #e57373);
    }
  `,
})
export class AccountSecurity {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly brew = inject(Brew);
  protected readonly auth = inject(Auth);

  protected readonly providers = resource({ loader: () => this.api.authProviders() });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly form = inject(NonNullableFormBuilder).group({
    current: [''],
    next: ['', Validators.required],
  });

  protected async savePassword(): Promise<void> {
    const { current, next } = this.form.getRawValue();
    if (!next) {
      this.error.set('Enter a new password.');
      return;
    }
    await this.run(async () => {
      await this.api.changePassword(current, next);
      this.form.reset();
      await this.auth.restore();
      this.toasts.show('Password saved. Other devices have been signed out.');
    });
  }

  protected async unlink(): Promise<void> {
    await this.run(async () => {
      await this.api.unlinkGoogle();
      await this.auth.restore();
      this.toasts.show('Google sign-in removed.');
    });
  }

  protected async signOutEverywhere(): Promise<void> {
    await this.run(async () => {
      this.brew.dialog.set(null);
      await this.auth.logoutEverywhere();
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await action();
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
