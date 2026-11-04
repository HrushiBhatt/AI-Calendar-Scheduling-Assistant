package calendar

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/oauth2"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const testKey = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"

var now = time.Date(2026, 10, 26, 14, 0, 0, 0, time.UTC)

type fixture struct {
	db   *gorm.DB
	hub  *events.Hub
	fake *Fake
	svc  *Service
	user uint
}

func setup(t *testing.T, opts Options) *fixture {
	t.Helper()
	if err := store.SetSealKey(testKey); err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	fake := NewFake("fake", "ada@example.com")
	opts.Providers = append(opts.Providers, fake)
	if opts.ConnectVia == "" {
		opts.ConnectVia = "fake"
	}
	opts.Now = func() time.Time { return now }
	user := store.User{Email: "ada@example.com", PasswordHash: []byte("x"), Settings: store.DefaultSettings}
	db.Create(&user)
	return &fixture{db: db, hub: hub, fake: fake, svc: NewService(db, hub, opts), user: user.ID}
}

func meeting(id string, startHour, endHour int) Event {
	return Event{ID: id, Title: "Meeting " + id, Start: now.Add(time.Duration(startHour) * time.Hour), End: now.Add(time.Duration(endHour) * time.Hour), Busy: true}
}

func (f *fixture) connect(t *testing.T) store.CalendarAccount {
	t.Helper()
	acct, err := f.svc.Connect(t.Context(), f.user, "fake-code", "")
	if err != nil {
		t.Fatal(err)
	}
	return *acct
}

func (f *fixture) stored(t *testing.T) map[string]store.CalendarEvent {
	t.Helper()
	var rows []store.CalendarEvent
	f.db.Order("external_id").Find(&rows)
	out := map[string]store.CalendarEvent{}
	for _, r := range rows {
		out[r.ExternalID] = r
	}
	return out
}

func TestFirstConnectionPullsTheWindowAndSealsTokens(t *testing.T) {
	f := setup(t, Options{})
	f.fake.Put("ada@example.com", meeting("standup", 1, 2))
	f.fake.Put("ada@example.com", meeting("far-future", 24*90, 24*90+1)) // beyond the 60-day window
	f.fake.Put("ada@example.com", Event{ID: "offsite", Title: "Offsite", Start: now.Add(24 * time.Hour), End: now.Add(48 * time.Hour), AllDay: true})
	stream, stop := f.hub.Subscribe(f.user)
	defer stop()

	acct := f.connect(t)
	if acct.ExternalID != "ada@example.com" || acct.SyncToken == "" || acct.LastSyncAt == nil || acct.FullSyncAt == nil {
		t.Fatalf("account = %+v", acct)
	}
	rows := f.stored(t)
	if len(rows) != 2 || !rows["standup"].Busy || !rows["offsite"].AllDay {
		t.Fatalf("stored %v", rows)
	}
	if e := <-stream; e.Type != "calendar.synced" {
		t.Fatalf("event %q, want calendar.synced", e.Type)
	}
	var raw []byte
	f.db.Raw("SELECT access_token FROM calendar_accounts").Row().Scan(&raw)
	if strings.Contains(string(raw), "fake-access") {
		t.Fatal("access token stored in plain text")
	}
}

func TestIncrementalSyncAppliesUpsertsAndDeletes(t *testing.T) {
	f := setup(t, Options{})
	f.fake.Put("ada@example.com", meeting("standup", 1, 2))
	f.fake.Put("ada@example.com", meeting("review", 3, 4))
	acct := f.connect(t)

	moved := meeting("standup", 5, 6)
	moved.Title = "Standup (moved)"
	f.fake.Put("ada@example.com", moved)
	f.fake.Remove("ada@example.com", "review")
	f.fake.Put("ada@example.com", meeting("1on1", 7, 8))
	if err := f.svc.Sync(t.Context(), acct.ID); err != nil {
		t.Fatal(err)
	}
	rows := f.stored(t)
	if len(rows) != 2 || rows["standup"].Title != "Standup (moved)" || !rows["standup"].StartsAt.Equal(now.Add(5*time.Hour)) {
		t.Fatalf("after incremental sync: %v", rows)
	}
	if _, ok := rows["review"]; ok {
		t.Fatal("a deleted event survived")
	}

	// A sync with nothing new changes nothing and announces nothing.
	stream, stop := f.hub.Subscribe(f.user)
	defer stop()
	if err := f.svc.Sync(t.Context(), acct.ID); err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-stream:
		t.Fatalf("an unchanged sync published %q", e.Type)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestExpiredCursorTriggersAFullResync(t *testing.T) {
	f := setup(t, Options{})
	f.fake.Put("ada@example.com", meeting("standup", 1, 2))
	acct := f.connect(t)

	// While our cursor is dead, events change; only a full pull can see the deletion.
	f.fake.Reset("ada@example.com", []Event{meeting("new", 3, 4)})
	if err := f.svc.Sync(t.Context(), acct.ID); err != nil {
		t.Fatal(err)
	}
	rows := f.stored(t)
	if _, stale := rows["standup"]; stale || len(rows) != 1 {
		t.Fatalf("after resync: %v", rows)
	}

	f.fake.Put("ada@example.com", meeting("later", 5, 6))
	f.fake.ExpireCursor("ada@example.com")
	if err := f.svc.Sync(t.Context(), acct.ID); err != nil {
		t.Fatal(err)
	}
	if rows := f.stored(t); len(rows) != 2 {
		t.Fatalf("after an expired cursor: %v", rows)
	}
}

func TestSyncFailureIsRecordedWithoutTokens(t *testing.T) {
	f := setup(t, Options{})
	acct := f.connect(t)
	var stored store.CalendarAccount
	f.db.First(&stored, acct.ID)
	f.fake.SyncErr = errors.New("oauth2: refresh failed for refresh_token=" + string(stored.RefreshToken) + "&x=1: invalid_grant")
	if err := f.svc.Sync(t.Context(), acct.ID); err == nil {
		t.Fatal("want an error")
	}
	f.db.First(&stored, acct.ID)
	if !strings.Contains(stored.SyncError, "reconnect") && !strings.Contains(stored.SyncError, "connect the calendar again") {
		t.Fatalf("sync error = %q", stored.SyncError)
	}
	if strings.Contains(stored.SyncError, "fake-refresh") {
		t.Fatal("the sync error carries the refresh token")
	}
}

func TestScrubRemovesTokens(t *testing.T) {
	cred := &Credentials{AccessToken: "ya29.abcdefghijkl", RefreshToken: "1//refresh-secret-xyz"}
	err := scrub(errors.New(`Post "https://x?token=1//refresh-secret-xyz&a=b": bearer ya29.abcdefghijkl code=4/abc"`), cred)
	for _, secret := range []string{"ya29.abcdefghijkl", "refresh-secret", "4/abc"} {
		if strings.Contains(err.Error(), secret) {
			t.Errorf("%q survived: %s", secret, err)
		}
	}
	wrapped := scrub(context.DeadlineExceeded, nil)
	if !errors.Is(wrapped, context.DeadlineExceeded) {
		t.Error("scrub broke errors.Is")
	}
}

func TestDisconnectRevokesAndDeletesEverything(t *testing.T) {
	f := setup(t, Options{PublicURL: "https://brew.example"})
	f.fake.Put("ada@example.com", meeting("standup", 1, 2))
	acct := f.connect(t)
	if acct.ChannelID == "" {
		t.Fatal("no push channel registered")
	}
	if err := f.svc.Disconnect(t.Context(), f.user+1, acct.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("another user disconnecting: %v", err)
	}
	if err := f.svc.Disconnect(t.Context(), f.user, acct.ID); err != nil {
		t.Fatal(err)
	}
	var accounts, rows int64
	f.db.Model(&store.CalendarAccount{}).Count(&accounts)
	f.db.Model(&store.CalendarEvent{}).Count(&rows)
	_, _, stopped, revoked := f.fake.Stats()
	if accounts != 0 || rows != 0 || len(stopped) != 1 || len(revoked) != 1 {
		t.Fatalf("accounts=%d events=%d stopped=%v revoked=%v", accounts, rows, stopped, revoked)
	}
}

func TestPushNotificationsAreVerifiedAndDebounced(t *testing.T) {
	f := setup(t, Options{PublicURL: "https://brew.example", Debounce: 80 * time.Millisecond})
	acct := f.connect(t)
	go func() { _ = f.svc.Run(t.Context()) }()
	syncsBefore, _, _, _ := f.fake.Stats()

	if f.svc.Notify("unknown-channel", acct.ChannelToken, "exists") {
		t.Fatal("an unknown channel was accepted")
	}
	if f.svc.Notify(acct.ChannelID, "forged-token", "exists") {
		t.Fatal("a wrong token was accepted")
	}
	if !f.svc.Notify(acct.ChannelID, acct.ChannelToken, "sync") {
		t.Fatal("the channel handshake was rejected")
	}
	for range 3 { // a meeting dragged around fires several notifications
		if !f.svc.Notify(acct.ChannelID, acct.ChannelToken, "exists") {
			t.Fatal("a genuine notification was rejected")
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		syncs, _, _, _ := f.fake.Stats()
		if syncs-syncsBefore == 1 {
			break
		}
		if syncs-syncsBefore > 1 || time.Now().After(deadline) {
			t.Fatalf("%d syncs for three notifications, want 1", syncs-syncsBefore)
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(150 * time.Millisecond) // and no stragglers
	if syncs, _, _, _ := f.fake.Stats(); syncs-syncsBefore != 1 {
		t.Fatalf("%d syncs, want 1", syncs-syncsBefore)
	}
}

func TestChannelsNearExpiryAreRenewed(t *testing.T) {
	f := setup(t, Options{PublicURL: "https://brew.example"})
	acct := f.connect(t)
	f.db.Model(&store.CalendarAccount{}).Where("id = ?", acct.ID).Update("channel_expiry", now.Add(2*time.Hour))
	f.svc.RenewChannels(t.Context())
	var renewed store.CalendarAccount
	f.db.First(&renewed, acct.ID)
	_, watches, stopped, _ := f.fake.Stats()
	if renewed.ChannelID == acct.ChannelID || watches != 2 || len(stopped) != 1 {
		t.Fatalf("channel %q -> %q, watches=%d stopped=%v", acct.ChannelID, renewed.ChannelID, watches, stopped)
	}
}

func TestWithoutAPublicURLThereIsNoChannel(t *testing.T) {
	f := setup(t, Options{})
	acct := f.connect(t)
	if _, watches, _, _ := f.fake.Stats(); acct.ChannelID != "" || watches != 0 {
		t.Fatalf("registered a channel with no public URL: %q", acct.ChannelID)
	}
}

func TestEventsLeavesOutOurOwnBlocks(t *testing.T) {
	f := setup(t, Options{})
	own := meeting("ours", 1, 2)
	own.OwnedByUs = true
	f.fake.Put("ada@example.com", own)
	f.fake.Put("ada@example.com", meeting("theirs", 3, 4))
	f.connect(t)
	got, err := Events(f.db, f.user, now, now.Add(24*time.Hour))
	if err != nil || len(got) != 1 || got[0].ExternalID != "theirs" {
		t.Fatalf("events = %+v, %v", got, err)
	}
}

// ---- the Google provider, against a local stand-in for the Calendar API ----------------

func TestGoogleSyncConvertsEventsAndHandlesGone(t *testing.T) {
	var calls atomic.Int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.Header.Get("Authorization"); got != "Bearer access-1" {
			t.Errorf("authorization %q", got)
		}
		q := r.URL.Query()
		if q.Get("syncToken") == "dead" {
			w.WriteHeader(http.StatusGone)
			_, _ = w.Write([]byte(`{"error":{"code":410,"message":"Sync token is no longer valid"}}`))
			return
		}
		if q.Get("syncToken") == "" && (q.Get("timeMin") == "" || q.Get("singleEvents") != "true") {
			t.Errorf("a full pull without a window or expanded recurrences: %s", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		if q.Get("pageToken") == "" {
			_ = json.NewEncoder(w).Encode(map[string]any{"timeZone": "America/Chicago", "nextPageToken": "p2", "items": []any{
				map[string]any{"id": "busy", "summary": "Design review", "start": map[string]any{"dateTime": "2026-10-26T10:00:00-05:00"}, "end": map[string]any{"dateTime": "2026-10-26T11:00:00-05:00"}},
				map[string]any{"id": "free", "summary": "Lunch?", "transparency": "transparent", "start": map[string]any{"dateTime": "2026-10-26T12:00:00-05:00"}, "end": map[string]any{"dateTime": "2026-10-26T13:00:00-05:00"}},
				map[string]any{"id": "declined", "summary": "Optional sync", "attendees": []any{map[string]any{"email": "ada@example.com", "self": true, "responseStatus": "declined"}}, "start": map[string]any{"dateTime": "2026-10-26T14:00:00-05:00"}, "end": map[string]any{"dateTime": "2026-10-26T15:00:00-05:00"}},
			}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"timeZone": "America/Chicago", "nextSyncToken": "cursor-2", "items": []any{
			map[string]any{"id": "birthday", "summary": "Ada's birthday", "start": map[string]any{"date": "2026-10-27"}, "end": map[string]any{"date": "2026-10-28"}},
			map[string]any{"id": "ours", "summary": "Focus", "extendedProperties": map[string]any{"private": map[string]any{"brewfocus": "1"}}, "start": map[string]any{"dateTime": "2026-10-26T16:00:00Z"}, "end": map[string]any{"dateTime": "2026-10-26T17:00:00Z"}},
			map[string]any{"id": "office", "eventType": "workingLocation", "start": map[string]any{"date": "2026-10-26"}, "end": map[string]any{"date": "2026-10-27"}},
			map[string]any{"id": "gone", "status": "cancelled"},
		}})
	}))
	defer api.Close()

	g := NewGoogle("id", "secret", "http://localhost/cb")
	g.endpoint = api.URL + "/"
	g.config.Endpoint = oauth2.Endpoint{TokenURL: api.URL + "/token"}
	cred := &Credentials{AccessToken: "access-1", RefreshToken: "refresh-1", Expiry: time.Now().Add(time.Hour)}

	ch, err := g.Sync(t.Context(), cred, "", Window{Start: now, End: now.Add(48 * time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Event{}
	for _, e := range ch.Upserted {
		got[e.ID] = e
	}
	chicago, _ := time.LoadLocation("America/Chicago")
	switch {
	case ch.NextCursor != "cursor-2" || len(ch.DeletedIDs) != 1 || ch.DeletedIDs[0] != "gone":
		t.Errorf("cursor %q deleted %v", ch.NextCursor, ch.DeletedIDs)
	case len(got) != 5:
		t.Errorf("upserted %d events, want 5 (working location skipped): %v", len(got), got)
	case !got["busy"].Busy || !got["busy"].Start.Equal(time.Date(2026, 10, 26, 15, 0, 0, 0, time.UTC)):
		t.Errorf("busy = %+v", got["busy"])
	case got["free"].Busy:
		t.Error("a transparent event is busy")
	case got["declined"].Busy:
		t.Error("a declined invite is busy")
	case !got["birthday"].AllDay || !got["birthday"].Start.Equal(time.Date(2026, 10, 27, 0, 0, 0, 0, chicago)):
		t.Errorf("birthday = %+v", got["birthday"])
	case !got["ours"].OwnedByUs:
		t.Error("our own block was not recognised")
	}

	gone, err := g.Sync(t.Context(), cred, "dead", Window{})
	if err != nil || !gone.FullResync {
		t.Fatalf("410: %+v, %v", gone, err)
	}
}
