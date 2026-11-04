import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { Board } from './board';
import { LiveEvents } from './live';
import { LiveEvent, ScheduledBlock } from './models';

const block = (status: ScheduledBlock['status'], starts = '2099-01-01T10:00:00Z') =>
  ({ id: 7, status, starts_at: starts }) as ScheduledBlock;

describe('Board', () => {
  let board: Board;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: LiveEvents, useValue: { events$: new Subject<LiveEvent>(), connect() {}, disconnect() {} } },
      ],
    });
    board = TestBed.inject(Board);
  });

  it('ticks a proposed block on and off when clicked', () => {
    board.activate(block('proposed'));
    expect(board.excluded().has(7)).toBe(true);
    board.activate(block('proposed'));
    expect(board.excluded().has(7)).toBe(false);
    expect(board.selectedId()).toBeNull();
  });

  it('opens the details of a planned block when clicked, and closes them on a second click', () => {
    board.activate(block('accepted'));
    expect(board.selectedId()).toBe(7);
    board.activate(block('accepted'));
    expect(board.selectedId()).toBeNull();
  });

  it('lets only blocks that have not started move', () => {
    expect(board.canMove(block('proposed'))).toBe(true);
    expect(board.canMove(block('accepted'))).toBe(true);
    expect(board.canMove(block('accepted', '2001-01-01T10:00:00Z'))).toBe(false);
    expect(board.canMove(block('done'))).toBe(false);
  });
});
