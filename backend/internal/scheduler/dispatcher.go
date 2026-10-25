// Package scheduler starts accepted focus blocks on time.
//
// It is deliberately not part of the engine. engine.Engine owns timers that are running
// now, one goroutine per active timer. A plan holds blocks hours or days away, and a
// goroutine per future block would be thousands of parked goroutines holding state that
// belongs in the database. The Dispatcher is one goroutine reading due blocks from the
// database, which also makes it correct across restarts for free.
package scheduler

import (
	"errors"
	"log"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const (
	// Tick is the longest the dispatcher sleeps. It also wakes exactly at each block's
	// warning and start, so Tick bounds lateness only when it is woken by nothing else.
	Tick = 30 * time.Second
	// Warn is how long before a block starts that scheduled.starting goes out, so a user
	// still in a meeting that ran long can delay or skip it. A whole number of ticks:
	// with a 30-second tick and a 60-second lead, a warning is never missed between polls.
	Warn = 60 * time.Second
	// Late is how overdue a block may be and still start. Anything later is skipped, not
	// started: a 50-minute block that should have begun three hours ago is worse than none.
	Late = time.Minute
)

// Starter starts a focus timer; *engine.Engine is one.
type Starter interface {
	StartFocus(userID uint, req engine.FocusRequest) (engine.State, error)
}

// Dispatcher turns due accepted blocks into running focus sessions.
type Dispatcher struct {
	db     *gorm.DB
	hub    *events.Hub
	engine Starter
	now    func() time.Time
	wake   chan struct{}

	mu     sync.Mutex         // serialises Step and StartNow
	warned map[uint]time.Time // block ID -> the start it was warned for
}

func New(db *gorm.DB, hub *events.Hub, eng Starter) *Dispatcher {
	return &Dispatcher{db: db, hub: hub, engine: eng, now: time.Now, wake: make(chan struct{}, 1), warned: map[uint]time.Time{}}
}

// Wake makes Run look again now, e.g. after a block was accepted for one minute from now.
func (d *Dispatcher) Wake() {
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// Run recovers from downtime, then dispatches until stop is closed.
func (d *Dispatcher) Run(stop <-chan struct{}) {
	if n := d.Recover(); n > 0 {
		log.Printf("scheduler: skipped %d block(s) that came due while the server was down", n)
	}
	for {
		d.Step()
		t := time.NewTimer(d.next())
		select {
		case <-stop:
			t.Stop()
			return
		case <-t.C:
		case <-d.wake:
			t.Stop()
		}
	}
}

// Recover marks every accepted block whose start passed while the server was down as
// skipped. This is the opposite of engine.Restore, and deliberately so: a timer that was
// running when the server stopped has already begun, and the time elapsed is real focus,
// so it is resumed and credited. A block that never started never will: starting it late
// would place a focus session on top of whatever the user is doing now.
func (d *Dispatcher) Recover() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	var missed []store.ScheduledSession
	if err := d.db.Where("status = ? AND starts_at < ?", store.BlockAccepted, d.now().Add(-Late)).Find(&missed).Error; err != nil {
		log.Printf("scheduler: recovering: %v", err)
		return 0
	}
	for _, b := range missed {
		d.skip(b, "missed: the server was down when it was due")
	}
	return len(missed)
}

// Step does one pass: settle blocks whose sessions ended, start due blocks, and warn
// about blocks starting within Warn.
func (d *Dispatcher) Step() {
	d.mu.Lock()
	defer d.mu.Unlock()
	now := d.now()
	d.settle()
	d.startDue(now)
	d.warn(now)
}

// settle closes started blocks whose session is over: done if it was logged, skipped if
// the user cancelled it (the engine deletes cancelled and sub-minute sessions).
func (d *Dispatcher) settle() {
	var started []store.ScheduledSession
	if err := d.db.Where("status = ? AND session_id IS NOT NULL", store.BlockStarted).Find(&started).Error; err != nil {
		log.Printf("scheduler: settling: %v", err)
		return
	}
	for _, b := range started {
		var s store.Session
		err := d.db.Where("id = ?", *b.SessionID).Limit(1).Find(&s).Error
		switch {
		case err != nil:
			log.Printf("scheduler: settling block %d: %v", b.ID, err)
		case s.ID == 0:
			d.set(b, store.BlockSkipped, "cancelled after it started")
		case s.State == store.StateDone && s.Completed:
			d.set(b, store.BlockDone, "")
		case s.State == store.StateDone:
			d.set(b, store.BlockDone, "ended early")
		}
	}
}

func (d *Dispatcher) startDue(now time.Time) {
	var due []store.ScheduledSession
	if err := d.db.Where("status = ? AND starts_at <= ?", store.BlockAccepted, now).Order("starts_at, id").Find(&due).Error; err != nil {
		log.Printf("scheduler: finding due blocks: %v", err)
		return
	}
	for _, b := range due {
		if now.Sub(b.StartsAt) > Late {
			d.skip(b, "missed: it was due while another timer was running")
			continue
		}
		if _, err := d.start(b, now); err != nil && !errors.Is(err, engine.ErrBusy) {
			log.Printf("scheduler: starting block %d: %v", b.ID, err)
		}
		// ErrBusy: the user is already in a timer. Try again next pass until Late.
	}
}

func (d *Dispatcher) warn(now time.Time) {
	var soon []store.ScheduledSession
	if err := d.db.Where("status = ? AND starts_at > ? AND starts_at <= ?", store.BlockAccepted, now, now.Add(Warn)).Find(&soon).Error; err != nil {
		log.Printf("scheduler: finding blocks to warn about: %v", err)
		return
	}
	for _, b := range soon {
		if at, ok := d.warned[b.ID]; ok && at.Equal(b.StartsAt) {
			continue // already warned for this start; a delayed block gets a fresh warning
		}
		d.warned[b.ID] = b.StartsAt
		d.hub.Publish(b.UserID, events.Event{Type: "scheduled.starting", Data: map[string]any{
			"scheduled_id": b.ID, "starts_at": b.StartsAt, "intention": b.Intention, "focus_min": b.FocusMin, "mode": b.Mode,
		}})
	}
	for id, at := range d.warned {
		if now.Sub(at) > time.Hour {
			delete(d.warned, id)
		}
	}
}

// StartNow starts one of the user's accepted blocks immediately ("Start now" on the
// countdown), whatever time it was planned for.
func (d *Dispatcher) StartNow(userID, blockID uint) (engine.State, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var b store.ScheduledSession
	if err := d.db.Where("id = ? AND user_id = ?", blockID, userID).First(&b).Error; err != nil {
		return engine.State{}, err
	}
	if b.Status != store.BlockAccepted {
		return engine.State{}, ErrNotStartable
	}
	return d.start(b, d.now())
}

// ErrNotStartable means the block isn't accepted (it started, ended or was dropped).
var ErrNotStartable = errors.New("only an accepted block can be started")

// start hands the block to the engine, attributing the session to it. The engine's own
// "timer" event then moves every open tab into focus.
func (d *Dispatcher) start(b store.ScheduledSession, now time.Time) (engine.State, error) {
	var user store.User
	if err := d.db.First(&user, b.UserID).Error; err != nil {
		return engine.State{}, err
	}
	loc, err := user.Settings.Location()
	if err != nil {
		loc = time.UTC
	}
	state, err := d.engine.StartFocus(b.UserID, engine.FocusRequest{
		Mode: b.Mode, Planned: time.Duration(b.FocusMin) * time.Minute, Intention: b.Intention, TaskID: b.TaskID,
		Day: now.In(loc).Format("2006-01-02"), ScheduledID: &b.ID,
	})
	if err != nil {
		return state, err
	}
	sessionID := state.SessionID
	if err := d.db.Model(&b).Updates(map[string]any{"status": store.BlockStarted, "session_id": sessionID}).Error; err != nil {
		return state, err
	}
	d.changed(b.UserID)
	return state, nil
}

func (d *Dispatcher) skip(b store.ScheduledSession, note string) { d.set(b, store.BlockSkipped, note) }

func (d *Dispatcher) set(b store.ScheduledSession, status, note string) {
	if err := d.db.Model(&b).Updates(map[string]any{"status": status, "note": note}).Error; err != nil {
		log.Printf("scheduler: marking block %d %s: %v", b.ID, status, err)
		return
	}
	d.changed(b.UserID)
}

func (d *Dispatcher) changed(userID uint) {
	d.hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "schedule"}})
}

// next is how long to sleep: until the next warning or start, but never more than Tick.
func (d *Dispatcher) next() time.Duration {
	now := d.now()
	var b store.ScheduledSession
	err := d.db.Where("status = ? AND starts_at > ?", store.BlockAccepted, now).Order("starts_at").Limit(1).Find(&b).Error
	wait := Tick
	if err == nil && b.ID != 0 {
		until := b.StartsAt.Sub(now)
		if until > Warn {
			wait = min(wait, until-Warn)
		} else {
			wait = min(wait, until)
		}
	}
	return max(wait, 10*time.Millisecond)
}
