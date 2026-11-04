import { CalendarEvent, ScheduledBlock } from '../core/models';
import { shiftDay, zonedInstant } from '../core/zoned';
import { PX_PER_MIN, layoutDay, layoutDays, movedStart } from './time-grid';

const NY = 'America/New_York';
const at = (day: string, time: string) => new Date(zonedInstant(day, time, NY)).toISOString();

function meeting(id: number, day: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, title: `M${id}`, starts_at: at(day, start), ends_at: at(day, end), all_day: false, busy: true, ...extra };
}

function block(id: number, day: string, start: string, focus = 50, rest = 10): ScheduledBlock {
  return {
    id, plan_id: 1, task_id: null, new_task: false, session_id: null, mode: 'Animedoro', starts_at: at(day, start),
    focus_min: focus, rest_min: rest, intention: 'Compiler', status: 'proposed', explain: '', score: 0, note: '', created_at: '',
  };
}

function layout(day: string, events: CalendarEvent[], blocks: ScheduledBlock[] = []) {
  return layoutDay({
    day, from: zonedInstant(day, '00:00', NY), to: zonedInstant(shiftDay(day, 1), '00:00', NY), zone: NY,
    workdayStart: '09:00', workdayEnd: '17:00', events, blocks,
  });
}

describe('layoutDay', () => {
  it('shows the workday with an hour either side, stretched to fit early or late items', () => {
    const plain = layout('2026-10-26', []);
    expect(new Date(plain.start).toISOString()).toBe(at('2026-10-26', '08:00'));
    expect(new Date(plain.end).toISOString()).toBe(at('2026-10-26', '18:00'));
    expect(plain.hours.length).toBe(10);
    expect(plain.height).toBe(10 * 60 * PX_PER_MIN);

    const early = layout('2026-10-26', [meeting(1, '2026-10-26', '06:30', '07:00')]);
    expect(new Date(early.start).toISOString()).toBe(at('2026-10-26', '06:00'));
  });

  it('positions items by elapsed time from the top of the visible range', () => {
    const l = layout('2026-10-26', [meeting(1, '2026-10-26', '10:30', '11:30')]);
    const m = l.meetings[0];
    expect(m.top).toBe(150 * PX_PER_MIN); // 2.5 hours below 8:00
    expect(m.height).toBe(60 * PX_PER_MIN);
    expect([m.left, m.width]).toEqual([0, 100]);
  });

  it('puts overlapping items side by side, including a block a meeting moved onto', () => {
    const l = layout(
      '2026-10-26',
      [meeting(1, '2026-10-26', '10:00', '11:00'), meeting(2, '2026-10-26', '10:30', '11:30'), meeting(3, '2026-10-26', '13:00', '14:00')],
      [block(9, '2026-10-26', '13:30')],
    );
    const byId = Object.fromEntries(l.meetings.map((p) => [p.item.id, p]));
    expect([byId[1].left, byId[1].width]).toEqual([0, 50]);
    expect([byId[2].left, byId[2].width]).toEqual([50, 50]);
    expect([byId[3].width, l.blocks[0].width, l.blocks[0].left]).toEqual([50, 50, 50]);
  });

  it('draws real hours on a DST day: the autumn day repeats 1 AM', () => {
    const l = layout('2026-11-01', [meeting(1, '2026-11-01', '00:30', '03:00')]);
    expect(l.hours.slice(0, 4).map((h) => h.label.replace(/\s/g, ''))).toEqual(['12AM', '1AM', '1AM', '2AM']);
    expect(l.meetings[0].height).toBe(210 * PX_PER_MIN); // 3.5 real hours, not 2.5
  });

  it('keeps a shared clock range across a week, even on a DST day', () => {
    // Nov 1 2026 is the autumn change in New York: a 25-hour day in the middle of this week.
    const days = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];
    const cols = layoutDays(days, {
      zone: NY, workdayStart: '09:00', workdayEnd: '17:00',
      events: [meeting(1, '2026-11-01', '10:00', '11:00'), meeting(2, '2026-11-02', '10:00', '11:00')],
      blocks: [block(9, '2026-10-30', '07:00')],
    });
    expect(cols.map((c) => c.height)).toEqual(Array(4).fill((18 - 7) * 60 * PX_PER_MIN)); // 7:00 to 18:00, widened for the block
    expect(cols[0].hours.length).toBe(11);
    // The same clock time sits at the same height either side of the change.
    expect(cols[2].meetings[0].top).toBe(cols[3].meetings[0].top);
    expect(cols[2].meetings[0].top).toBe(3 * 60 * PX_PER_MIN);
    expect(cols[0].blocks[0].top).toBe(0);
  });

  it('puts each item in the column for its day', () => {
    const cols = layoutDays(['2026-10-26', '2026-10-27'], {
      zone: NY, workdayStart: '09:00', workdayEnd: '17:00',
      events: [meeting(1, '2026-10-27', '10:00', '11:00')],
      blocks: [block(9, '2026-10-26', '13:00')],
    });
    expect(cols.map((c) => [c.meetings.length, c.blocks.length])).toEqual([[0, 1], [1, 0]]);
  });

  it('shows a block that crosses midnight on both days', () => {
    const cols = layoutDays(['2026-10-26', '2026-10-27'], {
      zone: NY, workdayStart: '09:00', workdayEnd: '17:00', events: [], blocks: [block(9, '2026-10-26', '23:30')],
    });
    expect(cols.map((c) => c.blocks.length)).toEqual([1, 1]);
    expect(cols[0].height).toBe(24 * 60 * PX_PER_MIN); // the range reaches midnight
  });

  it('keeps all-day events out of the grid', () => {
    const l = layout('2026-10-26', [{ ...meeting(1, '2026-10-26', '00:00', '23:59'), all_day: true }]);
    expect(l.meetings.length).toBe(0);
    expect(l.allDay.length).toBe(1);
  });
});

describe('movedStart', () => {
  it('moves by minutes on the same day', () => {
    expect(new Date(movedStart(at('2026-10-26', '10:00'), 45, 0, NY)).toISOString()).toBe(at('2026-10-26', '10:45'));
  });

  it('keeps the wall-clock time when it moves across days', () => {
    expect(new Date(movedStart(at('2026-10-26', '10:00'), 0, 2, NY)).toISOString()).toBe(at('2026-10-28', '10:00'));
  });

  it("doesn't shift an hour across a clock change", () => {
    const moved = movedStart(at('2026-10-31', '09:00'), 15, 2, NY);
    expect(new Date(moved).toISOString()).toBe(at('2026-11-02', '09:15'));
    expect(moved - Date.parse(at('2026-10-31', '09:15'))).toBe(49 * 3_600_000); // 49 real hours
  });
});
