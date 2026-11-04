package auth

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

// The default must survive: tests lower Cost in their own process only.
func TestDefaultCost(t *testing.T) {
	if Cost != 12 {
		t.Fatalf("Cost = %d, want 12", Cost)
	}
}

func TestPasswordRoundTrip(t *testing.T) {
	Cost = bcrypt.MinCost
	defer func() { Cost = 12 }()
	hash, err := HashPassword("plum lantern gravity orbit")
	if err != nil {
		t.Fatal(err)
	}
	if !CheckPassword(hash, "plum lantern gravity orbit") {
		t.Error("the right password was refused")
	}
	if CheckPassword(hash, "plum lantern gravity orbi") {
		t.Error("a wrong password was accepted")
	}
	for _, empty := range [][]byte{nil, {}} {
		if CheckPassword(empty, "") || CheckPassword(empty, "anything") {
			t.Error("an empty hash matched")
		}
	}
	if NeedsRehash(hash) {
		t.Error("a current hash needs no rehash")
	}
	Cost = bcrypt.MinCost + 1
	if !NeedsRehash(hash) {
		t.Error("a weaker hash needs a rehash")
	}
}

func TestValidatePassword(t *testing.T) {
	for _, good := range []string{"plum lantern gravity orbit", "correct horse battery", "Zk8#vQ2!mP9$xL4"} {
		if err := ValidatePassword(good); err != nil {
			t.Errorf("%q: %v", good, err)
		}
	}
	for password, want := range map[string]string{
		"short":                      "at least",
		strings.Repeat("ab cd ", 13): "at most",
		"password1234":               "too easy",
		"brewfocus2026":              "too easy",
		"111111111111":               "too easy",
	} {
		err := ValidatePassword(password)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", password, err, want)
		}
	}
	// A password built from the account's own details is easy for an attacker to try first.
	if err := ValidatePassword("ada.lovelace@example.com", "ada.lovelace@example.com", "Ada Lovelace"); err == nil {
		t.Error("the account's own email was accepted as its password")
	}
}

// A state from one OAuth flow must not validate in another, even if a cookie is moved by
// hand to get past the cookie paths that normally keep them apart.
func TestStateFromOneFlowFailsInAnother(t *testing.T) {
	gin.SetMode(gin.TestMode)
	m := NewManager([]byte("test-secret"), false, nil)

	rec := httptest.NewRecorder()
	issuing, _ := gin.CreateTestContext(rec)
	issuing.Request = httptest.NewRequest("GET", "/", nil)
	state, err := m.IssueState(issuing, 0)
	if err != nil {
		t.Fatal(err)
	}
	value := rec.Result().Cookies()[0].Value

	check := func(cookie string, run func(*gin.Context) bool) bool {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/", nil)
		c.Request.AddCookie(&http.Cookie{Name: cookie, Value: value})
		return run(c)
	}
	if !check(calendarFlow.cookie, func(c *gin.Context) bool { return m.CheckState(c, 0, state) }) {
		t.Fatal("the state failed in its own flow")
	}
	if check(loginFlow.cookie, func(c *gin.Context) bool {
		_, ok := m.CheckLoginState(c, state)
		return ok
	}) {
		t.Error("a calendar state validated as a sign-in state")
	}
}

func TestDeriveIsUniquePerPurposeAndState(t *testing.T) {
	m := NewManager([]byte("test-secret"), false, nil)
	other := NewManager([]byte("another-secret"), false, nil)
	seen := map[string]bool{}
	for _, v := range []string{m.Derive("pkce", "s1"), m.Derive("nonce", "s1"), m.Derive("pkce", "s2"), other.Derive("pkce", "s1")} {
		if seen[v] {
			t.Errorf("repeated value %q", v)
		}
		seen[v] = true
		if len(v) < 43 {
			t.Errorf("%q is shorter than PKCE's 43-character minimum", v)
		}
	}
}
