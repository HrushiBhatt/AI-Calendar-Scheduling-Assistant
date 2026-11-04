import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { LoginPage } from './login-page';

async function open(query: Record<string, string> = {}, providers: { google: boolean } | 'unreachable' = { google: false }) {
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
    ],
  });
  const fixture = TestBed.createComponent(LoginPage);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  TestBed.tick(); // starts the resource's request; whenStable would wait on it forever
  const req = http.expectOne('/api/auth/providers');
  if (providers === 'unreachable') req.flush('', { status: 502, statusText: 'Bad Gateway' });
  else req.flush(providers);
  await fixture.whenStable();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const fill = (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const submit = async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    fixture.detectChanges();
  };
  return { fixture, http, el, fill, submit };
}

describe('LoginPage', () => {
  it('signs in with Google, with the logo, when the server has it', async () => {
    const { el } = await open({}, { google: true });
    const link = el.querySelector<HTMLAnchorElement>('a.google')!;
    expect(link.getAttribute('href')).toBe('/api/auth/google/start');
    expect(link.textContent).toContain('Sign in with Google');
    expect(link.querySelector('app-google-logo svg')).not.toBeNull();
    expect(el.textContent).not.toContain('Not set up');
  });

  it("names the action on the sign-up tab", async () => {
    const { el, fixture } = await open({}, { google: true });
    el.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click();
    fixture.detectChanges();
    expect(el.querySelector('a.google')?.textContent).toContain('Sign up with Google');
  });

  it("still shows Google without keys, disabled, and says what's missing", async () => {
    const { el } = await open();
    expect(el.querySelector('a.google')).toBeNull();
    const button = el.querySelector<HTMLButtonElement>('button.google-off')!;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('app-google-logo svg')).not.toBeNull();
    expect(el.textContent).toContain('Not set up yet');
  });

  it('keeps the page working when the server can\'t be reached', async () => {
    const { el } = await open({}, 'unreachable');
    expect(el.querySelector<HTMLButtonElement>('button.google-off')?.disabled).toBe(true);
    expect(el.textContent).toContain("Can't reach the server");
    expect(el.querySelector('input[type=email]')).not.toBeNull();
  });

  it("explains why Google sent someone back, and ignores codes it doesn't know", async () => {
    const { el } = await open({ error: 'account_exists' });
    expect(el.querySelector('[role=alert]')?.textContent).toContain('Log in with your password');
    TestBed.resetTestingModule();
    const unknown = await open({ error: '<img src=x onerror=alert(1)>' });
    expect(unknown.el.querySelector('[role=alert]')).toBeNull();
  });

  it('lets an old short password through at sign-in', async () => {
    const { http, fill, submit } = await open();
    fill('input[type=email]', 'demo@brewfocus.dev');
    fill('input[type=password]', 'brewfocus');
    await submit();
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ email: 'demo@brewfocus.dev', password: 'brewfocus' });
    req.flush({ id: 1 });
  });

  it('holds a short new password back at sign-up', async () => {
    const { el, http, fixture, fill, submit } = await open();
    el.querySelectorAll<HTMLButtonElement>('[role=tab]')[1].click();
    fixture.detectChanges();
    fill('input[type=email]', 'ada@example.com');
    fill('input[type=password]', 'too short');
    await submit();
    http.expectNone('/api/auth/register');
    expect(el.querySelector('[role=alert]')?.textContent).toContain('at least 12');
  });
});
