import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { CalendarAccounts, LiveEvent, User } from '../core/models';
import { ConnectPrompt } from './connect-prompt';

const KEY = 'brew:calendar-prompt-dismissed';
const none: CalendarAccounts = { configured: true, provider: 'google', accounts: [] };

async function open(state: CalendarAccounts) {
  TestBed.configureTestingModule({
    imports: [ConnectPrompt],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set({ id: 1, settings: { timeZone: 'UTC' } } as User);
  const fixture = TestBed.createComponent(ConnectPrompt);
  fixture.detectChanges();
  TestBed.tick(); // starts the resource's request; whenStable would wait on it forever
  TestBed.inject(HttpTestingController).expectOne('/api/calendar/accounts').flush(state);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ConnectPrompt', () => {
  beforeEach(() => localStorage.removeItem(KEY));
  afterEach(() => localStorage.removeItem(KEY));

  it('offers to connect once the server can', async () => {
    const { el } = await open(none);
    expect(el.querySelector('button.gbtn')?.textContent).toContain('Connect Google Calendar');
  });

  it('stays out of the way without keys, and once connected', async () => {
    expect((await open({ configured: false, provider: '', accounts: [] })).el.querySelector('aside')).toBeNull();
    TestBed.resetTestingModule();
    const account = { id: 1, provider: 'google', external_id: 'a@b.co', last_sync_at: null, sync_error: '', created_at: '' };
    expect((await open({ ...none, accounts: [account] })).el.querySelector('aside')).toBeNull();
  });

  it('remembers "Not now"', async () => {
    const { el, fixture } = await open(none);
    el.querySelector<HTMLButtonElement>('button.btn-sm')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('aside')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('true');
    TestBed.resetTestingModule();
    expect((await open(none)).el.querySelector('aside')).toBeNull();
  });
});
