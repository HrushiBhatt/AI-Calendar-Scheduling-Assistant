import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from '../../core/auth/auth';
import { LiveEvents } from '../../core/api/live';
import { LiveEvent, User } from '../../core/api/models';
import { AccountSecurity } from './account-security';

const account = (over: Partial<User> = {}) => ({ id: 1, email: 'a@b.co', name: 'A', settings: {}, has_password: true, google_linked: false, ...over }) as User;

async function open(user: User, providers = { google: true }) {
  TestBed.configureTestingModule({
    imports: [AccountSecurity],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set(user);
  const fixture = TestBed.createComponent(AccountSecurity);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  TestBed.tick(); // starts the resource's request; whenStable would wait on it forever
  http.expectOne('/api/auth/providers').flush(providers);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, http, el: fixture.nativeElement as HTMLElement };
}

describe('AccountSecurity', () => {
  it('asks for the current password when there is one', async () => {
    const { el } = await open(account());
    expect(el.querySelector('input[autocomplete=current-password]')).not.toBeNull();
    expect(el.textContent).toContain('Change password');
  });

  it("doesn't ask a Google-only account for a password it doesn't have", async () => {
    const { el } = await open(account({ has_password: false, google_linked: true }));
    expect(el.querySelector('input[autocomplete=current-password]')).toBeNull();
    expect(el.textContent).toContain('Set password');
  });

  it('links to Google, or offers to remove it once connected', async () => {
    const off = await open(account());
    expect(off.el.querySelector('a[href="/api/auth/google/link"]')).not.toBeNull();
    TestBed.resetTestingModule();
    const on = await open(account({ google_linked: true }));
    expect(on.el.querySelector('a[href="/api/auth/google/link"]')).toBeNull();
    expect(on.el.querySelector('button[aria-label="Remove Google sign-in"]')).not.toBeNull();
  });

  it('hides Google when the server has none', async () => {
    const { el } = await open(account(), { google: false });
    expect(el.textContent).not.toContain('Google');
  });

  it("sends the change and shows the server's reason when refused", async () => {
    const { el, http, fixture } = await open(account());
    const set = (selector: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('input[autocomplete=current-password]', 'old one');
    set('input[autocomplete=new-password]', 'password1234');
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne('/api/me/password');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ current: 'old one', new: 'password1234' });
    req.flush({ error: 'that password is too easy to guess' }, { status: 400, statusText: 'Bad Request' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('too easy');
  });
});
