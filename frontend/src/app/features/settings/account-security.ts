import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Api, errorMessage } from '../../core/api/api';
import { Auth } from '../../core/auth/auth';
import { Brew } from '../../core/state/brew';
import { Toasts } from '../../core/state/toast';
import { GoogleLogo } from '../../shared/google-logo';

/** The account part of the settings dialog: password, Google sign-in, signed-in devices. */
@Component({
  selector: 'app-account-security',
  imports: [ReactiveFormsModule, GoogleLogo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="group" aria-label="Account security">
      <form class="pw" [formGroup]="form" (ngSubmit)="savePassword()">
        @if (auth.user()?.has_password) {
          <label class="field">
            Current password
            <input class="input px" type="password" formControlName="current" autocomplete="current-password" />
          </label>
        }
        <label class="field">
          New password
          <input class="input px" type="password" formControlName="next" autocomplete="new-password" placeholder="12+ characters" />
        </label>
        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }
        <button class="btn btn-sm px" [disabled]="busy()">
          {{ auth.user()?.has_password ? 'Change password' : 'Set password' }}
        </button>
      </form>

      @if ((providers.hasValue() && providers.value().google) || auth.user()?.google_linked) {
        <div class="line">
          @if (auth.user()?.google_linked) {
            <span>Google sign-in on</span>
            <button class="btn btn-sm px" (click)="unlink()" [disabled]="busy()" aria-label="Remove Google sign-in">Remove</button>
          } @else {
            <a class="gbtn" href="/api/auth/google/link"><app-google-logo />Connect Google sign-in</a>
          }
        </div>
      }

      <button class="btn btn-sm btn-danger px everywhere" (click)="signOutEverywhere()" [disabled]="busy()">Sign out everywhere</button>
    </section>
  `,
  styles: `
    .group {
      display: grid;
      gap: 16px;
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
      font-size: 0.875rem;
    }
    .everywhere {
      justify-self: start;
    }
    .err {
      font-size: 0.8rem;
      color: var(--danger);
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

  /** The server checks the current password and ends every other session once it changes. */
  protected async savePassword(): Promise<void> {
    const { current, next } = this.form.getRawValue();
    if (!next) {
      this.error.set('Enter a new password');
      return;
    }
    await this.run(async () => {
      await this.api.changePassword(current, next);
      this.form.reset();
      await this.auth.restore();
      this.toasts.show('Password saved. Other devices signed out.');
    });
  }

  protected async unlink(): Promise<void> {
    await this.run(async () => {
      await this.api.unlinkGoogle();
      await this.auth.restore();
      this.toasts.show('Google sign-in removed');
    });
  }

  protected async signOutEverywhere(): Promise<void> {
    await this.run(async () => {
      this.brew.dialog.set(null);
      await this.auth.logoutEverywhere();
    });
  }

  /** Runs one account action, showing its error here rather than as a toast. */
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
