import { TestBed } from '@angular/core/testing';
import { PlanView } from '../core/models';
import { PlanReview } from './plan-review';

const plan = (unplaced: PlanView['unplaced']): PlanView => ({
  id: 1, status: 'proposed', source: 'form', window_start: '', window_end: '', request: '', rationale: '',
  notes: [], created_at: '', blocks: [], unplaced,
});

function lines(p: PlanView): string[] {
  const fixture = TestBed.createComponent(PlanReview);
  fixture.componentRef.setInput('plan', p);
  fixture.componentRef.setInput('zone', 'America/New_York');
  fixture.detectChanges();
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.unplaced li')].map((li) => li.textContent!.trim());
}

describe('PlanReview', () => {
  it('lists partly placed tasks one by one and groups the rest by reason', () => {
    const got = lines(
      plan([
        { task_id: 1, task: 'Compiler', wanted: 2, placed: 1, reason: 'no_gap_long_enough' },
        { task_id: 2, task: 'Design doc', wanted: 2, placed: 0, reason: 'no_gap_long_enough' },
        { task_id: 3, task: 'Reviews', wanted: 2, placed: 0, reason: 'no_gap_long_enough' },
        { task_id: 4, task: 'Inbox', wanted: 1, placed: 0, reason: 'no_gap_long_enough' },
        { task_id: 5, task: 'Thesis', wanted: 3, placed: 0, reason: 'total_blocks_reached' },
      ]),
    );
    expect(got).toEqual([
      'Compiler: 1 of 2, no gap long enough',
      '3 tasks: no gap long enough',
      'Thesis: plan is full',
    ]);
  });

  it('names one or two tasks outright', () => {
    expect(lines(plan([{ task_id: 2, task: 'Design doc', wanted: 1, placed: 0, reason: 'due_date_passed' }]))).toEqual([
      'Design doc: due date passed',
    ]);
  });
});
