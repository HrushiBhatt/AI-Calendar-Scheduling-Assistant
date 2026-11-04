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

const (
	stateCookie   = "bf_oauth_state"
	stateLifetime = 10 * time.Minute
	statePath     = "/api/calendar"
)

// IssueState starts an OAuth flow for userID. It returns a random state for the
// provider's redirect and stores it in a short-lived cookie signed with the session key
// and bound to the user. A state that is random but not bound to the user would let an
// attacker finish their own consent flow in a victim's browser and attach their calendar
// to the victim's account.
func (m *Manager) IssueState(c *gin.Context, userID uint) (string, error) {
	nonce := make([]byte, 24)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	state := base64.RawURLEncoding.EncodeToString(nonce)
	payload := fmt.Sprintf("%d.%d.%s", userID, time.Now().Add(stateLifetime).Unix(), state)
	c.SetSameSite(http.SameSiteLaxMode) // Lax: the cookie must come back on Google's top-level redirect
	c.SetCookie(stateCookie, payload+"."+m.mac(payload), int(stateLifetime.Seconds()), statePath, "", m.secure, true)
	return state, nil
}

// CheckState verifies the provider's returned state against the cookie and the signed-in
// user, then clears the cookie so a state can be used once.
func (m *Manager) CheckState(c *gin.Context, userID uint, state string) bool {
	raw, err := c.Cookie(stateCookie)
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(stateCookie, "", -1, statePath, "", m.secure, true)
	if err != nil || state == "" {
		return false
	}
	i := strings.LastIndexByte(raw, '.')
	if i < 0 {
		return false
	}
	payload, sig := raw[:i], raw[i+1:]
	if !hmac.Equal([]byte(sig), []byte(m.mac(payload))) {
		return false
	}
	parts := strings.SplitN(payload, ".", 3)
	if len(parts) != 3 {
		return false
	}
	owner, err1 := strconv.ParseUint(parts[0], 10, 64)
	expires, err2 := strconv.ParseInt(parts[1], 10, 64)
	if err1 != nil || err2 != nil || uint(owner) != userID || time.Now().Unix() > expires {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(parts[2]), []byte(state)) == 1
}

func (m *Manager) mac(payload string) string {
	h := hmac.New(sha256.New, m.secret)
	h.Write([]byte("oauth-state:" + payload)) // domain-separated from the session JWT
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
