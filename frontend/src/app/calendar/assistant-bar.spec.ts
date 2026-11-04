import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Assistant } from '../core/assistant';
import { Auth } from '../core/auth';
import { LiveEvents } from '../core/live';
import { LiveEvent, User } from '../core/models';
import { AssistantBar } from './assistant-bar';

@Component({ template: '' })
class Blank {}

function open(assistantAvailable: boolean, assistantEnabled = true) {
  TestBed.configureTestingModule({
    imports: [AssistantBar],
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: 'plan', component: Blank }]),
      { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
    ],
  });
  TestBed.inject(Auth).user.set({
    id: 1,
    settings: { timeZone: 'UTC', assistantEnabled },
    assistant_available: assistantAvailable,
  } as User);
  const fixture = TestBed.createComponent(AssistantBar);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const send = (text: string) => {
    const input = el.querySelector<HTMLInputElement>('#plan-text')!;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    return input;
  };
  return { fixture, el, send, http: TestBed.inject(HttpTestingController) };
}

/** Lets the answer arrive. whenStable would wait on the page's other requests, left open here. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('AssistantBar', () => {
  it('asks Claude when the server has a key', () => {
    const { el } = open(true);
    expect(el.querySelector('#plan-text')?.getAttribute('placeholder')).toContain('Claude');
    expect(el.querySelector('button.send')?.getAttribute('aria-label')).toBe('Plan with Claude');
    expect(el.querySelector('.setup')).toBeNull();
    expect(el.querySelector('.options')).toBeNull(); // the form stays out of the way until asked for
  });

  it("offers the form without a key, and says what's missing", () => {
    const { el, fixture } = open(false);
    expect(el.querySelector('#plan-text')).toBeNull();
    expect(el.querySelector('.setup')?.textContent).toContain('ANTHROPIC_API_KEY');
    el.querySelector<HTMLButtonElement>('button.plain')!.click();
    fixture.detectChanges();
    expect(el.querySelector('.options .btn-primary')?.textContent).toContain('Plan it');
  });

  it("doesn't nag when the user turned it off themselves", () => {
    const { el } = open(true, false);
    expect(el.querySelector('#plan-text')).toBeNull();
    expect(el.querySelector('.setup')).toBeNull();
  });

  it('opens the plan screen as soon as a command is sent', async () => {
    const { send, http } = open(true);
    send('three blocks tomorrow');
    await settle();
    expect(TestBed.inject(Router).url).toBe('/plan');
    expect(TestBed.inject(Assistant).asked()).toBe('three blocks tomorrow');
    const req = http.expectOne('/api/assistant/plan');
    expect(req.request.body).toEqual({ text: 'three blocks tomorrow' });
  });

  it('keeps the words if the request fails', async () => {
    const { send, http, fixture } = open(true);
    const input = send('three blocks tomorrow');
    http.expectOne('/api/assistant/plan').flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await settle();
    fixture.detectChanges();
    expect(input.value).toBe('three blocks tomorrow');
  });

  it("passes on the answer when the request wasn't about planning", async () => {
    const { send, http } = open(true);
    send('hello');
    http.expectOne('/api/assistant/plan').flush({ plan: null, narration: 'I plan focus time.', degraded: false });
    await settle();
    expect(TestBed.inject(Assistant).reply()).toBe('I plan focus time.');
  });
});
