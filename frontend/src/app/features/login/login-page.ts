import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { errorMessage } from '../../core/api/api';
import { Auth } from '../../core/auth/auth';
import { PixelMug } from '../../shared/pixel-art/pixel-mug';

const MIN_NEW_PASSWORD = 12;

/**
 * The first thing a signed-out visitor sees. The server checks the password, then sets the JWT in
 * an HttpOnly cookie, so this page never sees or stores a token.
 */
@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, PixelMug],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
})
export class LoginPage {
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly error = signal('');
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
      this.error.set(registering ? `Enter a valid email and a password of at least ${MIN_NEW_PASSWORD} characters.` : 'Enter your email and password.');
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
