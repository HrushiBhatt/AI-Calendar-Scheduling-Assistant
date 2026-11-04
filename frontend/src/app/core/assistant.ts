import { DestroyRef, Injectable, computed, inject, resource, signal } from '@angular/core';
import { Api, errorMessage } from './api';
import { Auth } from './auth';
import { LiveEvents } from './live';
import { LiveEvent, PlanRequest, PlanResponse, PlanView, UnplacedReason } from './models';
import { Toasts } from './toast';

/** Live events after which the open proposals are stale. */
const STALE: LiveEvent['type'][] = ['plan.proposed', 'plan.accepted', 'plan.conflict'];

export const UNPLACED_TEXT: Record<UnplacedReason, string> = {
  no_gap_long_enough: 'no gap long enough',
  day_cap_reached: 'daily limit reached',
  due_date_passed: 'due date passed',
  no_slot_before_due: 'no time before it’s due',
  total_blocks_reached: 'plan is full',
};

/**
 * Planning requests and the open proposals. Proposals are server-owned like the timer:
 * this fetches them, and refetches whenever the server says something changed, from
 * this tab or any other.
 */
@Injectable({ providedIn: 'root' })
export class Assistant {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly toasts = inject(Toasts);

  /** The open proposals: the latest regular one and the latest conflict re-plan. */
  readonly live = resource({
    params: () => this.auth.user()?.id,
    loader: () => this.api.livePlans(),
  });
  // A failed request's value throws when read, and the calendar reads these on every render.
  private readonly plans = computed(() => (this.live.hasValue() ? this.live.value() : []));
  readonly proposal = computed(() => this.plans().find((p) => p.source !== 'conflict') ?? null);
  readonly conflict = computed(() => this.plans().find((p) => p.source === 'conflict') ?? null);

  readonly pending = signal(false);
  /** The words behind the current request, shown while the plan is being made. */
  readonly asked = signal('');
  /** What the model said when it didn't make a plan (the request wasn't about planning). */
  readonly reply = signal('');
  /** The last response's extras, which belong to that request rather than to the plan. */
  readonly last = signal<Pick<PlanResponse, 'degraded' | 'notice' | 'usage'> | null>(null);
  /** Whether this server has a model at all: an Anthropic key, or the demo's phrase matcher. */
  readonly available = computed(() => this.auth.user()?.assistant_available ?? false);
  readonly enabled = computed(() => this.available() && (this.auth.user()?.settings.assistantEnabled ?? true));

  constructor() {
    const sub = inject(LiveEvents).events$.subscribe((e) => {
      if (STALE.includes(e.type) || (e.type === 'changed' && e.data.kind === 'schedule')) this.refresh();
      if (e.type === 'plan.conflict') {
        const n = e.data.block_ids.length;
        this.toasts.show(`A meeting moved onto ${n === 1 ? 'a block' : n + ' blocks'}. Replacement ready.`);
      }
    });
    inject(DestroyRef).onDestroy(() => sub.unsubscribe());
  }

  refresh(): void {
    if (this.live.status() !== 'idle') this.live.reload();
  }

  /** Accept the picked blocks of a proposal (all of them when none were unticked). */
  async accept(plan: PlanView, excluded: ReadonlySet<number>): Promise<boolean> {
    const picked = plan.blocks.filter((b) => !excluded.has(b.id)).map((b) => b.id);
    return this.decide(async () => {
      await this.api.acceptPlan(plan.id, picked.length === plan.blocks.length ? undefined : picked);
      this.toasts.show(picked.length === 1 ? 'Block scheduled' : `${picked.length} blocks scheduled`);
    });
  }

  async reject(plan: PlanView): Promise<boolean> {
    return this.decide(() => this.api.rejectPlan(plan.id));
  }

  private async decide(fn: () => Promise<unknown>): Promise<boolean> {
    this.pending.set(true);
    try {
      await fn();
      this.last.set(null);
      this.refresh();
      return true;
    } catch (err) {
      this.toasts.show(errorMessage(err));
      this.refresh(); // a 409 may mean the plan changed under us
      return false;
    } finally {
      this.pending.set(false);
    }
  }

  /** Ask for a plan. Resolves to the response, or null when the request failed (with a toast). */
  async request(req: PlanRequest): Promise<PlanResponse | null> {
    this.pending.set(true);
    try {
      const res = await this.api.requestPlan(req);
      this.last.set({ degraded: res.degraded, notice: res.notice, usage: res.usage });
      // Show the new plan now, so the plan screen never passes through "nothing to review" on
      // its way there. It replaced any earlier proposal; a conflict's replacement stays open.
      const plan = res.plan;
      if (plan) this.live.set([...this.plans().filter((p) => p.source === 'conflict'), plan]);
      this.refresh();
      return res;
    } catch (err) {
      this.toasts.show(errorMessage(err));
      return null;
    } finally {
      this.pending.set(false);
    }
  }
}
