package api

import (
	"net/http/httptest"
	"testing"

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
