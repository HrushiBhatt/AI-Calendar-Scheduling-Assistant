package engine

import (
	"context"
	"errors"
	"runtime"
	"strconv"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/events"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

type fixture struct {
	db     *gorm.DB
	hub    *events.Hub
	engine *Engine
}

func setup(t *testing.T) fixture {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	return fixture{db, hub, New(t.Context(), db, hub)}
}

// await returns the first event of the given type on ch.
func await(t *testing.T, ch <-chan events.Event, kind string) events.Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case e := <-ch:
			if e.Type == kind {
				return e
			}
		case <-deadline:
			t.Fatalf("no %q event within 3s", kind)
		}
	}
}

func focus(planned time.Duration) FocusRequest {
	return FocusRequest{Mode: "Test", Planned: planned, Intention: "ship it", Day: "2026-09-30"}
}

func TestFocusCompletesOnItsDeadline(t *testing.T) {
	f := setup(t)
	stream, stop := f.hub.Subscribe(1)
	defer stop()

	started, err := f.engine.StartFocus(1, focus(80*time.Millisecond))
	if err != nil || started.Status != Running {
		t.Fatalf("start: %+v, %v", started, err)
	}
	done := await(t, stream, "session.completed").Data.(Completed)

	if !done.Session.Completed || done.Unlocked != "sprout" {
		t.Fatalf("got %+v, want a completed session that unlocks the sprout", done)
	}
	var saved store.Session
	f.db.First(&saved, done.Session.ID)
	if saved.State != store.StateDone {
		t.Fatalf("state %q, want done", saved.State)
	}
	if now := f.engine.Current(t.Context(), 1); now.Status != Idle {
		t.Fatalf("timer still %q after completing", now.Status)
	}
}

func TestPausedTimerDoesNotExpire(t *testing.T) {
	f := setup(t)
	stream, stop := f.hub.Subscribe(1)
	defer stop()

	f.engine.StartFocus(1, focus(150*time.Millisecond))
	paused, err := f.engine.Control(t.Context(), 1, Pause)
	if err != nil || paused.Status != Paused {
		t.Fatalf("pause: %+v, %v", paused, err)
	}
	time.Sleep(300 * time.Millisecond) // well past the original deadline

	if now := f.engine.Current(t.Context(), 1); now.Status != Paused || now.RemainingMs == 0 {
		t.Fatalf("after waiting paused: %+v", now)
	}
	if _, err := f.engine.Control(t.Context(), 1, Pause); !errors.Is(err, ErrBadAction) {
		t.Fatalf("second pause: %v, want ErrBadAction", err)
	}
	f.engine.Control(t.Context(), 1, Resume)
	if done := await(t, stream, "session.completed").Data.(Completed); !done.Session.Completed {
		t.Fatal("resumed timer should run to completion")
	}
}

func TestOneTimerPerUser(t *testing.T) {
	f := setup(t)
	if _, err := f.engine.StartFocus(1, focus(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.engine.StartBreak(1, time.Minute); !errors.Is(err, ErrBusy) {
		t.Fatalf("got %v, want ErrBusy", err)
	}
	if _, err := f.engine.StartFocus(2, focus(time.Hour)); err != nil {
		t.Fatalf("another user should be unaffected: %v", err)
	}
}

func TestFinishingEarlyUnderAMinuteIsNotLogged(t *testing.T) {
	f := setup(t)
	stream, stop := f.hub.Subscribe(1)
	defer stop()

	f.engine.StartFocus(1, focus(time.Hour))
	f.engine.Control(t.Context(), 1, Finish)
	await(t, stream, "session.discarded")

	var n int64
	f.db.Model(&store.Session{}).Count(&n)
	if n != 0 {
		t.Fatalf("%d sessions stored, want 0", n)
	}
}

func TestDistractionsAreCountedOnTheSession(t *testing.T) {
	f := setup(t)
	s, _ := f.engine.StartFocus(1, focus(time.Hour))
	for range 3 {
		f.engine.Control(t.Context(), 1, Distraction)
	}
	var saved store.Session
	f.db.First(&saved, s.SessionID)
	if saved.Distractions != 3 {
		t.Fatalf("distractions = %d, want 3", saved.Distractions)
	}
}

func TestRestoreResumesTimersAfterARestart(t *testing.T) {
	f := setup(t)
	past := time.Now().Add(-time.Minute)
	f.db.Create(&store.Session{UserID: 1, Mode: "Test", Planned: 1500, Day: "2026-09-30", State: store.StateRunning, EndsAt: &past})
	f.db.Create(&store.Session{UserID: 2, Mode: "Test", Planned: 1500, Day: "2026-09-30", State: store.StatePaused, RemainingMs: 600_000})

	expired, stop := f.hub.Subscribe(1)
	defer stop()
	if err := f.engine.Restore(); err != nil {
		t.Fatal(err)
	}

	// Its deadline passed while the server was down: completes at once, full block credited.
	done := await(t, expired, "session.completed").Data.(Completed)
	if !done.Session.Completed || done.Session.Focused != 1500 {
		t.Fatalf("got %+v", done.Session)
	}
	// Paused stays paused, with its remaining time intact.
	if s := f.engine.Current(t.Context(), 2); s.Status != Paused || s.RemainingMs != 600_000 {
		t.Fatalf("paused timer restored as %+v", s)
	}
}

func TestShutdownStopsTimersWithoutLosingThem(t *testing.T) {
	db, _ := store.Open(":memory:")
	hub := events.NewHub()
	go hub.Run(t.Context())
	ctx, shutdown := context.WithCancel(t.Context())
	e := New(ctx, db, hub)
	e.StartFocus(1, focus(time.Hour))

	shutdown()
	e.Wait() // returns only once every timer goroutine has exited

	var s store.Session
	db.First(&s)
	if s.State != store.StateRunning || s.EndsAt == nil {
		t.Fatalf("session should stay running in the database for Restore, got %+v", s)
	}
}

// Many users' timers run and finish concurrently. Run with -race.
func TestManyUsersConcurrently(t *testing.T) {
	f := setup(t)
	const users = 50

	var wg sync.WaitGroup
	for u := range users {
		uid := uint(u + 1)
		stream, stop := f.hub.Subscribe(uid)
		defer stop()
		wg.Go(func() {
			if _, err := f.engine.StartFocus(uid, focus(time.Duration(20+uid)*time.Millisecond)); err != nil {
				t.Error(err)
				return
			}
			f.engine.Control(t.Context(), uid, Distraction) // commands race the deadline
			for e := range stream {
				if e.Type == "session.completed" {
					return
				}
			}
			t.Errorf("user %d: stream closed before completion", uid)
		})
	}
	wg.Wait()

	var done int64
	f.db.Model(&store.Session{}).Where("state = ?", store.StateDone).Count(&done)
	if done != users {
		t.Fatalf("%d sessions done, want %d", done, users)
	}
}

// BenchmarkRunningTimers measures what a goroutine per timer costs: total memory for that many
// running timers, each one's in-memory database row included. Run it once, for the README's chart:
//
//	go test -run '^$' -bench RunningTimers -benchtime=1x ./internal/engine
func BenchmarkRunningTimers(b *testing.B) {
	for _, n := range []int{100, 1_000, 10_000} {
		b.Run(strconv.Itoa(n), func(b *testing.B) {
			db, err := store.Open(":memory:")
			if err != nil {
				b.Fatal(err)
			}
			hub := events.NewHub()
			ctx, cancel := context.WithCancel(context.Background())
			go hub.Run(ctx)
			timers := New(ctx, db, hub)
			defer func() {
				cancel()
				timers.Wait()
			}()

			var before, after runtime.MemStats
			runtime.GC()
			runtime.ReadMemStats(&before)
			for u := range n {
				if _, err := timers.StartFocus(uint(u+1), FocusRequest{Mode: "Pomodoro", Planned: time.Hour, Day: "2026-11-04"}); err != nil {
					b.Fatal(err)
				}
			}
			runtime.GC()
			runtime.ReadMemStats(&after)
			total := (after.HeapAlloc + after.StackInuse) - (before.HeapAlloc + before.StackInuse)
			b.ReportMetric(float64(total)/(1<<20), "MB")
			b.ReportMetric(float64(total)/float64(n)/1024, "KB/timer")
		})
	}
}
