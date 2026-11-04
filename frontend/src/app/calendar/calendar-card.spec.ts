import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { CalendarAccount, CalendarAccounts, LiveEvent, User } from '../core/models';
import { CalendarCard } from './calendar-card';

const KEY = 'brew:calendar-prompt-dismissed';
const user = { id: 1, email: 'a@b.co', name: 'A', settings: { timeZone: 'UTC' } } as User;
const none: CalendarAccounts = { configured: true, provider: 'google', accounts: [] };
const account = (over: Partial<CalendarAccount> = {}): CalendarAccount => ({
  id: 1, provider: 'google', external_id: 'ada@gmail.com', last_sync_at: null, sync_error: '', created_at: '', ...over,
});

async function open(state: CalendarAccounts) {
  TestBed.configureTestingModule({
    imports: [CalendarCard],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set(user);
  const fixture = TestBed.createComponent(CalendarCard);
  fixture.detectChanges();
  TestBed.tick(); // starts the resource's request; whenStable would wait on it forever
  TestBed.inject(HttpTestingController).expectOne('/api/calendar/accounts').flush(state);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('CalendarCard', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('offers Google Calendar, with the logo, when nothing is connected', async () => {
    const { el } = await open(none);
    const button = el.querySelector<HTMLButtonElement>('button.gbtn')!;
    expect(button.textContent).toContain('Connect Google Calendar');
    expect(button.disabled).toBe(false);
    expect(button.querySelector('app-google-logo svg')).not.toBeNull();
    expect(el.textContent).not.toContain('Not set up');
  });

  it("still shows the button without keys, disabled, and says what's missing", async () => {
    const { el } = await open({ configured: false, provider: '', accounts: [] });
    expect(el.querySelector<HTMLButtonElement>('button.gbtn')?.disabled).toBe(true);
    expect(el.textContent).toContain('Add the Google keys to .env');
  });

  it('says nothing once a calendar is connected and syncing', async () => {
    const { el } = await open({ ...none, accounts: [account()] });
    expect(el.querySelector('section')).toBeNull();
  });

  it('speaks up when access has stopped working', async () => {
    const { el } = await open({ ...none, accounts: [account({ sync_error: 'Google access was revoked or has expired.' })] });
    expect(el.querySelector('[role=alert]')?.textContent).toContain('revoked or has expired');
  });

  it("doesn't count the demo account's sample calendar as connected", async () => {
    const { el } = await open({ ...none, accounts: [account({ provider: 'demo', external_id: 'demo@brewfocus.dev' })] });
    expect(el.querySelector('button.gbtn')?.textContent).toContain('Connect Google Calendar');
  });

  it('remembers being dismissed', async () => {
    const { el, fixture } = await open(none);
    el.querySelector<HTMLButtonElement>('.dismiss')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('section')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('true');
    TestBed.resetTestingModule();
    expect((await open(none)).el.querySelector('section')).toBeNull();
  });
});
