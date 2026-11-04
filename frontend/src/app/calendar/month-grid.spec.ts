import { TestBed } from '@angular/core/testing';
import { CalendarEvent, ScheduledBlock } from '../core/models';
import { monthGrid, zonedInstant } from '../core/zoned';
import { MonthGrid, monthCells } from './month-grid';

const NY = 'America/New_York';
const at = (day: string, time: string) => new Date(zonedInstant(day, time, NY)).toISOString();
const days = monthGrid('2026-11-15', 0);

const event = (id: number, day: string, time = '10:00', end = '11:00', extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: `M${id}`, starts_at: at(day, time), ends_at: at(day, end), all_day: false, busy: true, ...extra,
});
const block = (id: number, day: string, status: ScheduledBlock['status'] = 'accepted', time = '13:00'): ScheduledBlock => ({
  id, plan_id: 1, task_id: null, new_task: false, session_id: null, mode: 'Pomodoro', starts_at: at(day, time),
  focus_min: 25, rest_min: 5, intention: `B${id}`, status, explain: '', score: 0, note: '', created_at: '',
});
const cell = (cells: ReturnType<typeof monthCells>, day: string) => cells.find((c) => c.day === day)!;

describe('monthCells', () => {
  it('sorts items into their days, by time', () => {
    const c = cell(monthCells(days, '2026-11', NY, [event(1, '2026-11-04')], [block(2, '2026-11-04', 'accepted', '08:00')]), '2026-11-04');
    expect(c.items.map((i) => i.title)).toEqual(['B2', 'M1']);
    expect(c.items.map((i) => i.kind)).toEqual(['focus', 'meeting']);
  });

  it('says how many more there are past three', () => {
    const c = cell(monthCells(days, '2026-11', NY, [1, 2, 3, 4, 5].map((n) => event(n, '2026-11-04')), []), '2026-11-04');
    expect([c.items.length, c.more, c.total]).toEqual([3, 2, 5]);
  });

  it('marks proposed and conflicting blocks', () => {
    const cells = monthCells(days, '2026-11', NY, [], [block(1, '2026-11-04', 'proposed'), block(2, '2026-11-05', 'conflicted')]);
    expect(cell(cells, '2026-11-04').items[0].kind).toBe('proposed');
    expect(cell(cells, '2026-11-05').items[0].kind).toBe('conflicted');
  });

  it('shows an event on every day it spans, with all-day events first', () => {
    const trip = event(1, '2026-11-04', '00:00', '00:00', { all_day: true, ends_at: at('2026-11-06', '00:00') });
    const cells = monthCells(days, '2026-11', NY, [event(2, '2026-11-05'), trip], []);
    expect(cell(cells, '2026-11-04').items.map((i) => i.title)).toEqual(['M1']);
    expect(cell(cells, '2026-11-05').items.map((i) => i.title)).toEqual(['M1', 'M2']);
    expect(cell(cells, '2026-11-06').items).toEqual([]);
  });

  it('dims days from the next month', () => {
    const cells = monthCells(days, '2026-11', NY, [], []);
    expect(cell(cells, '2026-11-30').inMonth).toBe(true);
    expect(cell(cells, '2026-12-01').inMonth).toBe(false);
  });
});

describe('MonthGrid', () => {
  it('opens the day that was chosen', () => {
    const fixture = TestBed.createComponent(MonthGrid);
    fixture.componentRef.setInput('days', days);
    fixture.componentRef.setInput('anchor', '2026-11-15');
    fixture.componentRef.setInput('today', '2026-11-04');
    fixture.componentRef.setInput('zone', NY);
    fixture.detectChanges();
    let opened = '';
    fixture.componentInstance.openDay.subscribe((d) => (opened = d));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.cell.today')?.getAttribute('data-day')).toBe('2026-11-04');
    el.querySelector<HTMLButtonElement>('[data-day="2026-11-20"]')!.click();
    expect(opened).toBe('2026-11-20');
  });
});
