package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const stateLifetime = 10 * time.Minute

// stateFlow is one OAuth flow's cookie. Each has its own path and MAC label, so a state
// issued to connect a calendar can't be replayed to sign in, or the other way round.
type stateFlow struct{ cookie, path, label string }

var (
	calendarFlow = stateFlow{"bf_oauth_state", "/api/calendar", "oauth-state:"}
	loginFlow    = stateFlow{"bf_login_state", "/api/auth/google", "login-state:"}
)

// IssueState starts an OAuth flow for userID. It returns a random state for the
// provider's redirect and stores it in a short-lived cookie signed with the session key
// and bound to the user. A state that is random but not bound to the user would let an
// attacker finish their own consent flow in a victim's browser and attach their calendar
// to the victim's account.
func (m *Manager) IssueState(c *gin.Context, userID uint) (string, error) {
	return m.issue(c, calendarFlow, userID)
}

// CheckState verifies the provider's returned state against the cookie and the signed-in
// user, then clears the cookie so a state can be used once.
func (m *Manager) CheckState(c *gin.Context, userID uint, state string) bool {
	owner, ok := m.check(c, calendarFlow, state)
	return ok && owner == userID
}

// IssueLoginState starts a sign-in. The cookie ties the flow to this browser, so an
// attacker can't send a victim to the callback with the attacker's own code and sign them
// in to the attacker's account (login CSRF). linkTo is 0 for a sign-in, or the signed-in
// user who is adding this sign-in method to their account.
func (m *Manager) IssueLoginState(c *gin.Context, linkTo uint) (string, error) {
	return m.issue(c, loginFlow, linkTo)
}

// CheckLoginState verifies a sign-in's state and returns who it was started for.
func (m *Manager) CheckLoginState(c *gin.Context, state string) (linkTo uint, ok bool) {
	return m.check(c, loginFlow, state)
}

// Derive computes a per-flow secret from the state: the PKCE verifier and the OIDC nonce.
// Only the server can compute them, they are never stored or sent to the browser, and
// each is unique because each state is random and single use.
func (m *Manager) Derive(purpose, state string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte("oauth-derive:" + purpose + ":" + state))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

func (m *Manager) issue(c *gin.Context, flow stateFlow, owner uint) (string, error) {
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(nonce)
	payload := fmt.Sprintf("%d.%d.%s", owner, time.Now().Add(stateLifetime).Unix(), state)
	c.SetSameSite(http.SameSiteLaxMode) // Lax: the cookie must come back on Google's top-level redirect
	c.SetCookie(flow.cookie, payload+"."+m.mac(flow, payload), int(stateLifetime.Seconds()), flow.path, "", m.secure, true)
	return state, nil
}

func (m *Manager) check(c *gin.Context, flow stateFlow, state string) (owner uint, ok bool) {
	raw, err := c.Cookie(flow.cookie)
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(flow.cookie, "", -1, flow.path, "", m.secure, true)
	if err != nil || state == "" {
		return 0, false
	}
	i := strings.LastIndexByte(raw, '.')
	if i < 0 {
		return 0, false
	}
	payload, sig := raw[:i], raw[i+1:]
	if !hmac.Equal([]byte(sig), []byte(m.mac(flow, payload))) {
		return 0, false
	}
	parts := strings.SplitN(payload, ".", 3)
	if len(parts) != 3 {
		return 0, false
	}
	id, err1 := strconv.ParseUint(parts[0], 10, 64)
	expires, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || time.Now().Unix() > expires {
		return 0, false
	}
	if subtle.ConstantTimeCompare([]byte(parts[2]), []byte(state)) != 1 {
		return 0, false
	}
	return uint(id), true
}

func (m *Manager) mac(flow stateFlow, payload string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte(flow.label + payload)) // domain-separated from the session JWT and other flows
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
