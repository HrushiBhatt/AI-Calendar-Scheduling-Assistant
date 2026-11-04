import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { Api, errorMessage } from './api';
import { Assistant } from './assistant';
import { Brew } from './brew';
import { PlanView, ScheduledBlock } from './models';
import { Schedule } from './schedule';
import { Toasts } from './toast';
import { dayIn } from './zoned';

export interface BlockMove {
  block: ScheduledBlock;
  startsAt: number;
}

/**
 * What the calendar shows and what can be done to it, shared by the Calendar and Plan screens.
 * Proposed blocks are drawn on the same grid as meetings and accepted blocks, so a plan is
 * reviewed where the time actually is, and nothing is scheduled until it's accepted.
 */
@Injectable({ providedIn: 'root' })
export class Board {
  private readonly schedule = inject(Schedule);
  private readonly assistant = inject(Assistant);
  private readonly brew = inject(Brew);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);

  /** Where blocks being moved are drawn until the server answers. */
  private readonly moving = signal<ReadonlyMap<number, string>>(new Map());
  /** Blocks the user unticked in the review. Reset whenever a different plan arrives. */
  readonly excluded = signal<ReadonlySet<number>>(new Set());
  /** The block whose details are open. */
  readonly selectedId = signal<number | null>(null);

  /** Blocks that haven't started can move; the server has the final say. */
  readonly canMove = (b: ScheduledBlock) =>
    (b.status === 'proposed' || b.status === 'accepted' || b.status === 'conflicted') && Date.parse(b.starts_at) > Date.now();

  /** Accepted blocks on screen, plus any proposed ones that land there. */
  readonly blocks = computed(() => {
    const days = new Set(this.schedule.days());
    const accepted = this.schedule.shown()?.blocks ?? [];
    const proposed = [this.assistant.conflict(), this.assistant.proposal()]
      .filter((p): p is PlanView => !!p)
      .flatMap((p) => p.blocks)
      .filter((b) => b.status === 'proposed' && days.has(dayIn(b.starts_at, this.schedule.zone())));
    const moving = this.moving();
    return [...accepted, ...proposed].map((b) => (moving.has(b.id) ? { ...b, starts_at: moving.get(b.id)! } : b));
  });
  readonly selected = computed(() => this.blocks().find((b) => b.id === this.selectedId()) ?? null);

  constructor() {
    // A new proposal (from this tab or another) starts with every block ticked.
    const ids = computed(() => `${this.assistant.proposal()?.id}:${this.assistant.conflict()?.id}`);
    effect(() => {
      ids();
      untracked(() => this.excluded.set(new Set()));
    });
  }

  toggle(id: number): void {
    this.excluded.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Clicking a proposed block ticks or unticks it, like its checkbox. Others open their details. */
  activate(b: ScheduledBlock): void {
    if (b.status === 'proposed') this.toggle(b.id);
    else this.selectedId.update((id) => (id === b.id ? null : b.id));
  }

  /**
   * Draw the block at its new time at once, then ask the server. On a 409 it snaps back
   * and the toast says why; on success the refetch the server triggers takes over.
   */
  async move({ block, startsAt }: BlockMove): Promise<void> {
    const iso = new Date(startsAt).toISOString();
    this.moving.update((m) => new Map(m).set(block.id, iso));
    try {
      const saved = await this.api.moveBlock(block.id, iso);
      // Write the server's answer into both views now; the refetch it triggers confirms it.
      const swap = (b: ScheduledBlock) => (b.id === saved.id ? saved : b);
      this.schedule.shown.update((d) => d && { ...d, blocks: d.blocks.map(swap) });
      this.assistant.live.update((plans) => plans?.map((p) => ({ ...p, blocks: p.blocks.map(swap) })));
    } catch (err) {
      this.toasts.show(errorMessage(err));
    } finally {
      this.moving.update((m) => {
        const next = new Map(m);
        next.delete(block.id);
        return next;
      });
    }
  }

  async startBlock(b: ScheduledBlock): Promise<void> {
    try {
      this.brew.timer.apply(await this.api.startBlock(b.id));
      this.selectedId.set(null);
      await this.router.navigate(['/focus']);
    } catch (err) {
      this.toasts.show(errorMessage(err));
    }
  }

  async removeBlock(b: ScheduledBlock): Promise<void> {
    try {
      await this.api.dropBlock(b.id);
      this.selectedId.set(null);
      this.schedule.refresh();
      this.toasts.show('Removed');
    } catch (err) {
      this.toasts.show(errorMessage(err));
    }
  }

  /** Accept what's ticked, then show it on the calendar, unless another plan still needs a decision. */
  async accept(plan: PlanView): Promise<void> {
    const first = plan.blocks.find((b) => !this.excluded().has(b.id));
    const waiting = this.otherPlan(plan);
    if (!(await this.assistant.accept(plan, this.excluded()))) return;
    if (first) this.schedule.show(dayIn(first.starts_at, this.schedule.zone()));
    if (!waiting) await this.router.navigate(['/calendar']);
  }

  async reject(plan: PlanView): Promise<void> {
    const waiting = this.otherPlan(plan);
    if ((await this.assistant.reject(plan)) && !waiting) await this.router.navigate(['/calendar']);
  }

  private otherPlan(plan: PlanView): PlanView | null {
    return [this.assistant.conflict(), this.assistant.proposal()].find((p) => p && p.id !== plan.id) ?? null;
  }
}
