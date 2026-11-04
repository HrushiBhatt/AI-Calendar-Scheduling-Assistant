import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { LiveEvent, User } from '../core/models';
import { PlanComposer } from './plan-composer';

function open(assistantAvailable: boolean) {
  TestBed.configureTestingModule({
    imports: [PlanComposer],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set({
    id: 1,
    settings: { timeZone: 'UTC', assistantEnabled: true },
    assistant_available: assistantAvailable,
  } as User);
  const fixture = TestBed.createComponent(PlanComposer);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('PlanComposer', () => {
  it('offers Claude when the server has a key', () => {
    const el = open(true);
    expect(el.querySelector('#compose-title')?.textContent).toContain('Plan with Claude');
    expect(el.querySelector('#plan-text')).not.toBeNull();
    expect(el.querySelector('form .btn-primary')?.textContent).toContain('Plan with Claude');
    expect(el.textContent).toContain('It never picks a time');
    expect(el.querySelector('.setup')).toBeNull();
  });

  it("falls back to the form without a key, and says what's missing", () => {
    const el = open(false);
    expect(el.querySelector('#compose-title')?.textContent).toContain('Plan focus time');
    expect(el.querySelector('#plan-text')).toBeNull();
    expect(el.querySelector('.switch-mode')).toBeNull();
    expect(el.querySelector('.setup')?.textContent).toContain('ANTHROPIC_API_KEY');
    expect(el.querySelector('form .btn-primary')?.textContent).toContain('Plan it');
  });
});
