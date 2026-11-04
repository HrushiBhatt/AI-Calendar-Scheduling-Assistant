import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Assistant } from '../core/assistant';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { LiveEvent, User } from '../core/models';
import { PlanPage } from './plan-page';

function open() {
  TestBed.configureTestingModule({
    imports: [PlanPage],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set({ id: 1, settings: { timeZone: 'UTC' } } as User);
  const fixture = TestBed.createComponent(PlanPage);
  const assistant = TestBed.inject(Assistant);
  const el = fixture.nativeElement as HTMLElement;
  const show = () => {
    fixture.detectChanges();
    return el;
  };
  return { assistant, show };
}

describe('PlanPage', () => {
  it('shows the request while it is being worked on', () => {
    const { assistant, show } = open();
    assistant.asked.set('three blocks tomorrow');
    assistant.pending.set(true);
    const el = show();
    expect(el.querySelector('.thinking')?.textContent).toContain('three blocks tomorrow');
    expect(el.querySelector('app-calendar-board')).toBeNull();
  });

  it("shows the answer when the request wasn't about planning", () => {
    const { assistant, show } = open();
    assistant.reply.set('I plan focus time.');
    const el = show();
    expect(el.querySelector('.notice')?.textContent).toContain('I plan focus time.');
    expect(el.querySelector('a[href="/calendar"]')).not.toBeNull();
  });

  it('says so when there is nothing to review', () => {
    const el = open().show();
    expect(el.textContent).toContain('No plan to review');
    expect(el.querySelector('a[href="/calendar"]')).not.toBeNull();
  });
});
