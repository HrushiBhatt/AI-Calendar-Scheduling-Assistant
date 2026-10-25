import { ChangeDetectionStrategy, Component, booleanAttribute, computed, input } from '@angular/core';
import { ScheduledBlock } from '../core/models';
import { formatTime } from '../core/zoned';

const STATUS_LABEL: Record<string, string> = {
  proposed: 'proposed',
  accepted: 'planned',
  started: 'brewing',
  done: 'done',
  conflicted: 'conflict',
  skipped: 'skipped',
  rejected: 'rejected',
};

/**
 * One focus block on the timeline: the focus part solid, the rest as a lighter tail.
 * Proposed blocks are dashed and striped, accepted ones solid, conflicts in red.
 */
@Component({
  selector: 'app-block-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="focus" [style.flex-grow]="block().focus_min">
      @if (!compact()) {
        <span class="tag">{{ statusLabel() }}</span>
      }
      <span class="title">
        @if (compact()) {
          <span class="tag">{{ statusLabel() }}</span>
        }
        {{ block().intention || 'Focus block' }}
      </span>
      <span class="when">{{ range() }} · {{ block().mode }}</span>
    </div>
    @if (block().rest_min) {
      <div class="rest" [style.flex-grow]="block().rest_min" aria-hidden="true">{{ block().rest_min >= 10 ? 'rest ' + block().rest_min + 'm' : '' }}</div>
    }
    @if (block().explain || block().note) {
      <div class="explain" role="tooltip">
        @if (block().note) {
          <b>{{ block().note }}</b>
        }
        {{ block().explain }}
      </div>
    }
  `,
  styles: `
    :host {
      --bd: var(--accent);
      display: flex;
      flex-direction: column;
      min-height: 18px;
      color: var(--black);
      background: var(--accent);
      box-shadow:
        0 -3px var(--bd),
        0 3px var(--bd),
        -3px 0 var(--bd),
        3px 0 var(--bd);
      cursor: default;
      touch-action: none;
      user-select: none;
    }
    :host([data-status="proposed"]) {
      --bd: var(--accent-bright);
      color: var(--cream-light);
      background: repeating-linear-gradient(-45deg, var(--accent-soft) 0 6px, rgba(212, 165, 116, 0.22) 6px 12px);
      outline: 2px dashed var(--accent-bright);
      outline-offset: -2px;
    }
    :host([data-status="conflicted"]) {
      --bd: var(--danger);
      color: var(--cream-light);
      background: repeating-linear-gradient(-45deg, rgba(239, 83, 80, 0.18) 0 6px, rgba(239, 83, 80, 0.32) 6px 12px);
    }
    :host([data-status="started"]) {
      --bd: var(--break);
      background: var(--break);
    }
    :host([data-status="done"]) {
      --bd: var(--gray-600);
      color: var(--gray-300);
      background: var(--gray-700);
    }
    :host(.draggable) {
      cursor: grab;
    }
    :host(.dragging) {
      cursor: grabbing;
      opacity: 0.85;
      z-index: 5;
    }
    :host(:focus-visible) {
      outline: 2px dashed var(--cream-light);
      outline-offset: 5px;
      z-index: 4;
    }
    .focus {
      display: grid;
      align-content: start;
      gap: 2px;
      min-height: 0;
      padding: 4px 8px;
      overflow: hidden;
    }
    .tag {
      font-family: var(--font-pixel);
      font-size: 0.42rem;
      text-transform: uppercase;
      opacity: 0.8;
    }
    :host(.compact) .focus {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      align-content: center;
      gap: 8px;
      padding-block: 0;
    }
    :host(.compact) .tag {
      margin-right: 6px;
    }
    .title {
      overflow: hidden;
      font-size: 0.8rem;
      font-weight: 700;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .when {
      font-size: 0.68rem;
      opacity: 0.85;
      white-space: nowrap;
    }
    .rest {
      display: flex;
      align-items: center;
      min-height: 0;
      padding: 0 8px;
      overflow: hidden;
      font-size: 0.6rem;
      color: var(--gray-300);
      background: repeating-linear-gradient(90deg, var(--gray-800) 0 4px, var(--gray-850) 4px 8px);
    }
    .explain {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 10;
      display: none;
      width: max(100%, 240px);
      max-width: 320px;
      padding: 8px 10px;
      font-size: 0.75rem;
      line-height: 1.4;
      color: var(--cream-light);
      background: var(--gray-800);
      box-shadow:
        0 -3px var(--gray-600),
        0 3px var(--gray-600),
        -3px 0 var(--gray-600),
        3px 0 var(--gray-600);
      pointer-events: none;
    }
    .explain b {
      display: block;
      color: var(--danger);
    }
    :host(:hover) .explain,
    :host(:focus-visible) .explain {
      display: block;
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
  /** One line instead of three, for a block too short to fit them. */
  readonly compact = input(false, { transform: booleanAttribute });

  protected readonly statusLabel = computed(() => STATUS_LABEL[this.block().status] ?? this.block().status);
  protected readonly range = computed(() => {
    const b = this.block();
    const start = Date.parse(b.starts_at);
    return `${formatTime(start, this.zone())}–${formatTime(start + b.focus_min * 60_000, this.zone())}`;
  });
}
