package calendar

import (
	"strings"
	"testing"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

func (f *fixture) writeBack(t *testing.T, on bool) {
	t.Helper()
	var u store.User
	f.db.First(&u, f.user)
	u.Settings.WriteBack, u.Settings.TimeZone = on, "America/New_York"
	if err := f.db.Model(&u).Select("settings").Updates(store.User{Settings: u.Settings}).Error; err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) acceptedBlock(t *testing.T) store.ScheduledSession {
	t.Helper()
	b := store.ScheduledSession{UserID: f.user, PlanID: 1, Mode: "Animedoro", StartsAt: now.Add(2 * time.Hour), FocusMin: 50, RestMin: 10,
		Intention: "Compiler project", Status: store.BlockAccepted, Explain: "fills a 60-minute gap exactly"}
	if err := f.db.Create(&b).Error; err != nil {
		t.Fatal(err)
	}
	return b
}

func TestWriteBackCreatesUpdatesAndDeletesTheEvent(t *testing.T) {
	f := setup(t, Options{})
	acct := f.connect(t)
	f.writeBack(t, true)
	w := f.svc.NewWriter()
	b := f.acceptedBlock(t)

	if err := w.Do(t.Context(), f.user, b.ID, false); err != nil {
		t.Fatal(err)
	}
	f.db.First(&acct, acct.ID)
	f.db.First(&b, b.ID)
	written := f.fake.Written(acct.WriteCalID)
	if acct.WriteCalID == "" || len(written) != 1 || b.ExternalEventID != written[0].ID || b.CalendarAccountID == nil {
		t.Fatalf("calendar %q, written %+v, block %+v", acct.WriteCalID, written, b)
	}
	if e := written[0]; e.Title != "Focus: Compiler project" || !e.Start.Equal(b.StartsAt) || !e.End.Equal(b.StartsAt.Add(50*time.Minute)) || !e.OwnedByUs {
		t.Errorf("event = %+v", e)
	}

	// Moved: the same event follows it.
	moved := b.StartsAt.Add(time.Hour)
	f.db.Model(&store.ScheduledSession{}).Where("id = ?", b.ID).Update("starts_at", moved)
	if err := w.Do(t.Context(), f.user, b.ID, false); err != nil {
		t.Fatal(err)
	}
	if written := f.fake.Written(acct.WriteCalID); len(written) != 1 || !written[0].Start.Equal(moved) {
		t.Errorf("after the move: %+v", written)
	}

	// Dropped: the event goes, and the block forgets it.
	if err := w.Do(t.Context(), f.user, b.ID, true); err != nil {
		t.Fatal(err)
	}
	f.db.First(&b, b.ID)
	if written := f.fake.Written(acct.WriteCalID); len(written) != 0 || b.ExternalEventID != "" {
		t.Errorf("after the drop: %+v, block %+v", written, b)
	}
}

func TestWriteBackOffWritesNothing(t *testing.T) {
	f := setup(t, Options{})
	acct := f.connect(t)
	f.writeBack(t, false)
	b := f.acceptedBlock(t)
	if err := f.svc.NewWriter().Do(t.Context(), f.user, b.ID, false); err != nil {
		t.Fatal(err)
	}
	f.db.First(&acct, acct.ID)
	if acct.WriteCalID != "" {
		t.Fatal("created a calendar with write-back off")
	}
}

func TestWriteBackRecreatesACalendarTheUserDeleted(t *testing.T) {
	f := setup(t, Options{})
	acct := f.connect(t)
	f.writeBack(t, true)
	w := f.svc.NewWriter()
	if err := w.Do(t.Context(), f.user, f.acceptedBlock(t).ID, false); err != nil {
		t.Fatal(err)
	}
	f.db.First(&acct, acct.ID)
	first := acct.WriteCalID
	f.fake.DropCalendar(first)

	if err := w.Do(t.Context(), f.user, f.acceptedBlock(t).ID, false); err != nil {
		t.Fatal(err)
	}
	f.db.First(&acct, acct.ID)
	if acct.WriteCalID == first || !strings.HasPrefix(acct.WriteCalID, "fake-cal-") || len(f.fake.Written(acct.WriteCalID)) != 1 {
		t.Fatalf("calendar %q -> %q, written %v", first, acct.WriteCalID, f.fake.Written(acct.WriteCalID))
	}
}

func TestWriteBackWithoutACalendarIsANoop(t *testing.T) {
	f := setup(t, Options{})
	f.writeBack(t, true)
	if err := f.svc.NewWriter().Do(t.Context(), f.user, f.acceptedBlock(t).ID, false); err != nil {
		t.Fatalf("no account connected: %v", err)
	}
}
