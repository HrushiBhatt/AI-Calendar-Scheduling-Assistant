import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { CalendarEvent, ScheduledBlock } from '../core/models';
import { dayIn, formatDay, formatWeekday, shiftDay, zonedInstant } from '../core/zoned';

/** How many items a day cell lists before it says "+2". */
const MAX_ITEMS = 3;

export interface MonthItem {
  key: string;
  title: string;
  kind: 'meeting' | 'focus' | 'proposed' | 'conflicted' | 'done';
  start: number;
}

export interface MonthCell {
  day: string;
  number: number;
  inMonth: boolean;
  items: MonthItem[];
  more: number;
  total: number;
}

const KIND: Partial<Record<ScheduledBlock['status'], MonthItem['kind']>> = {
  proposed: 'proposed',
  conflicted: 'conflicted',
  done: 'done',
};

/** Sort everything into its day. An event that spans days shows on each of them. */
export function monthCells(days: string[], month: string, zone: string, events: CalendarEvent[], blocks: ScheduledBlock[]): MonthCell[] {
  const byDay = new Map<string, MonthItem[]>(days.map((d) => [d, []]));
  for (const b of blocks) {
    byDay.get(dayIn(b.starts_at, zone))?.push({
      key: `b${b.id}`,
      title: b.intention || 'Focus',
      kind: KIND[b.status] ?? 'focus',
      start: Date.parse(b.starts_at),
    });
  }
  for (const e of events) {
    const start = Date.parse(e.starts_at);
    const end = Date.parse(e.ends_at);
    for (const day of days) {
      const from = zonedInstant(day, '00:00', zone);
      const to = zonedInstant(shiftDay(day, 1), '00:00', zone);
      if (start < to && end > from) {
        byDay.get(day)!.push({ key: `e${e.id}`, title: e.title || 'Busy', kind: 'meeting', start: e.all_day ? from - 1 : start });
      }
    }
  }
  return days.map((day) => {
    const all = byDay.get(day)!.sort((a, b) => a.start - b.start);
    return {
      day,
      number: Number(day.slice(8)),
      inMonth: day.slice(0, 7) === month,
      items: all.slice(0, MAX_ITEMS),
      more: Math.max(0, all.length - MAX_ITEMS),
      total: all.length,
    };
  });
}

/** The month view: every day at a glance. Choosing a day opens it. */
@Component({
  selector: 'app-month-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="month">
      <div class="dows" aria-hidden="true">
        @for (d of weekdays(); track d) {
          <span>{{ d }}</span>
        }
      </div>
      <div class="cells">
        @for (c of cells(); track c.day; let i = $index) {
          <button
            class="cell"
            [class.out]="!c.inMonth"
            [class.today]="c.day === today()"
            [style.--i]="i"
            [attr.data-day]="c.day"
            [attr.aria-label]="label(c)"
            (click)="openDay.emit(c.day)"
          >
            <span class="num">{{ c.number }}</span>
            <span class="items">
              @for (item of c.items; track item.key) {
                <span class="item" [attr.data-kind]="item.kind">{{ item.title }}</span>
              }
              @if (c.more) {
                <span class="more">+{{ c.more }}</span>
              }
            </span>
          </button>
        }
      </div>
    </div>
  `,
  styles: `
    .dows,
    .cells {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
    }
    .dows span {
      padding: 6px 0 10px;
      font-size: 0.72rem;
      text-align: center;
      color: var(--text-3);
    }
    .cells {
      gap: 5px;
    }
    .cell {
      display: grid;
      grid-template-rows: auto 1fr;
      justify-items: start;
      gap: 5px;
      min-width: 0;
      min-height: 112px;
      padding: 7px;
      text-align: left;
      background: var(--surface-2);
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      transition: border-color 0.2s, background 0.2s, transform 0.25s var(--ease-spring);
      animation: cell-in 0.45s var(--ease-out) both;
      animation-delay: calc(var(--i) * 9ms);
    }
    .cell:hover {
      background: var(--surface-3);
      border-color: var(--line-2);
      transform: translateY(-2px);
    }
    .cell.out {
      background: transparent;
    }
    .cell.out .num,
    .cell.out .items {
      opacity: 0.45;
    }
    .num {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-2);
      border-radius: 50%;
    }
    .today .num {
      font-weight: 700;
      color: var(--accent-ink);
      background: var(--grad);
      box-shadow: 0 2px 12px var(--accent-glow);
    }
    .items {
      display: grid;
      align-content: start;
      gap: 3px;
      width: 100%;
      min-width: 0;
    }
    .item {
      overflow: hidden;
      padding: 2px 6px;
      font-size: 0.68rem;
      font-weight: 500;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
      border-radius: 5px;
    }
    .item[data-kind='meeting'] {
      color: var(--text-2);
      background: var(--meeting-soft);
    }
    .item[data-kind='focus'] {
      color: var(--accent-ink);
      background: var(--fill);
    }
    .item[data-kind='proposed'] {
      color: var(--accent-text);
      background: var(--accent-soft);
      outline: 1px dashed var(--accent);
      outline-offset: -1px;
    }
    .item[data-kind='conflicted'] {
      color: var(--text);
      background: var(--danger-soft);
    }
    .item[data-kind='done'] {
      color: var(--text-2);
      background: var(--surface-3);
    }
    .more {
      padding-left: 6px;
      font-size: 0.68rem;
      color: var(--text-3);
    }
    @keyframes cell-in {
      from { opacity: 0; transform: scale(0.97); }
    }
    @media (max-width: 760px) {
      .cell {
        min-height: 66px;
        padding: 4px;
      }
      .item {
        height: 5px;
        padding: 0;
        color: transparent !important;
      }
      .more {
        padding: 0;
      }
    }
  `,
})
export class MonthGrid {
  readonly days = input.required<string[]>();
  /** Any day in the month being shown. */
  readonly anchor = input.required<string>();
  readonly today = input('');
  readonly zone = input.required<string>();
  readonly events = input<CalendarEvent[]>([]);
  readonly blocks = input<ScheduledBlock[]>([]);
  readonly openDay = output<string>();

  protected readonly weekdays = computed(() => this.days().slice(0, 7).map(formatWeekday));
  protected readonly cells = computed(() => monthCells(this.days(), this.anchor().slice(0, 7), this.zone(), this.events(), this.blocks()));

  protected label(c: MonthCell): string {
    return `${formatDay(c.day, 'long')}: ${c.total ? `${c.total} scheduled` : 'nothing scheduled'}`;
  }
}
