import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { CalendarEvent, ScheduledBlock } from '../core/models';
import { formatDay, formatHour, formatTime, zonedInstant } from '../core/zoned';
import { BlockChip } from './block-chip';

/** Vertical scale: 1.2 px per minute, 72 px per hour. */
export const PX_PER_MIN = 1.2;
/** Blocks move on the planner's 15-minute grid. */
export const SNAP_MIN = 15;
const HOUR = 3_600_000;
const MIN_HEIGHT = 18;

interface Span {
  start: number;
  end: number;
}

export interface Placed<T> {
  item: T;
  top: number;
  height: number;
  left: number; // percent
  width: number; // percent
}

export interface DayLayout {
  start: number; // the visible range, as instants
  end: number;
  height: number;
  hours: { t: number; top: number; label: string }[];
  workday: { top: number; height: number };
  meetings: Placed<CalendarEvent>[];
  blocks: Placed<ScheduledBlock>[];
  allDay: CalendarEvent[];
}

export interface LayoutInput {
  day: string; // YYYY-MM-DD in zone
  from: number; // the day's first instant
  to: number; // the next day's first instant (23 or 25 hours later on a DST day)
  zone: string;
  workdayStart: string;
  workdayEnd: string;
  events: CalendarEvent[];
  blocks: ScheduledBlock[];
}

const blockSpan = (b: ScheduledBlock): Span => {
  const start = Date.parse(b.starts_at);
  return { start, end: start + (b.focus_min + b.rest_min) * 60_000 };
};
const eventSpan = (e: CalendarEvent): Span => ({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at) });

/**
 * Where everything goes. The vertical axis is elapsed time from the start of the visible
 * range, and hour lines step an hour of real time at a time, so on a DST day the labels
 * read 1:00, 3:00 (spring) or 1:00, 1:00 (autumn) instead of drawing a fictional hour.
 */
export function layoutDay(input: LayoutInput): DayLayout {
  const { from, to, zone } = input;
  const timed = input.events.filter((e) => !e.all_day);
  const spans = [...timed.map(eventSpan), ...input.blocks.map(blockSpan)];
  const workStart = zonedInstant(input.day, input.workdayStart, zone);
  const workEnd = zonedInstant(input.day, input.workdayEnd, zone);

  let start = Math.min(workStart - HOUR, ...spans.map((s) => s.start));
  let end = Math.max(workEnd + HOUR, ...spans.map((s) => s.end));
  start = Math.max(from, from + Math.floor((start - from) / HOUR) * HOUR);
  end = Math.min(to, from + Math.ceil((end - from) / HOUR) * HOUR);

  const y = (t: number) => ((Math.min(Math.max(t, start), end) - start) / 60_000) * PX_PER_MIN;
  const hours = [];
  for (let t = start; t < end; t += HOUR) hours.push({ t, top: y(t), label: formatHour(t, zone) });

  // Overlapping items share the width in lanes, like any calendar. Meetings and blocks
  // are laid out together, so a block a meeting moved onto sits visibly beside it.
  type Entry = { span: Span; kind: 'meeting' | 'block'; index: number };
  const entries: Entry[] = [
    ...timed.map((e, index) => ({ span: eventSpan(e), kind: 'meeting' as const, index })),
    ...input.blocks.map((b, index) => ({ span: blockSpan(b), kind: 'block' as const, index })),
  ]
    .filter((e) => e.span.end > start && e.span.start < end)
    .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);

  const lane = new Map<Entry, number>();
  const lanes = new Map<Entry, number>();
  let cluster: Entry[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    const width = Math.max(1, ...cluster.map((e) => lane.get(e)! + 1));
    cluster.forEach((e) => lanes.set(e, width));
    cluster = [];
  };
  let laneEnds: number[] = [];
  for (const entry of entries) {
    if (entry.span.start >= clusterEnd) {
      close();
      laneEnds = [];
    }
    let free = laneEnds.findIndex((laneEnd) => laneEnd <= entry.span.start);
    if (free < 0) free = laneEnds.length;
    laneEnds[free] = entry.span.end;
    lane.set(entry, free);
    cluster.push(entry);
    clusterEnd = Math.max(clusterEnd, entry.span.end);
  }
  close();

  const place = <T,>(entry: Entry, item: T): Placed<T> => {
    const top = y(entry.span.start);
    const width = 100 / lanes.get(entry)!;
    return { item, top, height: Math.max(MIN_HEIGHT, y(entry.span.end) - top), left: lane.get(entry)! * width, width };
  };
  return {
    start,
    end,
    height: y(end),
    hours,
    workday: { top: y(workStart), height: y(workEnd) - y(workStart) },
    meetings: entries.filter((e) => e.kind === 'meeting').map((e) => place(e, timed[e.index])),
    blocks: entries.filter((e) => e.kind === 'block').map((e) => place(e, input.blocks[e.index])),
    allDay: input.events.filter((e) => e.all_day),
  };
}

export interface BlockMove {
  block: ScheduledBlock;
  startsAt: number;
}

interface Drag {
  id: number;
  pointer: number;
  originY: number;
  deltaMin: number;
}

/**
 * The day view: an hour grid in the user's zone, meetings as muted blocks, free time
 * left empty, focus blocks in the pixel treatment and a now-line. Blocks move by drag
 * (native Pointer Events) or by keyboard, on the 15-minute grid; the parent decides
 * whether the server accepts the move.
 */
@Component({
  selector: 'app-day-timeline',
  imports: [BlockChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="timeline" role="group" [attr.aria-label]="'Schedule for ' + dayLabel()">
      @if (layout().allDay.length) {
        <ul class="all-day" aria-label="All-day events">
          @for (e of layout().allDay; track e.id) {
            <li class="px">{{ e.title || 'All day' }}</li>
          }
        </ul>
      }
      <div class="grid" [style.height.px]="layout().height">
        <div class="workday" [style.top.px]="layout().workday.top" [style.height.px]="layout().workday.height" aria-hidden="true"></div>
        @for (h of layout().hours; track h.t) {
          <div class="hour" [style.top.px]="h.top" aria-hidden="true"><span>{{ h.label }}</span></div>
        }
        <div class="lanes">
          @for (m of layout().meetings; track m.item.id) {
            <div
              class="meeting"
              [class.free]="!m.item.busy"
              [class.compact]="m.height < 36"
              [style.top.px]="m.top"
              [style.height.px]="m.height"
              [style.left.%]="m.left"
              [style.width.%]="m.width"
              [attr.aria-label]="meetingLabel(m.item)"
              role="note"
            >
              <span class="m-title">{{ m.item.title || 'Busy' }}</span>
              <span class="m-time">{{ range(m.item.starts_at, m.item.ends_at) }}{{ m.item.busy ? '' : ' · not busy' }}</span>
            </div>
          }
          @for (b of layout().blocks; track b.item.id) {
            <app-block-chip
              #chip
              class="block"
              [block]="b.item"
              [zone]="zone()"
              [class.draggable]="canMove()(b.item)"
              [class.dragging]="drag()?.id === b.item.id"
              [style.top.px]="b.top + offset(b.item)"
              [style.height.px]="b.height"
              [style.left.%]="b.left"
              [style.width.%]="b.width"
              tabindex="0"
              [attr.data-id]="b.item.id"
              [attr.aria-label]="blockLabel(b.item)"
              [attr.aria-roledescription]="canMove()(b.item) ? 'movable focus block' : 'focus block'"
              (keydown)="onKey($event, b.item)"
              (pointerdown)="onPointerDown($event, b.item)"
              (pointermove)="onPointerMove($event)"
              (pointerup)="onPointerUp($event, b.item)"
              (pointercancel)="drag.set(null)"
              (click)="onClick(b.item)"
            />
          }
        </div>
        @if (nowTop(); as top) {
          <div class="now" [style.top.px]="top" aria-hidden="true"><span>NOW</span></div>
        }
      </div>
      @if (!layout().meetings.length && !layout().blocks.length) {
        <p class="empty-day">Nothing on the calendar. Wide open.</p>
      }
    </div>
  `,
  styles: `
    .timeline {
      position: relative;
      display: grid;
      gap: 10px;
    }
    .all-day {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding-left: 64px;
      list-style: none;
    }
    .all-day li {
      --bd: var(--gray-600);
      margin: 3px;
      padding: 4px 10px;
      font-size: 0.75rem;
      color: var(--gray-300);
      background: var(--gray-800);
    }
    .grid {
      position: relative;
      margin-right: 6px;
    }
    .workday {
      position: absolute;
      left: 56px;
      right: 0;
      background: rgba(255, 255, 255, 0.025);
    }
    .hour {
      position: absolute;
      left: 0;
      right: 0;
      height: 0;
      border-top: 1px dashed var(--gray-700);
    }
    .hour span {
      position: absolute;
      top: -0.6em;
      left: 0;
      width: 54px;
      padding-right: 8px;
      font-family: var(--font-pixel);
      font-size: 0.42rem;
      white-space: nowrap;
      line-height: 1.2;
      text-align: right;
      color: var(--gray-500);
      background: var(--gray-900);
    }
    .lanes {
      position: absolute;
      inset: 0 0 0 64px;
    }
    .meeting,
    .block {
      position: absolute;
      box-sizing: border-box;
    }
    .meeting {
      display: grid;
      align-content: start;
      gap: 2px;
      padding: 4px 8px;
      overflow: hidden;
      font-size: 0.78rem;
      color: var(--cream);
      background: var(--gray-700);
      border-left: 4px solid var(--gray-400);
      border-right: 2px solid var(--gray-900);
    }
    .meeting.compact {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-block: 0;
    }
    .meeting.free {
      background: transparent;
      border: 1px dashed var(--gray-600);
      border-left-width: 4px;
      color: var(--gray-500);
    }
    .m-title {
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .m-time {
      font-size: 0.68rem;
      color: var(--gray-400);
      white-space: nowrap;
    }
    .block {
      margin: 0 3px;
    }
    .now {
      position: absolute;
      left: 56px;
      right: 0;
      z-index: 3;
      height: 0;
      border-top: 2px solid var(--danger);
      pointer-events: none;
    }
    .now span {
      position: absolute;
      top: -0.55em;
      left: -6px;
      padding: 2px 4px;
      font-family: var(--font-pixel);
      font-size: 0.38rem;
      color: var(--black);
      background: var(--danger);
      transform: translateX(-100%);
    }
    .empty-day {
      position: absolute;
      top: 40%;
      left: 64px;
      right: 0;
      font-size: 0.85rem;
      text-align: center;
      color: var(--gray-500);
      pointer-events: none;
    }
  `,
})
export class DayTimeline {
  readonly day = input.required<string>();
  readonly from = input.required<number>();
  readonly to = input.required<number>();
  readonly zone = input.required<string>();
  readonly workdayStart = input('09:00');
  readonly workdayEnd = input('17:00');
  readonly events = input<CalendarEvent[]>([]);
  readonly blocks = input<ScheduledBlock[]>([]);
  readonly now = input<number>(Date.now());
  /** Which blocks may be dragged or shifted. */
  readonly canMove = input<(b: ScheduledBlock) => boolean>(() => false);

  readonly moved = output<BlockMove>();
  readonly activate = output<ScheduledBlock>();

  protected readonly drag = signal<Drag | null>(null);
  private dragged = false; // the click that ends a drag is not an activation
  private readonly chips = viewChildren('chip', { read: ElementRef });

  protected readonly layout = computed(() =>
    layoutDay({
      day: this.day(),
      from: this.from(),
      to: this.to(),
      zone: this.zone(),
      workdayStart: this.workdayStart(),
      workdayEnd: this.workdayEnd(),
      events: this.events(),
      blocks: this.blocks(),
    }),
  );
  protected readonly dayLabel = computed(() => formatDay(this.day(), 'long'));
  protected readonly nowTop = computed(() => {
    const { start, end } = this.layout();
    const now = this.now();
    // 0 would read as "no now-line", so the line sits a pixel down at the very top.
    return now >= start && now < end ? Math.max(1, ((now - start) / 60_000) * PX_PER_MIN) : null;
  });

  protected range(a: string | number, b: string | number): string {
    return `${formatTime(a, this.zone())}–${formatTime(b, this.zone())}`;
  }

  protected meetingLabel(e: CalendarEvent): string {
    return `${e.title || 'Busy'}, ${this.range(e.starts_at, e.ends_at)}${e.busy ? '' : ', not busy'}`;
  }

  protected blockLabel(b: ScheduledBlock): string {
    const start = Date.parse(b.starts_at);
    const what = b.intention || 'Focus';
    const move = this.canMove()(b) ? '. Shift plus arrow keys move it 15 minutes' : '';
    return `${b.status} focus block: ${what}, ${this.range(start, start + b.focus_min * 60_000)}, ${b.focus_min} minutes, ${b.mode}${move}. ${b.explain}`;
  }

  /** How far a block being dragged has moved, in pixels. */
  protected offset(b: ScheduledBlock): number {
    const d = this.drag();
    return d?.id === b.id ? d.deltaMin * PX_PER_MIN : 0;
  }

  // ---- keyboard: arrows move focus between blocks, Shift+arrows move the block itself ----

  protected onKey(e: KeyboardEvent, b: ScheduledBlock): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.activate.emit(b);
      }
      return;
    }
    e.preventDefault();
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.shiftKey) {
      if (this.canMove()(b)) this.moved.emit({ block: b, startsAt: Date.parse(b.starts_at) + dir * SNAP_MIN * 60_000 });
      return;
    }
    const order = this.layout().blocks.map((p) => p.item.id);
    const next = order[order.indexOf(b.id) + dir];
    if (next !== undefined) {
      const el = this.chips().find((c) => (c.nativeElement as HTMLElement).dataset['id'] === String(next));
      (el?.nativeElement as HTMLElement | undefined)?.focus();
    }
  }

  // ---- pointer drag, snapped to the 15-minute grid ----

  protected onPointerDown(e: PointerEvent, b: ScheduledBlock): void {
    if (!this.canMove()(b) || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag.set({ id: b.id, pointer: e.pointerId, originY: e.clientY, deltaMin: 0 });
  }

  protected onPointerMove(e: PointerEvent): void {
    const d = this.drag();
    if (!d || d.pointer !== e.pointerId) return;
    const deltaMin = Math.round((e.clientY - d.originY) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
    if (deltaMin !== d.deltaMin) this.drag.set({ ...d, deltaMin });
  }

  protected onPointerUp(e: PointerEvent, b: ScheduledBlock): void {
    const d = this.drag();
    if (!d || d.pointer !== e.pointerId) return;
    this.drag.set(null);
    this.dragged = d.deltaMin !== 0;
    if (this.dragged) this.moved.emit({ block: b, startsAt: Date.parse(b.starts_at) + d.deltaMin * 60_000 });
  }

  protected onClick(b: ScheduledBlock): void {
    if (this.dragged) {
      this.dragged = false;
      return;
    }
    this.activate.emit(b);
  }
}
