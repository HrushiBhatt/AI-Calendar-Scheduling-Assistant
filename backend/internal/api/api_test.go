package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type env struct {
	server *httptest.Server
	db     *gorm.DB
	hub    *events.Hub
	engine *engine.Engine
}

const testPassword = "correct horse battery"

func setup(t *testing.T, staticDir string) *env {
	t.Helper()
	auth.Cost = bcrypt.MinCost
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard

	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	timers := engine.New(t.Context(), db, hub)
	router := NewRouter(Deps{
		DB: db, Hub: hub, Engine: timers,
		Auth: auth.NewManager([]byte("test-secret"), false, db),
	}, staticDir)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	return &env{server: server, db: db, hub: hub, engine: timers}
}

// client is one browser: it keeps its own login cookie.
type client struct {
	t    *testing.T
	http *http.Client
	base string
	id   uint
}

func (e *env) anonymous(t *testing.T) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, http: &http.Client{Jar: jar}, base: e.server.URL}
}

func (e *env) signup(t *testing.T, email string) *client {
	t.Helper()
	c := e.anonymous(t)
	var user store.User
	if code := c.call("POST", "/api/auth/register", obj{"email": email, "password": testPassword}, &user); code != 201 {
		t.Fatalf("register %s: %d", email, code)
	}
	c.id = user.ID
	return c
}

type obj = map[string]any

// call sends a JSON request and decodes the response into out (if non-nil), returning the status.
func (c *client) call(method, path string, body, out any) int {
	c.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = strings.NewReader(b)
	default:
		raw, _ := json.Marshal(b)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, c.base+path, r)
	req.Header.Set("Content-Type", "application/json")
	if method != "GET" {
		req.Header.Set(auth.CSRFHeader, c.csrf()) // what Angular's HttpClient does
	}
	res, err := c.http.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

// csrf returns the browser's XSRF-TOKEN cookie, fetching a page first if it has none.
func (c *client) csrf() string {
	u, _ := url.Parse(c.base)
	find := func() string {
		for _, ck := range c.http.Jar.Cookies(u) {
			if ck.Name == auth.CSRFCookie {
				return ck.Value
			}
		}
		return ""
	}
	if token := find(); token != "" {
		return token
	}
	res, err := c.http.Get(c.base + "/api/health")
	if err != nil {
		c.t.Fatal(err)
	}
	res.Body.Close()
	return find()
}

// ---- accounts ---------------------------------------------------------------------

func TestAccounts(t *testing.T) {
	e := setup(t, "")
	c := e.signup(t, "Ada@Example.com")

	var me store.User
	if c.call("GET", "/api/me", nil, &me); me.Email != "ada@example.com" || me.Name != "ada" || me.Settings != store.DefaultSettings {
		t.Fatalf("me = %+v", me)
	}
	if code := e.anonymous(t).call("POST", "/api/auth/register", obj{"email": "ada@example.com", "password": "another one"}, nil); code != 409 {
		t.Fatalf("duplicate email: %d, want 409", code)
	}
	c.call("POST", "/api/auth/logout", nil, nil)
	if code := c.call("GET", "/api/me", nil, nil); code != 401 {
		t.Fatalf("after logout: %d, want 401", code)
	}
	if code := c.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": "wrong password"}, nil); code != 401 {
		t.Fatalf("wrong password: %d, want 401", code)
	}
	if code := c.call("POST", "/api/auth/login", obj{"email": "nobody@example.com", "password": testPassword}, nil); code != 401 {
		t.Fatalf("unknown email: %d, want 401", code)
	}
	if code := c.call("POST", "/api/auth/login", obj{"email": " ADA@example.com", "password": testPassword}, nil); code != 200 {
		t.Fatalf("login: %d", code)
	}
	if code := c.call("GET", "/api/me", nil, nil); code != 200 {
		t.Fatalf("me after login: %d", code)
	}
}

func TestRegistrationValidation(t *testing.T) {
	e := setup(t, "")
	for _, body := range []obj{
		{"email": "not-an-email", "password": "long enough"},
		{"email": "a@b.co", "password": "short"},
		{"email": "a@b.co"},
	} {
		var res obj
		if code := e.anonymous(t).call("POST", "/api/auth/register", body, &res); code != 400 || res["error"] == "" {
			t.Errorf("%v: %d %v", body, code, res)
		}
	}
}

func TestEverythingRequiresLogin(t *testing.T) {
	e := setup(t, "")
	anon := e.anonymous(t)
	for _, path := range []string{"/api/me", "/api/presets", "/api/tasks", "/api/timer", "/api/sessions", "/api/stats", "/api/events"} {
		if code := anon.call("GET", path, nil, nil); code != 401 {
			t.Errorf("GET %s: %d, want 401", path, code)
		}
	}
}

func TestUsersCannotTouchEachOthersData(t *testing.T) {
	e := setup(t, "")
	ada, bob := e.signup(t, "ada@example.com"), e.signup(t, "bob@example.com")

	var preset store.Preset
	ada.call("POST", "/api/presets", obj{"name": "Thesis", "focus": 75, "rest": 15}, &preset)
	var task taskView
	ada.call("POST", "/api/tasks", obj{"title": "Write chapter 2"}, &task)

	var presets, tasks []obj
	bob.call("GET", "/api/presets", nil, &presets)
	bob.call("GET", "/api/tasks", nil, &tasks)
	if len(presets) != 0 || len(tasks) != 0 {
		t.Fatalf("bob sees ada's data: %v %v", presets, tasks)
	}
	for _, attempt := range []struct{ method, path string }{
		{"DELETE", "/api/presets/" + itoa(preset.ID)},
		{"PATCH", "/api/tasks/" + itoa(task.ID)},
		{"DELETE", "/api/tasks/" + itoa(task.ID)},
	} {
		if code := bob.call(attempt.method, attempt.path, obj{"done": true}, nil); code != 404 {
			t.Errorf("bob %s %s: %d, want 404", attempt.method, attempt.path, code)
		}
	}
	if code := bob.call("POST", "/api/timer/focus", obj{"mode": "x", "planned": 1500, "day": "2026-09-30", "task_id": task.ID}, nil); code != 404 {
		t.Errorf("bob focusing on ada's task: %d, want 404", code)
	}
}

// ---- presets & tasks ----------------------------------------------------------------

func TestPresetValidation(t *testing.T) {
	c := setup(t, "").signup(t, "ada@example.com")
	for _, body := range []any{
		obj{"name": " ", "focus": 25, "rest": 5},
		obj{"name": "x", "focus": 0, "rest": 5},
		obj{"name": "x", "focus": 25, "rest": 61},
		obj{"name": "x", "focus": "25", "rest": 5},
		obj{"name": "x", "focus": true, "rest": 5},
		obj{"name": strings.Repeat("x", 33), "focus": 25, "rest": 5},
		obj{"name": "x", "focus": 25},
		"not json",
	} {
		var res obj
		if code := c.call("POST", "/api/presets", body, &res); code != 400 || res["error"] == "" {
			t.Errorf("%v: %d %v", body, code, res)
		}
	}
	var p obj
	if code := c.call("POST", "/api/presets", obj{"name": " Thesis ", "focus": 75, "rest": 0}, &p); code != 201 || p["name"] != "Thesis" || p["rest"] != 0.0 {
		t.Fatalf("valid preset: %d %v", code, p)
	}
}

func TestTasksTrackFocusTime(t *testing.T) {
	e := setup(t, "")
	c := e.signup(t, "ada@example.com")
	var task taskView
	c.call("POST", "/api/tasks", obj{"title": "Write chapter 2", "estimate": 4}, &task)

	e.db.Create(&store.Session{UserID: c.id, TaskID: &task.ID, Mode: "Pomodoro", Planned: 1500, Focused: 1500, Completed: true, Day: "2026-09-30", State: store.StateDone})
	e.db.Create(&store.Session{UserID: c.id, TaskID: &task.ID, Mode: "Pomodoro", Planned: 1500, Focused: 600, Day: "2026-09-30", State: store.StateDone})

	var tasks []taskView
	c.call("GET", "/api/tasks", nil, &tasks)
	if len(tasks) != 1 || tasks[0].Brews != 1 || tasks[0].Minutes != 35 || tasks[0].Estimate != 4 {
		t.Fatalf("tasks = %+v", tasks)
	}
	c.call("PATCH", "/api/tasks/"+itoa(task.ID), obj{"done": true}, nil)
	c.call("GET", "/api/tasks", nil, &tasks)
	if !tasks[0].Done {
		t.Fatal("task not marked done")
	}
}

// ---- timer & live events ------------------------------------------------------------

func TestTimerOverHTTP(t *testing.T) {
	e := setup(t, "")
	c := e.signup(t, "ada@example.com")
	var task taskView
	c.call("POST", "/api/tasks", obj{"title": "Write chapter 2"}, &task)

	var state engine.State
	c.call("POST", "/api/timer/focus", obj{"mode": "Pomodoro", "planned": 1500, "day": "2026-09-30", "task_id": task.ID}, &state)
	if state.Status != engine.Running || state.Intention != "Write chapter 2" || state.RemainingMs <= 0 {
		t.Fatalf("start: %+v", state)
	}
	if code := c.call("POST", "/api/timer/break", obj{"length": 300}, nil); code != 409 {
		t.Fatalf("second timer: %d, want 409", code)
	}
	c.call("POST", "/api/timer/pause", nil, &state)
	c.call("GET", "/api/timer", nil, &state)
	if state.Status != engine.Paused {
		t.Fatalf("after pause: %+v", state)
	}
	c.call("POST", "/api/timer/cancel", nil, &state)
	if state.Status != engine.Idle {
		t.Fatalf("after cancel: %+v", state)
	}
	if code := c.call("POST", "/api/timer/pause", nil, nil); code != 409 {
		t.Fatalf("pause with no timer: %d, want 409", code)
	}
	if code := c.call("POST", "/api/timer/explode", nil, nil); code != 404 {
		t.Fatalf("unknown action: %d, want 404", code)
	}
	var sessions []obj
	c.call("GET", "/api/sessions", nil, &sessions)
	if len(sessions) != 0 {
		t.Fatalf("a cancelled block was logged: %v", sessions)
	}
}

// The event stream opens with a snapshot, then pushes changes made from any other tab.
func TestEventStreamSyncsTabs(t *testing.T) {
	e := setup(t, "")
	phone := e.signup(t, "ada@example.com")
	laptop := &client{t: t, http: &http.Client{Jar: phone.http.Jar}, base: phone.base} // same account, second device

	req, _ := http.NewRequestWithContext(t.Context(), "GET", phone.base+"/api/events", nil)
	res, err := phone.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content type %q", ct)
	}
	stream := sseReader(res.Body)

	if kind, data := stream(); kind != "timer" || data["status"] != "idle" {
		t.Fatalf("snapshot = %s %v", kind, data)
	}
	laptop.call("POST", "/api/timer/focus", obj{"mode": "Pomodoro", "planned": 1500, "day": "2026-09-30"}, nil)
	if kind, data := stream(); kind != "timer" || data["status"] != "running" {
		t.Fatalf("after laptop started: %s %v", kind, data)
	}
}

// sseReader returns a function that reads the next "event:/data:" pair from an SSE body.
func sseReader(body io.Reader) func() (string, obj) {
	lines := bufio.NewScanner(body)
	return func() (string, obj) {
		var kind string
		var data obj
		done := make(chan struct{})
		go func() {
			defer close(done)
			for lines.Scan() {
				line := lines.Text()
				switch {
				case strings.HasPrefix(line, "event:"):
					kind = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
				case strings.HasPrefix(line, "data:"):
					_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data:")), &data)
				case line == "" && kind != "":
					return
				}
			}
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
		}
		return kind, data
	}
}

// ---- journal & stats ------------------------------------------------------------------

const today = "2026-09-30"

func day(offset int) string {
	t, _ := time.Parse(dayLayout, today)
	return t.AddDate(0, 0, -offset).Format(dayLayout)
}

func (e *env) logSession(userID uint, dayStr string, focused int, completed bool) store.Session {
	s := store.Session{UserID: userID, Mode: "Pomodoro", Planned: 1500, Focused: focused, Completed: completed, Day: dayStr, State: store.StateDone}
	e.db.Create(&s)
	return s
}

func TestJournalAndReflections(t *testing.T) {
	e := setup(t, "")
	c := e.signup(t, "ada@example.com")
	first := e.logSession(c.id, day(0), 1500, true)
	e.logSession(c.id, day(0), 600, false)
	running := time.Now().Add(time.Hour)
	e.db.Create(&store.Session{UserID: c.id, Mode: "Pomodoro", Planned: 1500, Day: day(0), State: store.StateRunning, EndsAt: &running})

	var saved store.Session
	c.call("PATCH", "/api/sessions/"+itoa(first.ID), obj{"reflection": "  Drafted the intro. "}, &saved)
	if saved.Reflection != "Drafted the intro." {
		t.Fatalf("reflection = %q", saved.Reflection)
	}
	var journal []store.Session
	c.call("GET", "/api/sessions", nil, &journal)
	if len(journal) != 2 || journal[0].Focused != 600 || journal[1].Reflection != "Drafted the intro." {
		t.Fatalf("journal = %+v (running sessions must not appear)", journal)
	}
	if code := c.call("PATCH", "/api/sessions/999", obj{"reflection": "x"}, nil); code != 404 {
		t.Fatalf("missing session: %d", code)
	}
	c.call("DELETE", "/api/sessions", nil, nil)
	c.call("GET", "/api/sessions", nil, &journal)
	if len(journal) != 0 {
		t.Fatalf("after clearing: %d sessions", len(journal))
	}
}

func TestStatsStreaksAndHeatmap(t *testing.T) {
	e := setup(t, "")
	c := e.signup(t, "ada@example.com")
	other := e.signup(t, "bob@example.com")
	for _, offset := range []int{0, 1, 3, 4, 5, 400} {
		e.logSession(c.id, day(offset), 1500, true)
	}
	e.logSession(c.id, day(0), 600, false)
	e.logSession(other.id, day(2), 1500, true) // must not bridge ada's gap

	var stats struct {
		Today      struct{ Minutes, Sessions int }
		Streak     int
		BestStreak int `json:"best_streak"`
		Total      struct{ Minutes, Sessions, Completed int }
		Heatmap    map[string]int
	}
	c.call("GET", "/api/stats?today="+today, nil, &stats)
	if stats.Today.Minutes != 35 || stats.Today.Sessions != 2 {
		t.Errorf("today = %+v", stats.Today)
	}
	if stats.Streak != 2 || stats.BestStreak != 3 {
		t.Errorf("streak = %d, best = %d; want 2 and 3", stats.Streak, stats.BestStreak)
	}
	if stats.Total.Minutes != 160 || stats.Total.Sessions != 7 || stats.Total.Completed != 6 {
		t.Errorf("total = %+v", stats.Total)
	}
	if _, old := stats.Heatmap[day(400)]; old || stats.Heatmap[day(3)] != 25 {
		t.Errorf("heatmap = %v", stats.Heatmap)
	}

	// A streak survives until the end of today, and breaks after a missed day.
	c.call("GET", "/api/stats?today="+day(-1), nil, &stats)
	if stats.Streak != 2 {
		t.Errorf("tomorrow's streak = %d, want 2", stats.Streak)
	}
	c.call("GET", "/api/stats?today="+day(-2), nil, &stats)
	if stats.Streak != 0 {
		t.Errorf("streak after a missed day = %d, want 0", stats.Streak)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	c := setup(t, "").signup(t, "ada@example.com")
	want := store.Settings{Sound: false, Notify: true, AutoBreak: false, Strict: true, Breathe: false, Tick: "ominous"}
	if code := c.call("PUT", "/api/me/settings", want, nil); code != 200 {
		t.Fatalf("save: %d", code)
	}
	var me store.User
	c.call("GET", "/api/me", nil, &me)
	if me.Settings != want {
		t.Fatalf("settings = %+v", me.Settings)
	}
	var res obj
	if code := c.call("PUT", "/api/me/settings", obj{"tick": "loud"}, &res); code != 400 || res["error"] == "" {
		t.Errorf("invalid tick: %d %v, want 400", code, res)
	}
}

// An event with no data has to reach the page as JSON, or it throws and the event is lost.
func TestAnEventWithNoDataIsStillJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.SSEvent("session.discarded", eventData(nil))
	if body := rec.Body.String(); !strings.Contains(body, "data:null") {
		t.Errorf("wrote %q", body)
	}
	rec = httptest.NewRecorder()
	c, _ = gin.CreateTestContext(rec)
	c.SSEvent("changed", eventData(gin.H{"kind": "tasks"}))
	if body := rec.Body.String(); !strings.Contains(body, `"kind":"tasks"`) {
		t.Errorf("wrote %q", body)
	}
}

// ---- routing ------------------------------------------------------------------------------

func TestUnknownAPIRouteIsJSON404(t *testing.T) {
	var res obj
	if code := setup(t, "").anonymous(t).call("GET", "/api/nope", nil, &res); code != 404 || res["error"] != "not found" {
		t.Fatalf("%d %v", code, res)
	}
}

func TestServesTheAngularApp(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<app-root>"), 0o644)
	os.WriteFile(filepath.Join(dir, "main.js"), []byte("bootstrap()"), 0o644)
	c := setup(t, dir).anonymous(t)

	get := func(path string) string {
		res, err := c.http.Get(c.base + path)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		body, _ := io.ReadAll(res.Body)
		return string(body)
	}
	for path, want := range map[string]string{"/": "<app-root>", "/progress": "<app-root>", "/main.js": "bootstrap()"} {
		if body := get(path); body != want {
			t.Errorf("GET %s = %q, want %q", path, body, want)
		}
	}
	for _, path := range []string{"/../../etc/passwd", "/..%2f..%2fetc/passwd"} {
		if body := get(path); strings.Contains(body, "root:") {
			t.Errorf("GET %s escaped the static directory", path)
		}
	}
}

func itoa(id uint) string { return strconv.FormatUint(uint64(id), 10) }
