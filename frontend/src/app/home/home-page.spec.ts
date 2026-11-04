import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { LiveEvent, User } from '../core/models';
import { HomePage } from './home-page';

describe('HomePage', () => {
  it('greets the user and offers a door to each part of the app', () => {
    TestBed.configureTestingModule({
      imports: [HomePage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
      ],
    });
    TestBed.inject(Auth).user.set({ id: 1, name: 'Ada', settings: { timeZone: 'UTC' } } as User);
    const fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.greeting')?.textContent).toMatch(/Good (morning|afternoon|evening), Ada/);
    expect([...el.querySelectorAll('a.door')].map((a) => a.getAttribute('href'))).toEqual(['/calendar', '/focus', '/progress']);
  });
});
