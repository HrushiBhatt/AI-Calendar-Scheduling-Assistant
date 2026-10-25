package plans

import (
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

var ny, _ = time.LoadLocation("America/New_York")

type fixture struct {
	db   *gorm.DB
	hub  *events.Hub
	svc  *Service
	user store.User
	task store.Task
	acct store.CalendarAccount
}

func setup(t *testing.T) *fixture {
	t.Helper()
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	svc := New(db, hub)
	svc.Now = func() time.Time { return time.Date(2026, 10, 26, 7, 30, 0, 0, ny) } // Monday morning
	settings := store.DefaultSettings
	settings.TimeZone = "America/New_York"
	user := store.User{Email: "ada@example.com", PasswordHash: []byte("x"), Settings: settings}
	db.Create(&user)
	task := store.Task{UserID: user.ID, Title: "Compiler project", Estimate: 4}
	db.Create(&task)
	acct := store.CalendarAccount{UserID: user.ID, Provider: "demo", ExternalID: "ada", AccessToken: []byte{}, RefreshToken: []byte{}}
	db.Create(&acct)
	return &fixture{db: db, hub: hub, svc: svc, user: user, task: task, acct: acct}
}

func (f *fixture) meeting(t *testing.T, id, title string, start, end time.Time) store.CalendarEvent {
	t.Helper()
	e := store.CalendarEvent{UserID: f.user.ID, AccountID: f.acct.ID, ExternalID: id, Title: title, StartsAt: start, EndsAt: end, Busy: true}
	if err := f.db.Create(&e).Error; err != nil {
		t.Fatal(err)
	}
	return e
}

// accepted proposes two Animedoro blocks today on the task and accepts them.
func (f *fixture) accepted(t *testing.T) []store.ScheduledSession {
	t.Helper()
	view, err := f.svc.Propose(t.Context(), f.user.ID, Proposal{Args: Args{Window: "today", TaskIDs: []uint{f.task.ID}, BlocksPerTask: 2, ModeHint: "Animedoro"}, Source: store.SourceForm})
	if err != nil {
		t.Fatal(err)
	}
	view, err = f.svc.Accept(f.user.ID, view.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	return view.Blocks
}

func (f *fixture) block(t *testing.T, id uint) store.ScheduledSession {
	t.Helper()
	var b store.ScheduledSession
	f.db.First(&b, id)
	return b
}

func awaitConflict(t *testing.T, ch <-chan events.Event) map[string]any {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case e := <-ch:
			if e.Type == "plan.conflict" {
				return e.Data.(map[string]any)
			}
		case <-deadline:
			t.Fatal("no plan.conflict event")
		}
	}
}

func TestAMovedMeetingMarksTheBlockAndProposesAReplacement(t *testing.T) {
	f := setup(t)
	blocks := f.accepted(t)
	hit := blocks[0]
	stream, stop := f.hub.Subscribe(f.user.ID)
	defer stop()

	f.meeting(t, "moved", "Design review", hit.StartsAt.Add(10*time.Minute), hit.StartsAt.Add(40*time.Minute))
	if err := f.svc.Reconcile(t.Context(), f.user.ID); err != nil {
		t.Fatal(err)
	}

	got := f.block(t, hit.ID)
	if got.Status != store.BlockConflicted || !strings.Contains(got.Note, "Design review") {
		t.Fatalf("hit block = %+v", got)
	}
	if other := f.block(t, blocks[1].ID); other.Status != store.BlockAccepted {
		t.Fatalf("an untouched block changed: %+v", other)
	}
	ev := awaitConflict(t, stream)
	replacement, err := f.svc.Get(f.user.ID, ev["replacement_plan_id"].(uint))
	if err != nil {
		t.Fatal(err)
	}
	if replacement.Source != store.SourceConflict || len(replacement.Replaces) != 1 || replacement.Replaces[0] != hit.ID || len(replacement.Blocks) != 1 {
		t.Fatalf("replacement = %+v", replacement)
	}
	nb := replacement.Blocks[0]
	if nb.TaskID == nil || *nb.TaskID != f.task.ID || nb.Mode != "Animedoro" || nb.StartsAt.Equal(hit.StartsAt) {
		t.Fatalf("replacement block = %+v", nb)
	}

	// Accepting the replacement retires the conflicted block.
	if _, err := f.svc.Accept(f.user.ID, replacement.ID, nil); err != nil {
		t.Fatal(err)
	}
	if got := f.block(t, hit.ID); got.Status != store.BlockSkipped {
		t.Fatalf("after accepting the replacement the old block is %q", got.Status)
	}
}

func TestKeepingMyBlocksRestoresThem(t *testing.T) {
	f := setup(t)
	hit := f.accepted(t)[0]
	stream, stop := f.hub.Subscribe(f.user.ID)
	defer stop()
	f.meeting(t, "moved", "Design review", hit.StartsAt, hit.StartsAt.Add(30*time.Minute))
	if err := f.svc.Reconcile(t.Context(), f.user.ID); err != nil {
		t.Fatal(err)
	}
	ev := awaitConflict(t, stream)
	if _, err := f.svc.Reject(f.user.ID, ev["replacement_plan_id"].(uint)); err != nil {
		t.Fatal(err)
	}
	if got := f.block(t, hit.ID); got.Status != store.BlockAccepted || !strings.Contains(got.Note, "kept") {
		t.Fatalf("after keeping it: %+v", got)
	}
}

func TestAConflictThatGoesAwayResolvesItself(t *testing.T) {
	f := setup(t)
	hit := f.accepted(t)[0]
	stream, stop := f.hub.Subscribe(f.user.ID)
	defer stop()
	m := f.meeting(t, "moved", "Design review", hit.StartsAt, hit.StartsAt.Add(30*time.Minute))
	if err := f.svc.Reconcile(t.Context(), f.user.ID); err != nil {
		t.Fatal(err)
	}
	ev := awaitConflict(t, stream)

	f.db.Delete(&m) // the meeting moved back out
	if err := f.svc.Reconcile(t.Context(), f.user.ID); err != nil {
		t.Fatal(err)
	}
	if got := f.block(t, hit.ID); got.Status != store.BlockAccepted {
		t.Fatalf("block = %+v", got)
	}
	var replan store.Plan
	f.db.First(&replan, ev["replacement_plan_id"].(uint))
	if replan.Status != store.PlanSuperseded {
		t.Fatalf("the replacement is still %q", replan.Status)
	}
}

func TestReconcileLeavesBlocksAloneWhenNothingOverlaps(t *testing.T) {
	f := setup(t)
	blocks := f.accepted(t)
	f.meeting(t, "elsewhere", "Lunch with Sam", time.Date(2026, 10, 26, 12, 0, 0, 0, ny), time.Date(2026, 10, 26, 13, 0, 0, 0, ny))
	if err := f.svc.Reconcile(t.Context(), f.user.ID); err != nil {
		t.Fatal(err)
	}
	for _, b := range blocks {
		if got := f.block(t, b.ID); got.Status != store.BlockAccepted {
			t.Errorf("block %d is %q", b.ID, got.Status)
		}
	}
	var n int64
	f.db.Model(&store.Plan{}).Where("source = ?", store.SourceConflict).Count(&n)
	if n != 0 {
		t.Errorf("%d conflict plans for no conflict", n)
	}
}
