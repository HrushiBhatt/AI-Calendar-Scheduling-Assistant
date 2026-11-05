import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LoginPage } from './login-page';

async function open() {
  TestBed.configureTestingModule({
    imports: [LoginPage],
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(LoginPage);
  const http = TestBed.inject(HttpTestingController);
  fixture.detectChanges();
  await fixture.whenStable();
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
  it('signs in with an email and password, and never handles a token itself', async () => {
    const { http, fill, submit } = await open();
    fill('input[type=email]', 'ada@example.com');
    fill('input[type=password]', 'correct horse battery');
    await submit();
    const req = http.expectOne('/api/auth/login');
    expect(req.request.body).toEqual({ email: 'ada@example.com', password: 'correct horse battery' });
    req.flush({ id: 1 }); // the JWT arrives as an HttpOnly cookie, which scripts can't see
  });

  it('asks for both fields', async () => {
    const { el, http, submit } = await open();
    await submit();
    http.expectNone('/api/auth/login');
    expect(el.querySelector('[role=alert]')?.textContent).toContain('email and password');
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

  it("shows the server's reason when it refuses", async () => {
    const { el, http, fixture, fill, submit } = await open();
    fill('input[type=email]', 'ada@example.com');
    fill('input[type=password]', 'wrong password');
    await submit();
    http.expectOne('/api/auth/login').flush({ error: 'wrong email or password' }, { status: 401, statusText: 'Unauthorized' });
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(el.querySelector('[role=alert]')?.textContent).toContain('wrong email or password');
  });
});
