package api

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/assistant"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
)

// The Plan page offers Claude, or says it isn't set up, from this one field.
func TestUserViewSaysWhetherAModelIsAvailable(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	var me struct {
		Available bool `json:"assistant_available"`
	}
	if code := ada.call("GET", "/api/me", nil, &me); code != 200 || me.Available {
		t.Errorf("no model on the server: status %d, available %v", code, me.Available)
	}

	router := NewRouter(Deps{DB: e.db, Hub: e.hub, Engine: e.engine, Calendar: e.cal, Plans: e.plans, Dispatcher: e.disp,
		Auth:      auth.NewManager([]byte("test-secret"), false, e.db),
		Assistant: assistant.New(assistant.Stub{}, e.db, e.plans, assistant.Options{})}, "")
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)
	ada.base = server.URL
	if code := ada.call("GET", "/api/me", nil, &me); code != 200 || !me.Available {
		t.Errorf("a model on the server: status %d, available %v", code, me.Available)
	}
}

// The month view asks for up to six weeks, and one that crosses the autumn clock change is an
// hour longer. Asking for much more is still refused.
func TestScheduleServesAMonthGrid(t *testing.T) {
	ada := setup(t, "").anonymous(t)
	if code := ada.call("POST", "/api/auth/register", obj{"email": "ada@example.com", "password": testPassword, "time_zone": "America/New_York"}, nil); code != 201 {
		t.Fatalf("register: %d", code)
	}
	if code := ada.call("GET", "/api/schedule?from=2026-10-25&to=2026-12-05", nil, nil); code != 200 {
		t.Errorf("six weeks across a clock change: status %d", code)
	}
	if code := ada.call("GET", "/api/schedule?from=2026-10-25&to=2027-01-05", nil, nil); code != 400 {
		t.Errorf("ten weeks: status %d", code)
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
