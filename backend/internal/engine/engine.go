// Package engine runs focus and break timers on the server, so a session keeps going
// when the browser closes and every device sees the same clock.
//
// Each active timer is an actor: one goroutine that owns its state and reacts to
// commands (pause, resume, finish, ...) arriving on a channel and to its own deadline
// firing. Nothing else touches that state, so it needs no locks.
package engine

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type Phase string

const (
	Focus Phase = "focus"
	Break Phase = "break"
)

type Status string

const (
	Idle    Status = "idle"
	Running Status = store.StateRunning
	Paused  Status = store.StatePaused
)

// Action is a command a client sends to its running timer.
type Action string

const (
	Pause       Action = "pause"
	Resume      Action = "resume"
	Finish      Action = "finish"      // end focus early (logged if at least a minute) or skip a break
	Cancel      Action = "cancel"      // abandon without logging
	Distraction Action = "distraction" // strict mode: the user left the tab mid-focus
	status      Action = "status"      // internal: read the current state
)

var (
	ErrBusy      = errors.New("a timer is already running")
	ErrNoTimer   = errors.New("no timer is running")
	ErrBadAction = errors.New("that action doesn't apply to the timer right now")
)

// MinLogged is the shortest focus block worth recording.
const MinLogged = time.Minute

// State is a user's timer as clients see it.
type State struct {
	Phase       Phase      `json:"phase"`
	Status      Status     `json:"status"`
	DurationMs  int64      `json:"duration_ms"`
	RemainingMs int64      `json:"remaining_ms"`
	EndsAt      *time.Time `json:"ends_at,omitempty"`
	SessionID   uint       `json:"session_id,omitempty"`
	Mode        string     `json:"mode,omitempty"`
	Intention   string     `json:"intention,omitempty"`
	TaskID      *uint      `json:"task_id,omitempty"`
	ServerTime  time.Time  `json:"server_time"` // lets clients correct for clock skew
}

// Completed is published when a focus block ends and is logged.
type Completed struct {
	Session  store.Session `json:"session"`
	Unlocked string        `json:"unlocked,omitempty"` // café decoration earned by this brew
}

// FocusRequest describes a focus block to start.
type FocusRequest struct {
	Mode      string
	Planned   time.Duration
	Intention string
	TaskID    *uint
	Day       string // the user's local calendar day
	// ScheduledID attributes the session to the planned block that started it (nil when
	// the user started it by hand).
	ScheduledID *uint
}

type command struct {
	action Action
	reply  chan result
}

type result struct {
	state State
	err   error
}

// timer is one actor. Only its run goroutine reads or writes state and session.
type timer struct {
	userID  uint
	state   State
	session *store.Session // nil during a break
	cmds    chan command
	done    chan struct{}
}

type Engine struct {
	ctx    context.Context
	db     *gorm.DB
	hub    *events.Hub
	mu     sync.Mutex // guards the timers registry only, never a timer's state
	timers map[uint]*timer
	wg     sync.WaitGroup
}

// New creates an engine whose timers stop when ctx is cancelled. Their state is
// already in the database by then, so Restore resumes them on the next boot.
func New(ctx context.Context, db *gorm.DB, hub *events.Hub) *Engine {
	return &Engine{ctx: ctx, db: db, hub: hub, timers: make(map[uint]*timer)}
}

// Wait blocks until every timer goroutine has exited.
func (e *Engine) Wait() { e.wg.Wait() }

// StartFocus begins a focus block, recording it immediately so it survives a restart.
func (e *Engine) StartFocus(userID uint, req FocusRequest) (State, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, busy := e.timers[userID]; busy {
		return State{}, ErrBusy
	}
	endsAt := time.Now().Add(req.Planned)
	session := &store.Session{
		UserID: userID, TaskID: req.TaskID, Mode: req.Mode, Planned: int(req.Planned.Seconds()),
		Intention: req.Intention, Day: req.Day, State: store.StateRunning, EndsAt: &endsAt,
		ScheduledID: req.ScheduledID,
	}
	if err := e.db.Create(session).Error; err != nil {
		return State{}, err
	}
	return e.spawn(userID, session, State{
		Phase: Focus, Status: Running, DurationMs: req.Planned.Milliseconds(), EndsAt: &endsAt,
		SessionID: session.ID, Mode: req.Mode, Intention: req.Intention, TaskID: req.TaskID,
	}), nil
}

// StartBreak begins a break. Breaks live in memory only and aren't logged.
func (e *Engine) StartBreak(userID uint, length time.Duration) (State, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if _, busy := e.timers[userID]; busy {
		return State{}, ErrBusy
	}
	endsAt := time.Now().Add(length)
	return e.spawn(userID, nil, State{Phase: Break, Status: Running, DurationMs: length.Milliseconds(), EndsAt: &endsAt}), nil
}

// Control sends an action to the user's timer and waits for the resulting state.
func (e *Engine) Control(ctx context.Context, userID uint, action Action) (State, error) {
	e.mu.Lock()
	t := e.timers[userID]
	e.mu.Unlock()
	if t == nil {
		return idle(Focus), ErrNoTimer
	}
	cmd := command{action: action, reply: make(chan result, 1)}
	select {
	case t.cmds <- cmd:
	case <-t.done: // finished while we were looking it up
		return idle(Focus), ErrNoTimer
	case <-ctx.Done():
		return State{}, ctx.Err()
	}
	r := <-cmd.reply // an actor always answers a command it has received
	return r.state, r.err
}

// Current returns the user's timer, or an idle state if none is running.
func (e *Engine) Current(ctx context.Context, userID uint) State {
	state, err := e.Control(ctx, userID, status)
	if err != nil {
		return idle(Focus)
	}
	return state
}

// Restore restarts the timers of focus sessions that were running or paused when the
// server stopped. One whose deadline passed during the downtime completes at once:
// the time still elapsed on the wall clock, so the full block is credited.
func (e *Engine) Restore() error {
	var sessions []store.Session
	if err := e.db.Where("state IN ?", []string{store.StateRunning, store.StatePaused}).Find(&sessions).Error; err != nil {
		return err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range sessions {
		s := &sessions[i]
		e.spawn(s.UserID, s, State{
			Phase: Focus, Status: Status(s.State), DurationMs: int64(s.Planned) * 1000,
			EndsAt: s.EndsAt, RemainingMs: s.RemainingMs,
			SessionID: s.ID, Mode: s.Mode, Intention: s.Intention, TaskID: s.TaskID,
		})
	}
	log.Printf("engine: restored %d timer(s)", len(sessions))
	return nil
}

// spawn registers a timer and starts its goroutine. e.mu must be held.
func (e *Engine) spawn(userID uint, session *store.Session, state State) State {
	t := &timer{userID: userID, state: state, session: session, cmds: make(chan command), done: make(chan struct{})}
	e.timers[userID] = t
	snap := t.snapshot() // taken before the goroutine owns t
	e.wg.Add(1)
	go e.run(t)
	e.publish(userID, "timer", snap)
	return snap
}

// run is the actor loop: the only code that touches t after spawn.
func (e *Engine) run(t *timer) {
	defer e.wg.Done()
	defer close(t.done)

	clock := time.NewTimer(0)
	defer clock.Stop()
	arm := func() {
		if t.state.Status == Running {
			clock.Reset(time.Until(*t.state.EndsAt)) // already past? fires immediately
		} else {
			clock.Stop()
		}
	}
	arm()

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-clock.C:
			e.end(t, true)
			return
		case cmd := <-t.cmds:
			state, err := e.apply(t, cmd.action)
			cmd.reply <- result{state, err}
			if state.Status == Idle {
				return
			}
			arm()
		}
	}
}

func (e *Engine) apply(t *timer, action Action) (State, error) {
	s := &t.state
	switch {
	case action == status:
		return t.snapshot(), nil
	case action == Pause && s.Status == Running:
		s.RemainingMs = max(0, time.Until(*s.EndsAt).Milliseconds())
		s.EndsAt, s.Status = nil, Paused
	case action == Resume && s.Status == Paused:
		endsAt := time.Now().Add(time.Duration(s.RemainingMs) * time.Millisecond)
		s.EndsAt, s.Status = &endsAt, Running
	case action == Distraction && t.session != nil:
		t.session.Distractions++
		e.persist(t)
		return t.snapshot(), nil // nothing visible changed, so no broadcast
	case action == Finish:
		return e.end(t, false), nil
	case action == Cancel:
		if t.session != nil {
			e.check(e.db.Delete(t.session).Error)
		}
		return e.retire(t), nil
	default:
		return t.snapshot(), ErrBadAction
	}
	e.persist(t)
	snap := t.snapshot()
	e.publish(t.userID, "timer", snap)
	return snap, nil
}

// end finishes the timer. A focus block is logged (or discarded if under a minute
// and ended early) and announced; completed means it ran all the way to zero.
func (e *Engine) end(t *timer, completed bool) State {
	var announce events.Event
	switch s := t.session; {
	case s == nil:
		announce = events.Event{Type: "break.completed", Data: map[string]bool{"completed": completed}}
	case !completed && t.elapsed() < MinLogged:
		e.check(e.db.Delete(s).Error)
		announce = events.Event{Type: "session.discarded"}
	default:
		s.State, s.EndsAt, s.RemainingMs = store.StateDone, nil, 0
		s.Completed = completed
		s.Focused = int(t.elapsed().Round(time.Second).Seconds())
		e.check(e.db.Save(s).Error)
		announce = events.Event{Type: "session.completed", Data: Completed{Session: *s, Unlocked: e.unlocked(t.userID, completed)}}
	}
	idleState := e.retire(t) // free the slot first so the client can start its break right away
	e.hub.Publish(t.userID, announce)
	return idleState
}

// retire unregisters the timer and announces that the user is idle.
func (e *Engine) retire(t *timer) State {
	e.mu.Lock()
	if e.timers[t.userID] == t {
		delete(e.timers, t.userID)
	}
	e.mu.Unlock()
	t.state = State{Phase: t.state.Phase, Status: Idle}
	snap := t.snapshot()
	e.publish(t.userID, "timer", snap)
	return snap
}

// persist writes a focus timer's live state so Restore can resume it after a restart.
func (e *Engine) persist(t *timer) {
	if s := t.session; s != nil {
		s.State, s.EndsAt, s.RemainingMs = string(t.state.Status), t.state.EndsAt, t.state.RemainingMs
		e.check(e.db.Save(s).Error)
	}
}

// unlocked reports the café decoration this brew earned, if any.
func (e *Engine) unlocked(userID uint, completed bool) string {
	if !completed {
		return ""
	}
	var n int64
	e.check(e.db.Model(&store.Session{}).Scopes(store.Done(userID)).Where("completed = ?", true).Count(&n).Error)
	return store.CafeUnlock(int(n))
}

func (e *Engine) publish(userID uint, kind string, data any) {
	e.hub.Publish(userID, events.Event{Type: kind, Data: data})
}

// check logs database errors inside a timer goroutine, which has no request to fail.
func (e *Engine) check(err error) {
	if err != nil {
		log.Printf("engine: %v", err)
	}
}

func (t *timer) snapshot() State {
	s := t.state
	s.ServerTime = time.Now()
	if s.Status == Running {
		s.RemainingMs = max(0, s.EndsAt.Sub(s.ServerTime).Milliseconds())
	}
	return s
}

func (t *timer) elapsed() time.Duration {
	return time.Duration(t.state.DurationMs-t.snapshot().RemainingMs) * time.Millisecond
}

func idle(phase Phase) State {
	return State{Phase: phase, Status: Idle, ServerTime: time.Now()}
}
