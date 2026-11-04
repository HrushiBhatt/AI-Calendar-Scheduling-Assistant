import { CalendarEvent, ScheduledBlock } from '../core/models';
import { shiftDay, zonedInstant } from '../core/zoned';
import { PX_PER_MIN, layoutDay } from './day-timeline';

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

  it('keeps all-day events out of the grid', () => {
    const l = layout('2026-10-26', [{ ...meeting(1, '2026-10-26', '00:00', '23:59'), all_day: true }]);
    expect(l.meetings.length).toBe(0);
    expect(l.allDay.length).toBe(1);
  });
});
