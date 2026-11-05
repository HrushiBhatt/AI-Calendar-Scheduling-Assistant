package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
)

func TestStateChangingRequestsNeedTheCSRFToken(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	token := ada.csrf()
	if len(token) != 64 {
		t.Fatalf("token %q", token)
	}
	send := func(header string) int {
		req, _ := http.NewRequest("POST", ada.base+"/api/tasks", strings.NewReader(`{"title":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		if header != "" {
			req.Header.Set(auth.CSRFHeader, header)
		}
		res, err := ada.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := send(""); code != 403 {
		t.Errorf("no token: %d, want 403", code)
	}
	if code := send(strings.Repeat("0", 64)); code != 403 {
		t.Errorf("wrong token: %d, want 403", code)
	}
	if code := send(token); code != 201 {
		t.Errorf("right token: %d, want 201", code)
	}
	// Reads need no token.
	if code := ada.call("GET", "/api/tasks", nil, nil); code != 200 {
		t.Errorf("GET: %d", code)
	}
}

func TestRepeatedFailedLoginsForOneAccountAreSlowedDown(t *testing.T) {
	e := setup(t, "")
	e.signup(t, "ada@example.com")
	attacker := e.anonymous(t)
	var last int
	for range 11 {
		last = attacker.call("POST", "/api/auth/login", obj{"email": "ADA@example.com", "password": "wrong guess"}, nil)
	}
	if last != 429 {
		t.Fatalf("eleventh wrong password: %d, want 429", last)
	}
	// Other accounts are unaffected.
	if code := attacker.call("POST", "/api/auth/login", obj{"email": "bob@example.com", "password": "wrong guess"}, nil); code != 401 {
		t.Errorf("another account: %d, want 401", code)
	}
}
