import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { Api } from './api';
import { User } from './models';
import { browserZone } from './time';

/** The signed-in user. The session itself is an HttpOnly cookie the browser manages. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  /** undefined until the first check, then the user or null. */
  readonly user = signal<User | null | undefined>(undefined);

  async restore(): Promise<User | null> {
    try {
      const user = await this.api.me();
      this.user.set(user);
      if (!user.settings.timeZone) await this.adoptBrowserZone(user);
    } catch {
      this.user.set(null);
    }
    return this.user()!;
  }

  /** An account made through Google has no time zone yet: sign-up can't ask the browser for one. */
  private async adoptBrowserZone(user: User): Promise<void> {
    const settings = await this.api.saveSettings({ ...user.settings, timeZone: browserZone() });
    this.user.set({ ...user, settings });
  }

  async login(email: string, password: string): Promise<void> {
    this.user.set(await this.api.login(email, password));
  }

  async register(email: string, password: string, name: string): Promise<void> {
    this.user.set(await this.api.register(email, password, name));
  }

  async logout(): Promise<void> {
    await this.api.logout().catch(() => undefined);
    this.expire();
  }

  /** End the session on every device, this one included. */
  async logoutEverywhere(): Promise<void> {
    await this.api.logoutEverywhere();
    this.expire();
  }

  /** Forget the user locally and go to the login page (e.g. after a 401). */
  expire(): void {
    this.user.set(null);
    void this.router.navigate(['/login']);
  }
}

/** Pages behind a login. */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router); // inject before awaiting: the injection context ends there
  const user = auth.user() === undefined ? await auth.restore() : auth.user();
  return user ? true : router.createUrlTree(['/login']);
};

/** The login page, only for signed-out visitors. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  const user = auth.user() === undefined ? await auth.restore() : auth.user();
  return user ? router.createUrlTree(['/']) : true;
};

/** An expired session on any request sends the user back to log in. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  return next(req).pipe(
    catchError((err: unknown) => {
      const isAuthCall = req.url.startsWith('/api/auth/') || req.url === '/api/me';
      if (err instanceof HttpErrorResponse && err.status === 401 && !isAuthCall && auth.user()) {
        auth.expire();
      }
      return throwError(() => err);
    }),
  );
};
