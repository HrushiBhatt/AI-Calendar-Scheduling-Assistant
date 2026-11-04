import { ChangeDetectionStrategy, Component, computed, inject, resource, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Api, errorMessage } from '../core/api';
import { Auth } from '../core/auth';
import { GoogleLogo } from '../shared/google-logo';
import { PixelMug } from '../shared/pixel-mug';
import { ThemeToggle } from '../shared/theme-toggle';

/** Why the server sent the browser back here from Google, by the code in ?error=. */
const SIGN_IN_ERRORS: Record<string, string> = {
  denied: 'Google sign-in cancelled',
  expired: 'That took too long. Try again.',
  failed: "Couldn't sign in with Google",
  unverified: "Google hasn't verified that email",
  account_exists: 'That email has an account. Log in with your password, then add Google in Settings.',
};

const MIN_NEW_PASSWORD = 12;

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, PixelMug, GoogleLogo, ThemeToggle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
})
export class LoginPage {
  private readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  protected readonly providers = resource({ loader: () => this.api.authProviders() });
  /** Whether the server has Google sign-in; null until it answers, and if it can't be reached. */
  protected readonly google = computed(() => (this.providers.hasValue() ? this.providers.value().google : null));
  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly error = signal(SIGN_IN_ERRORS[inject(ActivatedRoute).snapshot.queryParamMap.get('error') ?? ''] ?? '');
  protected readonly busy = signal(false);
  protected readonly minPassword = MIN_NEW_PASSWORD;
  // No length rule at sign-in: an account may predate the current one. The server is the
  // judge of a new password's strength; this only saves a round trip on the obvious case.
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', Validators.maxLength(60)],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  protected switchTo(mode: 'login' | 'register'): void {
    this.mode.set(mode);
    this.error.set('');
  }

  protected async submit(): Promise<void> {
    const { name, email, password } = this.form.getRawValue();
    const registering = this.mode() === 'register';
    if (this.form.invalid || (registering && [...password].length < MIN_NEW_PASSWORD)) {
      this.form.markAllAsTouched();
      this.error.set(
        registering
          ? `Valid email, ${MIN_NEW_PASSWORD}+ character password`
          : 'Enter your email and password',
      );
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      if (registering) await this.auth.register(email, password, name);
      else await this.auth.login(email, password);
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set(errorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }
}
