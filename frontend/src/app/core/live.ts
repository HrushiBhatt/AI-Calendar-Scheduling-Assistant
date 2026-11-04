import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Subject, Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { Api } from './api';
import { Auth } from './auth';
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
 * It gives up when a reconnect is refused, which usually means the session was ended from
 * another device, so that case asks the server rather than leaving a stale page open.
 * In the GitHub Pages demo the same events come from the in-browser backend instead.
 */
@Injectable({ providedIn: 'root' })
export class LiveEvents {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private source?: EventSource;
  private wanted = false;
  private localEvents?: Subscription;
  private readonly localStream = environment.localEvents?.(); // the Pages demo's in-browser backend
  private readonly subject = new Subject<LiveEvent>();

  readonly events$ = this.subject.asObservable();
  readonly connected = signal(false);
  /** True when the backend runs in this browser (the GitHub Pages demo). */
  readonly isLocal = environment.browserBackend;

  connect(): void {
    this.wanted = true;
    if (this.localStream) {
      this.localEvents ??= this.localStream.subscribe((e) => this.subject.next(e));
      this.connected.set(true);
      return;
    }
    if (this.source) return;
    const source = new EventSource('/api/events'); // same origin, so the login cookie goes along
    for (const type of EVENT_TYPES) {
      source.addEventListener(type, (e) =>
        this.subject.next({ type, data: JSON.parse((e as MessageEvent<string>).data) } as LiveEvent),
      );
    }
    source.onopen = () => this.connected.set(true);
    source.onerror = () => {
      this.connected.set(source.readyState === EventSource.OPEN);
      if (source.readyState === EventSource.CLOSED) void this.recheck();
    };
    this.source = source;
  }

  disconnect(): void {
    this.wanted = false;
    this.localEvents?.unsubscribe();
    this.localEvents = undefined;
    this.close();
  }

  private async recheck(): Promise<void> {
    this.close();
    try {
      await this.api.me();
    } catch (err) {
      if (err instanceof HttpErrorResponse && err.status === 401) {
        if (this.wanted) this.auth.expire();
        return;
      }
    }
    setTimeout(() => {
      if (this.wanted) this.connect();
    }, 5000); // the server was briefly unwell, not the session
  }

  private close(): void {
    this.source?.close();
    this.source = undefined;
    this.connected.set(false);
  }
}
