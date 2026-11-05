package api

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/api/middleware"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

// stolen is a copy of a browser's session cookie, as a thief would hold it.
func (c *client) stolen() *http.Cookie {
	c.t.Helper()
	req, _ := http.NewRequest("GET", c.base+"/api/me", nil)
	for _, cookie := range c.http.Jar.Cookies(req.URL) {
		if cookie.Name == "bf_session" {
			return cookie
		}
	}
	c.t.Fatal("no session cookie")
	return nil
}

// replay sends a request with nothing but the stolen cookie.
func replay(t *testing.T, base string, cookie *http.Cookie) int {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/me", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	return res.StatusCode
}

func TestSignOutEndsTheSessionOnTheServer(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	cookie := ada.stolen()
	if code := replay(t, e.server.URL, cookie); code != 200 {
		t.Fatalf("before signing out: %d", code)
	}
	if code := ada.call("POST", "/api/auth/logout", nil, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	if code := replay(t, e.server.URL, cookie); code != 401 {
		t.Errorf("a copied cookie after sign-out: %d, want 401", code)
	}
}

func TestSignOutEverywhereEndsEverySession(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	laptop := e.anonymous(t)
	if code := laptop.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": testPassword}, nil); code != 200 {
		t.Fatalf("second device: %d", code)
	}
	if code := laptop.call("POST", "/api/auth/logout-all", nil, nil); code != 204 {
		t.Fatalf("logout-all: %d", code)
	}
	if code := ada.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("the other device: %d, want 401", code)
	}
	if code := laptop.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("this device: %d, want 401", code)
	}
}

func TestSigningInAgainEndsTheBrowsersOldSession(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	old := ada.stolen()
	if code := ada.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": testPassword}, nil); code != 200 {
		t.Fatalf("login: %d", code)
	}
	if code := replay(t, e.server.URL, old); code != 401 {
		t.Errorf("the replaced session: %d, want 401", code)
	}
}

func TestChangingAPassword(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	phone := e.anonymous(t)
	phone.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": testPassword}, nil)
	const newPassword = "plum lantern gravity orbit"

	if code := ada.call("PUT", "/api/me/password", obj{"current": "not it", "new": newPassword}, nil); code != 403 {
		t.Errorf("wrong current password: %d, want 403", code)
	}
	if code := ada.call("PUT", "/api/me/password", obj{"current": testPassword, "new": "password1234"}, nil); code != 400 {
		t.Errorf("weak new password: %d, want 400", code)
	}
	if code := ada.call("PUT", "/api/me/password", obj{"current": testPassword, "new": newPassword}, nil); code != 204 {
		t.Fatalf("change: %d", code)
	}
	if code := ada.call("GET", "/api/me", nil, nil); code != 200 {
		t.Errorf("this device: %d, want it to stay signed in", code)
	}
	if code := phone.call("GET", "/api/me", nil, nil); code != 401 {
		t.Errorf("the other device: %d, want 401", code)
	}
	fresh := e.anonymous(t)
	if code := fresh.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": testPassword}, nil); code != 401 {
		t.Errorf("the old password: %d, want 401", code)
	}
	if code := fresh.call("POST", "/api/auth/login", obj{"email": "ada@example.com", "password": newPassword}, nil); code != 200 {
		t.Errorf("the new password: %d, want 200", code)
	}
}

// The demo account's password is public, so one visitor must not be able to lock out or
// sign out the others, or attach their own Google account to it.
func TestGuessingTheCurrentPasswordIsSlowedDown(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	var last int
	for range 6 {
		last = ada.call("PUT", "/api/me/password", obj{"current": "a guess", "new": "plum lantern gravity orbit"}, nil)
	}
	if last != 429 {
		t.Errorf("sixth guess: %d, want 429", last)
	}
}

func TestPasswordRules(t *testing.T) {
	e := setup(t, "")
	for name, tc := range map[string]struct {
		password string
		want     string
	}{
		"too short":      {"short pass", "at least 12"},
		"common":         {"password1234", "too easy"},
		"keyboard walk":  {"qwertyuiop123", "too easy"},
		"repeats":        {"aaaaaaaaaaaaaaaa", "too easy"},
		"their email":    {"ada.lovelace@example.com", "too easy"},
		"over 72 bytes":  {strings.Repeat("orbit plum ", 7), "at most 72"},
		"72 runes, more": {strings.Repeat("é", 72), "at most 72"}, // used to be a 500: bcrypt counts bytes
	} {
		var body struct {
			Error string `json:"error"`
		}
		code := e.anonymous(t).call("POST", "/api/auth/register", obj{"email": "ada.lovelace@example.com", "password": tc.password}, &body)
		if code != 400 || !strings.Contains(body.Error, tc.want) {
			t.Errorf("%s: %d %q, want 400 with %q", name, code, body.Error, tc.want)
		}
	}
	// An account whose password predates these rules can still sign in.
	hash, _ := auth.HashPassword("short")
	e.db.Create(&store.User{Email: "old@example.com", Name: "Old", PasswordHash: hash, Settings: store.DefaultSettings})
	if code := e.anonymous(t).call("POST", "/api/auth/login", obj{"email": "old@example.com", "password": "short"}, nil); code != 200 {
		t.Errorf("existing short password: %d, want 200", code)
	}
}

func TestSecurityHeaders(t *testing.T) {
	e := setup(t, "")
	res, err := http.Get(e.server.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	for name, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "no-store",
	} {
		if got := res.Header.Get(name); got != want {
			t.Errorf("%s: %q, want %q", name, got, want)
		}
	}
	csp := res.Header.Get("Content-Security-Policy")
	for _, want := range []string{"default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'self'"} {
		if !strings.Contains(csp, want) {
			t.Errorf("CSP %q lacks %q", csp, want)
		}
	}
	if strings.Contains(csp, "script-src 'self' 'unsafe") {
		t.Errorf("CSP allows unsafe scripts: %q", csp)
	}
	if res.Header.Get("Strict-Transport-Security") != "" {
		t.Error("HSTS over plain HTTP")
	}
}

func TestHSTSAndCookiePrefixOverHTTPS(t *testing.T) {
	e := setup(t, "")
	router := NewRouter(Deps{DB: e.db, Hub: e.hub, Engine: e.engine,
		Auth: auth.NewManager([]byte("test-secret"), true, e.db)}, "")
	token := "0123456789012345678901234567890123456789012345678901234567890123"
	req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(`{"email":"ada@example.com","password":"`+testPassword+`"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-XSRF-TOKEN", token)
	req.AddCookie(&http.Cookie{Name: "XSRF-TOKEN", Value: token})
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != 201 {
		t.Fatalf("register: %d %s", rec.Code, rec.Body)
	}
	if rec.Header().Get("Strict-Transport-Security") == "" {
		t.Error("no HSTS over HTTPS")
	}
	var session *http.Cookie
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == "__Host-bf_session" {
			session = cookie
		}
	}
	if session == nil || !session.Secure || !session.HttpOnly || session.Path != "/" || session.Domain != "" {
		t.Errorf("session cookie: %+v", session)
	}
}

func TestOversizedBodiesAreRefused(t *testing.T) {
	e := setup(t, "")
	c := e.anonymous(t)
	big := strings.Repeat("x", middleware.MaxBody+1)
	if code := c.call("POST", "/api/auth/login", obj{"email": "a@b.co", "password": big}, nil); code != 413 {
		t.Errorf("oversized body: %d, want 413", code)
	}
	if code := c.call("POST", "/api/auth/login", obj{"email": strings.Repeat("a", 300), "password": "x"}, nil); code != 400 {
		t.Errorf("oversized email: %d, want 400", code)
	}
}

func TestCrossSiteRequestsAreRefusedEvenWithAToken(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	req, _ := http.NewRequest("POST", ada.base+"/api/tasks", strings.NewReader(`{"title":"forged"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Origin", "https://evil.example")
	for _, cookie := range ada.http.Jar.Cookies(req.URL) {
		if cookie.Name == auth.CSRFCookie {
			req.Header.Set(auth.CSRFHeader, cookie.Value)
		}
	}
	res, err := ada.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 {
		t.Errorf("cross-site POST: %d, want 403", res.StatusCode)
	}
}

func TestLogsCarryNeitherCodesNorCookies(t *testing.T) {
	var logged bytes.Buffer
	// Debug mode is the worst case: it's where gin's stock recovery prints request headers.
	gin.SetMode(gin.DebugMode)
	defer gin.SetMode(gin.TestMode)
	prevDefault, prevErr := gin.DefaultWriter, gin.DefaultErrorWriter
	gin.DefaultWriter, gin.DefaultErrorWriter = &logged, &logged
	log.SetOutput(&logged)
	defer func() {
		gin.DefaultWriter, gin.DefaultErrorWriter = prevDefault, prevErr
		log.SetOutput(io.Discard)
	}()

	r := gin.New()
	r.Use(middleware.Base(false)...)
	r.GET("/ok", func(c *gin.Context) { c.Status(200) })
	r.GET("/boom", func(*gin.Context) { panic("boom") })

	req := httptest.NewRequest("GET", "/ok?code=SECRET-OAUTH-CODE&state=SECRET-STATE", nil)
	r.ServeHTTP(httptest.NewRecorder(), req)

	req = httptest.NewRequest("GET", "/boom", nil)
	req.AddCookie(&http.Cookie{Name: "bf_session", Value: "SECRET-SESSION"})
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)
	if rec.Code != 500 {
		t.Errorf("panic: %d, want 500", rec.Code)
	}
	if !strings.Contains(logged.String(), "boom") {
		t.Error("the panic wasn't logged")
	}
	for _, secret := range []string{"SECRET-OAUTH-CODE", "SECRET-STATE", "SECRET-SESSION"} {
		if strings.Contains(logged.String(), secret) {
			t.Errorf("%s reached the log:\n%s", secret, logged.String())
		}
	}
}

func TestEventStreamEndsWhenItsSessionIsRevoked(t *testing.T) {
	e := setup(t, "")
	router := NewRouter(Deps{DB: e.db, Hub: e.hub, Engine: e.engine,
		Auth: auth.NewManager([]byte("test-secret"), false, e.db), Keepalive: 20 * time.Millisecond}, "")
	server := httptest.NewServer(router)
	defer server.Close()
	ada := &client{t: t, http: e.anonymous(t).http, base: server.URL}
	if code := ada.call("POST", "/api/auth/register", obj{"email": "ada@example.com", "password": testPassword}, nil); code != 201 {
		t.Fatalf("register: %d", code)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/events", nil)
	res, err := ada.http.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if code := ada.call("POST", "/api/auth/logout", nil, nil); code != 204 {
		t.Fatalf("logout: %d", code)
	}
	if _, err := io.ReadAll(res.Body); err != nil {
		t.Errorf("the stream should end cleanly after sign-out, got %v", err)
	}
	if ctx.Err() != nil {
		t.Error("the stream was still open five seconds after sign-out")
	}
}

// The JWT is what stands between a visitor and an account, so each way of faking one must fail.
func TestForgedTokensAreRefused(t *testing.T) {
	e := setup(t, "")
	ada := e.signup(t, "ada@example.com")
	session := ada.stolen()
	claims := jwt.RegisteredClaims{}
	if _, _, err := jwt.NewParser().ParseUnverified(session.Value, &claims); err != nil {
		t.Fatal(err)
	}
	sign := func(method jwt.SigningMethod, key any, c jwt.RegisteredClaims) string {
		token, err := jwt.NewWithClaims(method, c).SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	expired := claims
	expired.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Hour))
	otherUser := claims
	otherUser.Subject = "999"
	noSession := claims
	noSession.ID = "not-a-real-session"
	for name, token := range map[string]string{
		"signed with the wrong key": sign(jwt.SigningMethodHS256, []byte("not the server's secret"), claims),
		"no signature at all":       sign(jwt.SigningMethodNone, jwt.UnsafeAllowNoneSignatureType, claims),
		"expired":                   sign(jwt.SigningMethodHS256, []byte("test-secret"), expired),
		"someone else's ID":         sign(jwt.SigningMethodHS256, []byte("test-secret"), otherUser),
		"a session that isn't real": sign(jwt.SigningMethodHS256, []byte("test-secret"), noSession),
	} {
		if code := replay(t, ada.base, &http.Cookie{Name: "bf_session", Value: token}); code != 401 {
			t.Errorf("%s: %d, want 401", name, code)
		}
	}
	if code := replay(t, ada.base, session); code != 200 {
		t.Errorf("the real token: %d, want 200", code)
	}
}
