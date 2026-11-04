import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import { ScheduledBlock } from '../core/models';
import { formatTime } from '../core/zoned';

/**
 * One focus block on the calendar: the focus part solid, the rest as a lighter tail. Status
 * shows in the styling, not in words: proposed blocks are dashed and shimmer, accepted ones
 * solid, a running one glows green, and conflicts are red.
 */
@Component({
  selector: 'app-block-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="focus" [style.flex-grow]="block().focus_min">
      <span class="title">{{ block().intention || 'Focus' }}</span>
      <span class="when">{{ range() }}</span>
    </div>
    @if (block().rest_min) {
      <div class="rest" [style.flex-grow]="block().rest_min" aria-hidden="true"></div>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 16px;
      overflow: hidden;
      color: var(--accent-ink);
      background: var(--grad);
      border-radius: 7px;
      box-shadow: 0 2px 10px var(--chip-shadow);
      container-type: inline-size;
      cursor: pointer;
      user-select: none;
      transition: box-shadow 0.2s, filter 0.2s, opacity 0.25s, translate 0.18s var(--ease-out);
      animation: chip-in 0.45s var(--ease-spring) both;
      animation-delay: calc(var(--i, 0) * 45ms);
    }
    :host(:hover) {
      z-index: 3;
      filter: brightness(1.08);
      box-shadow: 0 6px 18px var(--chip-shadow);
    }
    :host(.selected) {
      z-index: 3;
      outline: 2px solid var(--text);
      outline-offset: 1px;
    }
    :host(.draggable) {
      cursor: grab;
      touch-action: none;
    }
    :host(.dragging) {
      z-index: 7;
      cursor: grabbing;
      box-shadow: 0 14px 34px var(--chip-shadow);
      transform: scale(1.02);
      transition: none;
    }
    :host([data-status='accepted']) {
      animation-name: chip-settle;
    }
    :host([data-status='proposed']) {
      color: var(--text);
      background: var(--accent-soft);
      outline: 1.5px dashed var(--accent);
      outline-offset: -1.5px;
      box-shadow: none;
    }
    :host([data-status='proposed'])::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(105deg, transparent 35%, var(--shimmer) 50%, transparent 65%);
      background-size: 240% 100%;
      animation: shimmer 2.6s ease-in-out infinite;
      pointer-events: none;
    }
    :host([data-status='conflicted']) {
      color: var(--text);
      background: var(--danger-soft);
      outline: 1.5px solid var(--danger);
      outline-offset: -1.5px;
    }
    :host([data-status='started']) {
      background: var(--grad-break);
      animation: chip-live 2.4s ease-in-out infinite;
    }
    :host([data-status='done']) {
      color: var(--text-2);
      background: var(--surface-3);
      box-shadow: none;
    }
    :host(:focus-visible) {
      z-index: 4;
      outline: 2px solid var(--text);
      outline-offset: 1px;
    }
    .focus {
      display: grid;
      align-content: start;
      gap: 1px;
      min-height: 0;
      padding: 4px 7px;
      overflow: hidden;
    }
    :host(.compact) .focus {
      display: flex;
      align-items: center;
      gap: 10px;
      padding-block: 0;
    }
    :host(.compact) .when {
      display: none;
    }
    /* A short block still has room for its time when the column is wide. */
    @container (min-width: 240px) {
      :host(.compact) .when {
        display: block;
      }
    }
    .title {
      overflow: hidden;
      font-size: 0.76rem;
      font-weight: 600;
      line-height: 1.25;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .when {
      overflow: hidden;
      font-size: 0.68rem;
      opacity: 0.8;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rest {
      min-height: 0;
      background: rgba(13, 10, 8, 0.28);
    }
    :host([data-status='proposed']) .rest {
      background: transparent;
    }
    @keyframes chip-in {
      from { opacity: 0; transform: translateY(8px) scale(0.94); }
    }
    @keyframes chip-settle {
      0% { transform: scale(0.97); box-shadow: 0 0 0 0 var(--accent-glow); }
      50% { transform: scale(1.015); box-shadow: 0 0 0 7px transparent; }
    }
    @keyframes chip-live {
      50% { box-shadow: 0 0 22px rgba(143, 209, 158, 0.55); }
    }
    @keyframes shimmer {
      from { background-position: 130% 0; }
      to { background-position: -30% 0; }
    }
  `,
  host: {
    '[attr.data-status]': 'block().status',
    '[class.compact]': 'compact()',
  },
})
export class BlockChip {
  readonly block = input.required<ScheduledBlock>();
  readonly zone = input.required<string>();
  /** The title alone, for a block too short to fit the time as well. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly range = computed(() => {
    const b = this.block();
    const start = Date.parse(b.starts_at);
    return `${formatTime(start, this.zone())}–${formatTime(start + b.focus_min * 60_000, this.zone())}`;
  });
}
