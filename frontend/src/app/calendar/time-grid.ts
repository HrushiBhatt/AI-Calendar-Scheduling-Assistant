import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { BlockMove } from '../core/board';
import { CalendarEvent, ScheduledBlock } from '../core/models';
import { dayIn, formatDay, formatHour, formatTime, formatWeekday, shiftDay, wallTime, zonedInstant } from '../core/zoned';
import { BlockChip } from './block-chip';

/** Vertical scale: 1.2 px per minute, 72 px per hour. */
export const PX_PER_MIN = 1.2;
/** Blocks move on the planner's 15-minute grid. */
export const SNAP_MIN = 15;
const HOUR = 3_600_000;
const MIN_HEIGHT = 18;
const DAY_MIN = 24 * 60;

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
  day: string;
  start: number; // the visible range, as instants
  end: number;
  height: number;
  /** Where an instant falls in this column, in pixels from the top. */
  y: (t: number) => number;
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
  /**
   * A shared clock range, in minutes after midnight, so columns side by side line up. Without
   * one, the column sizes itself to its day.
   */
  window?: { startMin: number; endMin: number };
}

const blockSpan = (b: ScheduledBlock): Span => {
  const start = Date.parse(b.starts_at);
  return { start, end: start + (b.focus_min + b.rest_min) * 60_000 };
};
const eventSpan = (e: CalendarEvent): Span => ({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at) });
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Where everything goes. On its own, a day's vertical axis is elapsed time from the start of
 * the visible range, and hour lines step an hour of real time at a time, so on a DST day the
 * labels read 1:00, 3:00 (spring) or 1:00, 1:00 (autumn) instead of drawing a fictional hour.
 * With a shared window the axis is the wall clock instead, because a week's columns must line
 * up with one column of hour labels.
 */
export function layoutDay(input: LayoutInput): DayLayout {
  const { from, to, zone, window } = input;
  const timed = input.events.filter((e) => !e.all_day);
  const spans = [...timed.map(eventSpan), ...input.blocks.map(blockSpan)];
  const workStart = zonedInstant(input.day, input.workdayStart, zone);
  const workEnd = zonedInstant(input.day, input.workdayEnd, zone);

  let start: number;
  let end: number;
  let y: (t: number) => number;
  const hours: DayLayout['hours'] = [];
  if (window) {
    start = zonedInstant(input.day, hhmm(window.startMin), zone);
    end = window.endMin >= DAY_MIN ? to : zonedInstant(input.day, hhmm(window.endMin), zone);
    const clock = (t: number) => {
      if (t <= from) return 0;
      if (t >= to) return DAY_MIN;
      const w = wallTime(t, zone);
      return w.hour * 60 + w.minute;
    };
    y = (t) => (Math.min(Math.max(clock(t), window.startMin), window.endMin) - window.startMin) * PX_PER_MIN;
    for (let m = window.startMin; m < window.endMin; m += 60) {
      const t = zonedInstant(input.day, hhmm(m), zone);
      hours.push({ t, top: (m - window.startMin) * PX_PER_MIN, label: formatHour(t, zone) });
    }
  } else {
    start = Math.min(workStart - HOUR, ...spans.map((s) => s.start));
    end = Math.max(workEnd + HOUR, ...spans.map((s) => s.end));
    start = Math.max(from, from + Math.floor((start - from) / HOUR) * HOUR);
    end = Math.min(to, from + Math.ceil((end - from) / HOUR) * HOUR);
    const first = start;
    const last = end;
    y = (t) => ((Math.min(Math.max(t, first), last) - first) / 60_000) * PX_PER_MIN;
    for (let t = start; t < end; t += HOUR) hours.push({ t, top: y(t), label: formatHour(t, zone) });
  }

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
    day: input.day,
    start,
    end,
    height: window ? (window.endMin - window.startMin) * PX_PER_MIN : y(end),
    y,
    hours,
    workday: { top: y(workStart), height: y(workEnd) - y(workStart) },
    meetings: entries.filter((e) => e.kind === 'meeting').map((e) => place(e, timed[e.index])),
    blocks: entries.filter((e) => e.kind === 'block').map((e) => place(e, input.blocks[e.index])),
    allDay: input.events.filter((e) => e.all_day),
  };
}

export type GridInput = Omit<LayoutInput, 'day' | 'from' | 'to' | 'window'>;

const overlaps = (span: Span, from: number, to: number) => span.end > from && span.start < to;

/** One column per day. A single day sizes itself; several share one clock range. */
export function layoutDays(days: string[], input: GridInput): DayLayout[] {
  const { zone } = input;
  const columns = days.map((day) => {
    const from = zonedInstant(day, '00:00', zone);
    const to = zonedInstant(shiftDay(day, 1), '00:00', zone);
    return {
      day,
      from,
      to,
      events: input.events.filter((e) => overlaps(eventSpan(e), from, to)),
      blocks: input.blocks.filter((b) => overlaps(blockSpan(b), from, to)),
    };
  });
  if (columns.length === 1) return [layoutDay({ ...input, ...columns[0] })];

  let startMin = toMinutes(input.workdayStart) - 60;
  let endMin = toMinutes(input.workdayEnd) + 60;
  for (const c of columns) {
    const spans = [...c.events.filter((e) => !e.all_day).map(eventSpan), ...c.blocks.map(blockSpan)];
    for (const s of spans) {
      const a = wallTime(Math.max(s.start, c.from), zone);
      startMin = Math.min(startMin, a.hour * 60);
      const b = s.end >= c.to ? null : wallTime(s.end, zone);
      endMin = Math.max(endMin, b ? b.hour * 60 + (b.minute ? 60 : 0) : DAY_MIN);
    }
  }
  const window = { startMin: Math.max(0, startMin), endMin: Math.min(DAY_MIN, endMin) };
  return columns.map((c) => layoutDay({ ...input, ...c, window }));
}

/**
 * Where a block lands after a move. Across days it keeps its wall-clock time, so a clock
 * change between the two days can't shift it by an hour.
 */
export function movedStart(startsAt: string, deltaMin: number, deltaDays: number, zone: string): number {
  const moved = Date.parse(startsAt) + deltaMin * 60_000;
  if (!deltaDays) return moved;
  const w = wallTime(moved, zone);
  return zonedInstant(shiftDay(dayIn(moved, zone), deltaDays), hhmm(w.hour * 60 + w.minute), zone);
}

interface Drag {
  id: number;
  pointer: number;
  originX: number;
  originY: number;
  deltaMin: number;
  deltaDays: number;
  colWidth: number;
  minDays: number;
  maxDays: number;
}

/**
 * The day and week views: an hour grid in the user's zone with meetings, focus blocks and a
 * now-line. Blocks move by drag (native Pointer Events) or by keyboard, on the 15-minute grid
 * and across days; the parent decides whether the server accepts the move.
 */
@Component({
  selector: 'app-time-grid',
  imports: [BlockChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="grid" [class.multi]="columns().length > 1" [style.--cols]="columns().length">
      @if (columns().length > 1) {
        <div class="heads">
          @for (col of columns(); track col.day) {
            <button class="head" [class.today]="col.day === today()" (click)="openDay.emit(col.day)" [attr.aria-label]="'Open ' + dayLabel(col.day)">
              <span class="dow">{{ weekday(col.day) }}</span>
              <span class="num">{{ dayNumber(col.day) }}</span>
            </button>
          }
        </div>
      }
      @if (hasAllDay()) {
        <div class="all-day">
          @for (col of columns(); track col.day) {
            <ul [attr.aria-label]="'All-day events, ' + dayLabel(col.day)">
              @for (e of col.allDay; track e.id) {
                <li [title]="e.title">{{ e.title || 'All day' }}</li>
              }
            </ul>
          }
        </div>
      }
      <div class="scroll" #scroller>
        <div class="body" [style.height.px]="height()">
        @for (h of columns()[0].hours; track h.t) {
          <div class="hour" [style.top.px]="h.top" aria-hidden="true"><span>{{ h.label }}</span></div>
        }
        <div class="cols">
          @for (col of columns(); track col.day; let c = $index) {
            <div class="col" [class.today]="col.day === today()" [attr.data-day]="col.day" role="group" [attr.aria-label]="dayLabel(col.day)">
              <div class="workday" [style.top.px]="col.workday.top" [style.height.px]="col.workday.height" aria-hidden="true"></div>
              @for (m of col.meetings; track m.item.id) {
                <div
                  class="meeting"
                  [class.free]="!m.item.busy"
                  [class.compact]="m.height < 36"
                  [style.top.px]="m.top + 1"
                  [style.height.px]="m.height - 2"
                  [style.left.%]="m.left"
                  [style.width.%]="m.width"
                  [attr.aria-label]="meetingLabel(m.item)"
                  [title]="meetingLabel(m.item)"
                  role="note"
                >
                  <span class="m-title">{{ m.item.title || 'Busy' }}</span>
                  <span class="m-time">{{ range(m.item.starts_at, m.item.ends_at) }}</span>
                </div>
              }
              @for (b of col.blocks; track b.item.id) {
                <app-block-chip
                  #chip
                  class="block"
                  [block]="b.item"
                  [zone]="zone()"
                  [class.draggable]="canMove()(b.item)"
                  [class.dragging]="drag()?.id === b.item.id"
                  [class.dimmed]="dimmed().has(b.item.id)"
                  [class.selected]="selected() === b.item.id"
                  [compact]="b.height < 48"
                  [style.--i]="$index"
                  [style.top.px]="b.top + dy(b.item) + 1"
                  [style.height.px]="b.height - 2"
                  [style.left.%]="b.left"
                  [style.width.%]="b.width"
                  [style.translate]="dx(b.item)"
                  tabindex="0"
                  [attr.data-id]="b.item.id"
                  [attr.aria-label]="blockLabel(b.item)"
                  [attr.aria-roledescription]="canMove()(b.item) ? 'movable focus block' : 'focus block'"
                  [title]="b.item.note || b.item.explain"
                  (keydown)="onKey($event, b.item)"
                  (pointerdown)="onPointerDown($event, b.item, c)"
                  (pointermove)="onPointerMove($event)"
                  (pointerup)="onPointerUp($event, b.item)"
                  (pointercancel)="drag.set(null)"
                  (click)="onClick(b.item)"
                />
              }
              @if (nowTop(col); as top) {
                <div class="now" [style.top.px]="top" aria-hidden="true"></div>
              }
            </div>
          }
        </div>
        </div>
      </div>
      @if (columns().length === 1 && !columns()[0].meetings.length && !columns()[0].blocks.length) {
        <p class="free-day">Nothing scheduled</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
      --gutter: 52px;
    }
    .grid {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100%;
    }
    .heads,
    .all-day {
      display: grid;
      flex: none;
      grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
      margin-left: var(--gutter);
      /* Line up with the columns below, whatever the scrollbar takes. */
      overflow: hidden;
      scrollbar-gutter: stable;
    }
    .heads {
      padding: 4px 0 8px;
    }
    .scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      scrollbar-gutter: stable;
      scrollbar-width: thin;
      border-top: 1px solid var(--line);
    }
    .head {
      display: grid;
      justify-items: center;
      gap: 3px;
      padding: 4px 0;
      border-radius: var(--radius-sm);
      transition: background 0.2s;
    }
    .head:hover {
      background: var(--surface-2);
    }
    .dow {
      font-size: 0.72rem;
      color: var(--text-3);
    }
    .num {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      font-size: 0.95rem;
      font-weight: 500;
      color: var(--text-2);
      border-radius: 50%;
      transition: transform 0.3s var(--ease-spring);
    }
    .head:hover .num {
      transform: scale(1.1);
    }
    .head.today .dow {
      color: var(--accent);
    }
    .head.today .num {
      font-weight: 700;
      color: var(--accent-ink);
      background: var(--grad);
      box-shadow: 0 2px 14px var(--accent-glow);
    }
    .all-day {
      margin-bottom: 8px;
    }
    .all-day ul {
      display: grid;
      align-content: start;
      gap: 3px;
      padding: 0 2px;
    }
    .all-day li {
      overflow: hidden;
      padding: 3px 8px;
      font-size: 0.72rem;
      color: var(--text-2);
      text-overflow: ellipsis;
      white-space: nowrap;
      background: var(--meeting-soft);
      border-radius: 6px;
    }
    .body {
      position: relative;
      margin-top: 10px;
    }
    .hour {
      position: absolute;
      left: 0;
      right: 0;
      height: 0;
      border-top: 1px solid var(--line);
    }
    .hour span {
      position: absolute;
      top: -0.55em;
      left: 0;
      width: calc(var(--gutter) - 10px);
      font-size: 0.68rem;
      line-height: 1;
      text-align: right;
      white-space: nowrap;
      color: var(--text-3);
    }
    .cols {
      position: absolute;
      inset: 0 0 0 var(--gutter);
      display: grid;
      grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
    }
    .col {
      position: relative;
      border-left: 1px solid var(--line);
    }
    .col.today {
      background: linear-gradient(180deg, var(--accent-soft), transparent 40%);
    }
    .workday {
      position: absolute;
      left: 0;
      right: 0;
      background: var(--workday);
    }
    .meeting,
    .block {
      position: absolute;
    }
    .meeting {
      display: grid;
      align-content: start;
      gap: 1px;
      padding: 4px 7px;
      overflow: hidden;
      font-size: 0.76rem;
      color: var(--text);
      background: var(--meeting-soft);
      border-left: 3px solid var(--meeting);
      border-radius: 6px;
      container-type: inline-size;
      animation: rise 0.4s var(--ease-out) both;
    }
    .meeting.compact {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-block: 0;
    }
    .meeting.compact .m-time {
      display: none;
    }
    @container (min-width: 240px) {
      .meeting.compact .m-time {
        display: block;
      }
    }
    .meeting.free {
      background: transparent;
      border: 1px dashed var(--line-2);
      border-left: 3px solid var(--line-2);
      color: var(--text-3);
    }
    .m-title {
      overflow: hidden;
      font-weight: 500;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .m-time {
      overflow: hidden;
      font-size: 0.68rem;
      color: var(--text-2);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .block.dimmed {
      opacity: 0.35;
    }
    .now {
      position: absolute;
      left: 0;
      right: 0;
      z-index: 4;
      height: 0;
      border-top: 2px solid var(--danger);
      pointer-events: none;
    }
    .now::before {
      content: '';
      position: absolute;
      top: -5px;
      left: -4px;
      width: 8px;
      height: 8px;
      background: var(--danger);
      border-radius: 50%;
      animation: now-pulse 2.4s ease-out infinite;
    }
    .free-day {
      position: absolute;
      top: 45%;
      left: var(--gutter);
      right: 0;
      font-size: 0.85rem;
      text-align: center;
      color: var(--text-3);
      pointer-events: none;
    }
    @keyframes now-pulse {
      0% { box-shadow: 0 0 0 0 rgba(240, 112, 95, 0.5); }
      70%, 100% { box-shadow: 0 0 0 9px rgba(240, 112, 95, 0); }
    }
    @media (max-width: 760px) {
      :host {
        --gutter: 40px;
        overflow-x: auto;
      }
      .scroll {
        overflow: visible;
      }
      .multi {
        min-width: 680px;
      }
    }
  `,
})
export class TimeGrid {
  readonly days = input.required<string[]>();
  readonly today = input('');
  readonly zone = input.required<string>();
  readonly workdayStart = input('09:00');
  readonly workdayEnd = input('17:00');
  readonly events = input<CalendarEvent[]>([]);
  readonly blocks = input<ScheduledBlock[]>([]);
  readonly now = input<number>(Date.now());
  /** Blocks to draw faded: proposed ones the user unticked. */
  readonly dimmed = input<ReadonlySet<number>>(new Set());
  readonly selected = input<number | null>(null);
  /** Which blocks may be dragged or shifted. */
  readonly canMove = input<(b: ScheduledBlock) => boolean>(() => false);

  readonly moved = output<BlockMove>();
  readonly activate = output<ScheduledBlock>();
  readonly openDay = output<string>();

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  protected readonly drag = signal<Drag | null>(null);
  private dragged = false; // the click that ends a drag is not an activation
  private readonly chips = viewChildren('chip', { read: ElementRef });

  protected readonly columns = computed(() =>
    layoutDays(this.days(), {
      zone: this.zone(),
      workdayStart: this.workdayStart(),
      workdayEnd: this.workdayEnd(),
      events: this.events(),
      blocks: this.blocks(),
    }),
  );
  protected readonly height = computed(() => Math.max(...this.columns().map((c) => c.height)));
  protected readonly hasAllDay = computed(() => this.columns().some((c) => c.allDay.length));

  constructor() {
    // Open with the present in view, when the scrollable area is shorter than the day.
    afterNextRender(() => {
      const scroller = this.scroller()?.nativeElement;
      const col = this.columns().find((c) => c.day === this.today());
      if (!scroller || !col || scroller.scrollHeight <= scroller.clientHeight) return;
      const top = this.nowTop(col);
      if (top !== null) scroller.scrollTop = top - scroller.clientHeight / 3;
    });
  }

  protected readonly dayLabel = (day: string) => formatDay(day, 'long');
  protected readonly weekday = formatWeekday;
  protected readonly dayNumber = (day: string) => Number(day.slice(8));

  protected nowTop(col: DayLayout): number | null {
    const now = this.now();
    // 0 would read as "no now-line", so the line sits a pixel down at the very top.
    return now >= col.start && now < col.end ? Math.max(1, col.y(now)) : null;
  }

  protected range(a: string | number, b: string | number): string {
    return `${formatTime(a, this.zone())}–${formatTime(b, this.zone())}`;
  }

  protected meetingLabel(e: CalendarEvent): string {
    return `${e.title || 'Busy'}, ${this.range(e.starts_at, e.ends_at)}${e.busy ? '' : ', not busy'}`;
  }

  protected blockLabel(b: ScheduledBlock): string {
    const start = Date.parse(b.starts_at);
    const what = b.intention || 'Focus';
    const move = this.canMove()(b) ? '. Shift plus arrow keys move it' : '';
    return `${b.status} focus block: ${what}, ${this.range(start, start + b.focus_min * 60_000)}, ${b.focus_min} minutes, ${b.mode}${move}. ${b.explain}`;
  }

  /** How far a block being dragged has moved down, in pixels. */
  protected dy(b: ScheduledBlock): number {
    const d = this.drag();
    return d?.id === b.id ? d.deltaMin * PX_PER_MIN : 0;
  }

  /** And across: whole columns, so it visibly lands on a day. */
  protected dx(b: ScheduledBlock): string | null {
    const d = this.drag();
    return d?.id === b.id && d.deltaDays ? `${d.deltaDays * d.colWidth}px 0` : null;
  }

  // ---- keyboard: arrows move focus between blocks, Shift+arrows move the block itself ----

  protected onKey(e: KeyboardEvent, b: ScheduledBlock): void {
    const moves: Record<string, [number, number]> = {
      ArrowUp: [-SNAP_MIN, 0],
      ArrowDown: [SNAP_MIN, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const move = moves[e.key];
    if (!move) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.activate.emit(b);
      }
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      if (this.canMove()(b)) this.moved.emit({ block: b, startsAt: movedStart(b.starts_at, move[0], move[1], this.zone()) });
      return;
    }
    if (move[1]) return;
    e.preventDefault();
    const order = this.columns().flatMap((c) => c.blocks.map((p) => p.item.id));
    const next = order[order.indexOf(b.id) + Math.sign(move[0])];
    if (next !== undefined) {
      const el = this.chips().find((c) => (c.nativeElement as HTMLElement).dataset['id'] === String(next));
      (el?.nativeElement as HTMLElement | undefined)?.focus();
    }
  }

  // ---- pointer drag, snapped to the 15-minute grid and to whole days ----

  protected onPointerDown(e: PointerEvent, b: ScheduledBlock, column: number): void {
    if (!this.canMove()(b) || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const count = this.columns().length;
    this.drag.set({
      id: b.id,
      pointer: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      deltaMin: 0,
      deltaDays: 0,
      colWidth: count > 1 ? (el.closest('.col')?.getBoundingClientRect().width ?? 0) : 0,
      minDays: -column,
      maxDays: count - 1 - column,
    });
  }

  protected onPointerMove(e: PointerEvent): void {
    const d = this.drag();
    if (!d || d.pointer !== e.pointerId) return;
    const deltaMin = Math.round((e.clientY - d.originY) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
    const across = d.colWidth ? Math.round((e.clientX - d.originX) / d.colWidth) : 0;
    const deltaDays = Math.min(d.maxDays, Math.max(d.minDays, across));
    if (deltaMin !== d.deltaMin || deltaDays !== d.deltaDays) this.drag.set({ ...d, deltaMin, deltaDays });
  }

  protected onPointerUp(e: PointerEvent, b: ScheduledBlock): void {
    const d = this.drag();
    if (!d || d.pointer !== e.pointerId) return;
    this.drag.set(null);
    this.dragged = d.deltaMin !== 0 || d.deltaDays !== 0;
    if (this.dragged) this.moved.emit({ block: b, startsAt: movedStart(b.starts_at, d.deltaMin, d.deltaDays, this.zone()) });
  }

  protected onClick(b: ScheduledBlock): void {
    if (this.dragged) {
      this.dragged = false;
      return;
    }
    this.activate.emit(b);
  }
}
