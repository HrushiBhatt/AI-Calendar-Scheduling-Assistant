import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { LiveEvent } from './models';

const EVENT_TYPES: LiveEvent['type'][] = [
  'timer',
  'session.completed',
  'session.discarded',
  'break.completed',
  'session.reflected',
  'changed',
  'calendar.synced',
  'plan.proposed',
  'plan.accepted',
  'plan.conflict',
  'scheduled.starting',
];

/**
 * The server's live stream (Server-Sent Events). Every tab and device signed in to
 * the same account receives the same events, which keeps them in sync. EventSource
 * reconnects on its own, and the server opens each connection with a fresh snapshot.
 */
@Injectable({ providedIn: 'root' })
export class LiveEvents {
  private source?: EventSource;
  private readonly subject = new Subject<LiveEvent>();

  readonly events$ = this.subject.asObservable();
  readonly connected = signal(false);

  connect(): void {
    if (this.source) return;
    const source = new EventSource('/api/events'); // same origin, so the login cookie goes along
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (e) =>
        this.subject.next({ type, data: JSON.parse((e as MessageEvent<string>).data) } as LiveEvent),
      );
    }
    source.onopen = () => this.connected.set(true);
    source.onerror = () => this.connected.set(source.readyState === EventSource.OPEN);
    this.source = source;
  }

  disconnect(): void {
    this.source?.close();
    this.source = undefined;
    this.connected.set(false);
  }
}
