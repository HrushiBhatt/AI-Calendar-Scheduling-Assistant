package scheduler

import (
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type fixture struct {
	db     *gorm.DB
	hub    *events.Hub
	engine *engine.Engine
	d      *Dispatcher
	now    time.Time
	user   uint
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	eng := engine.New(t.Context(), db, hub)
	settings := store.DefaultSettings
	settings.TimeZone = "America/New_York"
	user := store.User{Email: "ada@example.com", PasswordHash: []byte("x"), Settings: settings}
	db.Create(&user)
	f := &fixture{db: db, hub: hub, engine: eng, d: New(db, hub, eng), now: time.Date(2026, 10, 26, 14, 0, 0, 0, time.UTC), user: user.ID}
	f.d.now = func() time.Time { return f.now }
	return f
}

func (f *fixture) block(t *testing.T, startsAt time.Time, status string) store.ScheduledSession {
	t.Helper()
	b := store.ScheduledSession{UserID: f.user, PlanID: 1, Mode: "Animedoro", StartsAt: startsAt, FocusMin: 50, RestMin: 10,
		Intention: "Compiler project", Status: status}
	if err := f.db.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	return b
}

func (f *fixture) reload(t *testing.T, b store.ScheduledSession) store.ScheduledSession {
	t.Helper()
	f.db.First(&b, b.ID)
	return b
}

func awaitEvent(t *testing.T, ch <-chan events.Event, kind string) (events.Event, bool) {
	t.Helper()
	deadline := time.After(300 * time.Millisecond)
	for {
		select {
		case e := <-ch:
			if e.Type == kind {
				return e, true
			}
		case <-deadline:
			return events.Event{}, false
		}
	}
}

func TestADueBlockStartsAndTheSessionIsAttributedToIt(t *testing.T) {
	f := setup(t)
	b := f.block(t, f.now, store.BlockAccepted)
	f.d.Step()

	state := f.engine.Current(t.Context(), f.user)
	if state.Status != engine.Running || state.Intention != "Compiler project" || state.DurationMs != 50*60*1000 {
		t.Fatalf("timer = %+v", state)
	}
	b = f.reload(t, b)
	if b.Status != store.BlockStarted || b.SessionID == nil || *b.SessionID != state.SessionID {
		t.Fatalf("block = %+v", b)
	}
	var s store.Session
	f.db.First(&s, state.SessionID)
	if s.ScheduledID == nil || *s.ScheduledID != b.ID || s.Day != "2026-10-26" {
		t.Fatalf("session = %+v: the planned-vs-ad-hoc join needs ScheduledID", s)
	}
}

func TestTheWarningGoesOutOnceAMinuteAhead(t *testing.T) {
	f := setup(t)
	stream, stop := f.hub.Subscribe(f.user)
	defer stop()
	f.block(t, f.now.Add(2*time.Minute), store.BlockAccepted)
	f.d.Step()
	if _, ok := awaitEvent(t, stream, "scheduled.starting"); ok {
		t.Fatal("warned two minutes ahead")
	}
	f.now = f.now.Add(70 * time.Second)
	f.d.Step()
	e, ok := awaitEvent(t, stream, "scheduled.starting")
	if !ok {
		t.Fatal("no warning 50 seconds ahead")
	}
	if data := e.Data.(map[string]any); data["intention"] != "Compiler project" {
		t.Errorf("warning = %v", data)
	}
	f.now = f.now.Add(20 * time.Second)
	f.d.Step()
	if _, ok := awaitEvent(t, stream, "scheduled.starting"); ok {
		t.Fatal("warned twice for the same start")
	}
}

func TestADelayedBlockIsWarnedAgain(t *testing.T) {
	f := setup(t)
	stream, stop := f.hub.Subscribe(f.user)
	defer stop()
	b := f.block(t, f.now.Add(30*time.Second), store.BlockAccepted)
	f.d.Step()
	if _, ok := awaitEvent(t, stream, "scheduled.starting"); !ok {
		t.Fatal("no first warning")
	}
	f.db.Model(&b).Update("starts_at", b.StartsAt.Add(10*time.Minute)) // "Delay 10 minutes"
	f.now = f.now.Add(10 * time.Minute)
	f.d.Step()
	if _, ok := awaitEvent(t, stream, "scheduled.starting"); !ok {
		t.Fatal("no warning for the new start")
	}
}

func TestBlocksThatCameDueDuringDowntimeAreSkippedNotStarted(t *testing.T) {
	f := setup(t)
	missed := f.block(t, f.now.Add(-3*time.Hour), store.BlockAccepted)
	justNow := f.block(t, f.now.Add(-20*time.Second), store.BlockAccepted)
	future := f.block(t, f.now.Add(time.Hour), store.BlockAccepted)
	if n := f.d.Recover(); n != 1 {
		t.Fatalf("recovered %d, want 1", n)
	}
	if b := f.reload(t, missed); b.Status != store.BlockSkipped || !strings.Contains(b.Note, "server was down") {
		t.Errorf("three hours late: %+v", b)
	}
	if b := f.reload(t, future); b.Status != store.BlockAccepted {
		t.Errorf("future block: %+v", b)
	}
	// Twenty seconds late is within the grace for a restart; it starts.
	f.d.Step()
	if b := f.reload(t, justNow); b.Status != store.BlockStarted {
		t.Errorf("20 seconds late: %+v", b)
	}
}

func TestABusyTimerDefersTheBlockThenSkipsIt(t *testing.T) {
	f := setup(t)
	if _, err := f.engine.StartFocus(f.user, engine.FocusRequest{Mode: "Pomodoro", Planned: 25 * time.Minute, Day: "2026-10-26"}); err != nil {
		t.Fatal(err)
	}
	b := f.block(t, f.now, store.BlockAccepted)
	f.d.Step()
	if got := f.reload(t, b); got.Status != store.BlockAccepted {
		t.Fatalf("with a timer running: %+v", got)
	}
	f.now = f.now.Add(2 * time.Minute)
	f.d.Step()
	if got := f.reload(t, b); got.Status != store.BlockSkipped || !strings.Contains(got.Note, "another timer") {
		t.Fatalf("after the grace: %+v", got)
	}
}

func TestStartedBlocksSettleWhenTheirSessionEnds(t *testing.T) {
	f := setup(t)
	done := f.block(t, f.now, store.BlockAccepted)
	f.d.Step()
	done = f.reload(t, done)
	f.db.Model(&store.Session{}).Where("id = ?", *done.SessionID).Updates(map[string]any{"state": store.StateDone, "completed": true})
	if _, err := f.engine.Control(t.Context(), f.user, engine.Cancel); err != nil { // free the engine; the row is ours now
		t.Fatal(err)
	}
	// Cancel deleted the session, so recreate it as done to simulate a block that ran out.
	f.db.Create(&store.Session{ID: *done.SessionID, UserID: f.user, Mode: "Animedoro", State: store.StateDone, Completed: true, ScheduledID: &done.ID})

	cancelled := f.block(t, f.now.Add(time.Minute), store.BlockAccepted)
	f.now = f.now.Add(time.Minute)
	f.d.Step()
	cancelled = f.reload(t, cancelled)
	if _, err := f.engine.Control(t.Context(), f.user, engine.Cancel); err != nil {
		t.Fatal(err)
	}
	f.d.Step()

	if b := f.reload(t, done); b.Status != store.BlockDone || b.Note != "" {
		t.Errorf("completed: %+v", b)
	}
	if b := f.reload(t, cancelled); b.Status != store.BlockSkipped || !strings.Contains(b.Note, "cancelled") {
		t.Errorf("cancelled: %+v", b)
	}
}

func TestStartNowStartsEarly(t *testing.T) {
	f := setup(t)
	b := f.block(t, f.now.Add(40*time.Second), store.BlockAccepted)
	state, err := f.d.StartNow(f.user, b.ID)
	if err != nil || state.Status != engine.Running {
		t.Fatalf("%+v %v", state, err)
	}
	if _, err := f.d.StartNow(f.user, b.ID); err != ErrNotStartable {
		t.Fatalf("starting twice: %v", err)
	}
	if _, err := f.d.StartNow(f.user+1, b.ID); err == nil {
		t.Fatal("another user started the block")
	}
}

func TestItSleepsUntilTheNextWarningOrStart(t *testing.T) {
	f := setup(t)
	if got := f.d.next(); got != Tick {
		t.Errorf("nothing scheduled: %v, want %v", got, Tick)
	}
	b := f.block(t, f.now.Add(5*time.Minute+10*time.Second), store.BlockAccepted)
	if got := f.d.next(); got != Tick {
		t.Errorf("five minutes out: %v, want a full tick", got)
	}
	f.db.Model(&b).Update("starts_at", f.now.Add(80*time.Second))
	if got := f.d.next(); got != 20*time.Second {
		t.Errorf("80 seconds out: %v, want 20s (the warning)", got)
	}
	f.db.Model(&b).Update("starts_at", f.now.Add(20*time.Second))
	if got := f.d.next(); got != 20*time.Second {
		t.Errorf("20 seconds out, already warned: %v, want 20s (the start)", got)
	}
}

func TestRunStartsABlockAcceptedForSoonWithoutWaitingForATick(t *testing.T) {
	f := setup(t)
	f.d.now = time.Now
	stop := make(chan struct{})
	finished := make(chan struct{})
	go func() { f.d.Run(stop); close(finished) }()
	defer func() { close(stop); <-finished }()

	b := f.block(t, time.Now().Add(300*time.Millisecond), store.BlockAccepted)
	f.d.Wake()
	deadline := time.Now().Add(3 * time.Second)
	for f.reload(t, b).Status != store.BlockStarted {
		if time.Now().After(deadline) {
			t.Fatal("the block didn't start on time")
		}
		time.Sleep(20 * time.Millisecond)
	}
}
