package api

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// redirectOf requests path without following redirects and returns where it pointed.
func (c *client) redirectOf(path string) (int, string) {
	c.t.Helper()
	noFollow := *c.http
	noFollow.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	req, _ := http.NewRequest("GET", c.base+path, nil)
	res, err := noFollow.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	res.Body.Close()
	return res.StatusCode, res.Header.Get("Location")
}

// connectCalendar runs the OAuth round trip against the fake provider.
func (c *client) connectCalendar() {
	c.t.Helper()
	var start struct {
		AuthURL string `json:"auth_url"`
	}
	if code := c.call("GET", "/api/calendar/connect", nil, &start); code != 200 || start.AuthURL == "" {
		c.t.Fatalf("connect: %d %+v", code, start)
	}
	if code, to := c.redirectOf(start.AuthURL); code != 302 || to != "/settings?calendar=connected" {
		c.t.Fatalf("callback: %d -> %q", code, to)
	}
}

func TestCalendarConnectFlow(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	e.fake.Put("ada@gmail.example", calendar.Event{ID: "standup", Title: "Standup", Start: time.Now().Add(time.Hour), End: time.Now().Add(2 * time.Hour), Busy: true})
	ada.connectCalendar()

	var res struct {
		Configured bool
		Accounts   []store.CalendarAccount
	}
	ada.call("GET", "/api/calendar/accounts", nil, &res)
	if !res.Configured || len(res.Accounts) != 1 || res.Accounts[0].ExternalID != "ada@gmail.example" || res.Accounts[0].LastSyncAt == nil {
		t.Fatalf("accounts = %+v", res)
	}
	if code := ada.call("DELETE", "/api/calendar/accounts/"+itoa(res.Accounts[0].ID), nil, nil); code != 204 {
		t.Fatalf("disconnect: %d", code)
	}
	ada.call("GET", "/api/calendar/accounts", nil, &res)
	if len(res.Accounts) != 0 {
		t.Fatalf("still connected: %+v", res.Accounts)
	}
}

func TestCalendarCallbackRejectsAStateItDidNotIssue(t *testing.T) {
	e := setup(t, "")
	ada, mallory := e.signup(t, "ada@example.com"), e.signup(t, "mallory@example.com")

	// Mallory starts a flow and gets a state for her own account...
	var start struct {
		AuthURL string `json:"auth_url"`
	}
	mallory.call("GET", "/api/calendar/connect", nil, &start)
	link, _ := url.Parse(start.AuthURL)
	state := link.Query().Get("state")

	// ...and gets Ada to open the callback. Ada has no matching cookie, so it fails.
	if _, to := ada.redirectOf("/api/calendar/callback?code=fake-code&state=" + url.QueryEscape(state)); to != "/settings?calendar=expired" {
		t.Fatalf("cross-user callback went to %q", to)
	}
	// A tampered state fails even with the right cookie.
	if _, to := mallory.redirectOf("/api/calendar/callback?code=fake-code&state=" + url.QueryEscape(state+"x")); to != "/settings?calendar=expired" {
		t.Fatalf("tampered state went to %q", to)
	}
	// The user declining consent is reported as such.
	if _, to := mallory.redirectOf("/api/calendar/callback?error=access_denied"); to != "/settings?calendar=denied" {
		t.Fatalf("declined consent went to %q", to)
	}
	var count int64
	e.db.Model(&store.CalendarAccount{}).Count(&count)
	if count != 0 {
		t.Fatalf("%d accounts connected", count)
	}
}

func TestScheduleUsesTheUsersDays(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	settings := store.DefaultSettings
	settings.TimeZone = "America/New_York"
	ada.call("PUT", "/api/me/settings", settings, nil)

	ny, _ := time.LoadLocation("America/New_York")
	// 2026-11-01 is the day New York falls back: 25 hours long. Events go straight into
	// the store, since a sync would drop them once that date falls outside its window.
	acct := store.CalendarAccount{UserID: ada.id, Provider: "fake", ExternalID: "ada@gmail.example", AccessToken: []byte("a"), RefreshToken: []byte("r")}
	e.db.Create(&acct)
	for _, ev := range []store.CalendarEvent{
		{UserID: ada.id, AccountID: acct.ID, ExternalID: "early", Title: "Early", StartsAt: time.Date(2026, 11, 1, 0, 30, 0, 0, ny).UTC(), EndsAt: time.Date(2026, 11, 1, 1, 0, 0, 0, ny).UTC(), Busy: true},
		{UserID: ada.id, AccountID: acct.ID, ExternalID: "late", Title: "Late", StartsAt: time.Date(2026, 11, 1, 23, 0, 0, 0, ny).UTC(), EndsAt: time.Date(2026, 11, 1, 23, 30, 0, 0, ny).UTC(), Busy: true},
		{UserID: ada.id, AccountID: acct.ID, ExternalID: "next", Title: "Next day", StartsAt: time.Date(2026, 11, 2, 0, 15, 0, 0, ny).UTC(), EndsAt: time.Date(2026, 11, 2, 0, 45, 0, 0, ny).UTC(), Busy: true},
	} {
		e.db.Create(&ev)
	}

	var res struct {
		From, To time.Time
		Events   []eventView
	}
	if code := ada.call("GET", "/api/schedule?from=2026-11-01", nil, &res); code != 200 {
		t.Fatalf("schedule: %d", code)
	}
	if res.To.Sub(res.From) != 25*time.Hour {
		t.Errorf("the fall-back day is %v long, want 25h", res.To.Sub(res.From))
	}
	var titles []string
	for _, ev := range res.Events {
		titles = append(titles, ev.Title)
	}
	if strings.Join(titles, ",") != "Early,Late" {
		t.Errorf("events = %v, want Early,Late", titles)
	}
	for _, bad := range []string{"?from=yesterday", "?from=2026-11-05&to=2026-11-01", "?from=2026-01-01&to=2026-06-01"} {
		if code := ada.call("GET", "/api/schedule"+bad, nil, nil); code != 400 {
			t.Errorf("%s: %d, want 400", bad, code)
		}
	}
}

func TestScheduleNeedsATimeZone(t *testing.T) {
	ada := setup(t, "").signup(t, "ada@example.com") // registered without one
	var res obj
	if code := ada.call("GET", "/api/schedule", nil, &res); code != 400 || !strings.Contains(res["error"].(string), "time zone") {
		t.Fatalf("%d %v", code, res)
	}
}

func TestManualSyncIsRateLimited(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	ada.connectCalendar()
	if code := ada.call("POST", "/api/calendar/sync", nil, nil); code != 200 {
		t.Fatalf("first sync: %d", code)
	}
	var res obj
	if code := ada.call("POST", "/api/calendar/sync", nil, &res); code != 429 {
		t.Fatalf("second sync within a minute: %d %v, want 429", code, res)
	}
	if code := e.signup(t, "bob@example.com").call("POST", "/api/calendar/sync", nil, nil); code != 200 {
		t.Fatalf("another user's sync: %d", code)
	}
}

func TestPushWebhookNeedsNoSessionAndAlwaysAnswers200(t *testing.T) {
	anon := setup(t, "").anonymous(t)
	req, _ := http.NewRequest("POST", anon.base+"/api/calendar/push", nil)
	req.Header.Set("X-Goog-Channel-ID", "nope")
	req.Header.Set("X-Goog-Resource-State", "exists")
	res, err := anon.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("push: %d, want 200", res.StatusCode)
	}
}
