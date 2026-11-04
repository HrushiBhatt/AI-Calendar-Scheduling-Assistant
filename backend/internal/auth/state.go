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

// The sign-in state cookie: scoped to the Google routes, with its own MAC label so it can't be
// mistaken for a session token.
const (
	stateCookie = "bf_login_state"
	statePath   = "/api/auth/google"
	stateLabel  = "login-state:"
)

// IssueLoginState starts a sign-in. The cookie ties the flow to this browser, so an
// attacker can't send a victim to the callback with the attacker's own code and sign them
// in to the attacker's account (login CSRF). linkTo is 0 for a sign-in, or the signed-in
// user who is adding this sign-in method to their account.
func (m *Manager) IssueLoginState(c *gin.Context, linkTo uint) (string, error) {
	return m.issue(c, linkTo)
}

// CheckLoginState verifies a sign-in's state and returns who it was started for.
func (m *Manager) CheckLoginState(c *gin.Context, state string) (linkTo uint, ok bool) {
	return m.check(c, state)
}

// Derive computes a per-flow secret from the state: the PKCE verifier and the OIDC nonce.
// Only the server can compute them, they are never stored or sent to the browser, and
// each is unique because each state is random and single use.
func (m *Manager) Derive(purpose, state string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte("oauth-derive:" + purpose + ":" + state))
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// issue creates a random state and stores it, signed and bound to owner, in a short-lived cookie.
func (m *Manager) issue(c *gin.Context, owner uint) (string, error) {
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(nonce)
	payload := fmt.Sprintf("%d.%d.%s", owner, time.Now().Add(stateLifetime).Unix(), state)
	c.SetSameSite(http.SameSiteLaxMode) // Lax: the cookie must come back on Google's top-level redirect
	c.SetCookie(stateCookie, payload+"."+m.mac(payload), int(stateLifetime.Seconds()), statePath, "", m.secure, true)
	return state, nil
}

// check verifies the returned state against the cookie, then clears it so a state works only once.
func (m *Manager) check(c *gin.Context, state string) (owner uint, ok bool) {
	raw, err := c.Cookie(stateCookie)
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(stateCookie, "", -1, statePath, "", m.secure, true)
	if err != nil || state == "" {
		return 0, false
	}
	i := strings.LastIndexByte(raw, '.')
	if i < 0 {
		return 0, false
	}
	payload, sig := raw[:i], raw[i+1:]
	if !hmac.Equal([]byte(sig), []byte(m.mac(payload))) {
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

// mac signs a state cookie's contents with the session key.
func (m *Manager) mac(payload string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte(stateLabel + payload)) // domain-separated from the session JWT
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
