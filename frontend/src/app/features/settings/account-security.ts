import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Api, errorMessage } from '../../core/api/api';
import { Auth } from '../../core/auth/auth';
import { Brew } from '../../core/state/brew';
import { Toasts } from '../../core/state/toast';

/** The account part of the settings dialog: changing the password, and signed-in devices. */
@Component({
  selector: 'app-account-security',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="group" aria-label="Account security">
      <form class="pw" [formGroup]="form" (ngSubmit)="savePassword()">
        <label class="field">
          Current password
          <input class="input px" type="password" formControlName="current" autocomplete="current-password" />
        </label>
        <label class="field">
          New password
          <input class="input px" type="password" formControlName="next" autocomplete="new-password" placeholder="12+ characters" />
        </label>
        @if (error()) {
          <p class="err" role="alert">{{ error() }}</p>
        }
        <button class="btn btn-sm px" [disabled]="busy()">Change password</button>
      </form>

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
