import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Assistant } from './assistant';
import { LiveEvents } from './live';
import { LiveEvent, PlanView, ScheduledBlock } from './models';

const block = (id: number): ScheduledBlock => ({
  id, plan_id: 4, task_id: 1, new_task: false, session_id: null, mode: 'Animedoro', starts_at: '2026-10-26T14:00:00Z',
  focus_min: 50, rest_min: 10, intention: 'Compiler', status: 'proposed', explain: 'x', score: 1, note: '', created_at: '',
});
const plan: PlanView = {
  id: 4, status: 'proposed', source: 'form', window_start: '', window_end: '', request: '', rationale: '',
  unplaced: [], notes: [], created_at: '', blocks: [block(1), block(2), block(3)],
};

describe('Assistant', () => {
  let assistant: Assistant;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
      ],
    });
    assistant = TestBed.inject(Assistant);
    http = TestBed.inject(HttpTestingController);
  });

  it('accepts only the blocks left ticked', async () => {
    const accepting = assistant.accept(plan, new Set([2]));
    const req = http.expectOne('/api/plans/4/accept');
    expect(req.request.body).toEqual({ block_ids: [1, 3] });
    req.flush(plan);
    expect(await accepting).toBe(true);
  });

  it('sends no list when everything is accepted', async () => {
    const accepting = assistant.accept(plan, new Set());
    const req = http.expectOne('/api/plans/4/accept');
    expect(req.request.body).toEqual({});
    req.flush(plan);
    await accepting;
  });

  it('reports a refusal instead of throwing', async () => {
    const accepting = assistant.accept(plan, new Set());
    http.expectOne('/api/plans/4/accept').flush({ error: 'that overlaps Standup' }, { status: 409, statusText: 'Conflict' });
    expect(await accepting).toBe(false);
  });
});
