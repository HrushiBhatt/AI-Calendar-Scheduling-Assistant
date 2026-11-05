// Package auth handles passwords and sessions, using JSON Web Tokens.
//
// Design decisions:
//
//   - The JWT rides in an HttpOnly cookie, not localStorage. Page scripts can't read it, so a
//     script injected into the page can't steal it, and the browser sends it automatically
//     with fetch and EventSource, so the frontend needs no token-handling code.
//   - HS256 with one server-side secret. There is only one service, so nothing else needs to
//     verify tokens and public-key signing would add keys to manage for no benefit.
//   - The JWT alone can't be revoked until it expires, so each token also names a row in
//     login_sessions. The signature rejects a forgery before any database lookup, and deleting
//     the row makes "log out" and "sign out everywhere" take effect at once.
//   - bcrypt for passwords, because it's deliberately slow and its cost can rise over time.
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

const (
	cookieName = "bf_session"
	// secureCookieName carries the __Host- prefix: browsers only accept it over HTTPS,
	// with Path=/ and no Domain, so a sibling subdomain can't plant or overwrite it.
	secureCookieName = "__Host-bf_session"
	lifetime         = 14 * 24 * time.Hour
	userKey          = "userID"
	sessionKey       = "sessionID"
)

// Cost is the bcrypt work factor: slow enough to make guessing expensive, and fast enough
// that a sign-in doesn't feel slow. Tests lower it to stay fast.
var Cost = 12

var errNoSession = errors.New("no valid session")

// Manager signs and checks session tokens. It holds no per-request state, so one instance is
// shared by every request, and Go's HTTP server runs each request on its own goroutine.
type Manager struct {
	secret []byte
	secure bool // add the Secure flag: set when serving over HTTPS
	db     *gorm.DB
}

// NewManager returns a session manager that signs with secret and stores sessions in db.
func NewManager(secret []byte, secureCookies bool, db *gorm.DB) *Manager {
	return &Manager{secret: secret, secure: secureCookies, db: db}
}

// Secure reports whether the app is served over HTTPS.
func (m *Manager) Secure() bool { return m.secure }

// cookie is the session cookie's name, which takes a stricter prefix over HTTPS.
func (m *Manager) cookie() string {
	if m.secure {
		return secureCookieName
	}
	return cookieName
}

// hashSlots bounds concurrent bcrypt work, so a burst of sign-ins queues instead of
// spending every CPU and stalling the timers and event streams.
var hashSlots = make(chan struct{}, runtime.GOMAXPROCS(0))

// hashSlot waits for a free slot and returns the function that gives it back.
func hashSlot() (release func()) {
	hashSlots <- struct{}{}
	return func() { <-hashSlots }
}

// HashPassword hashes with bcrypt. Check the password with ValidatePassword first:
// bcrypt refuses anything over 72 bytes.
func HashPassword(password string) ([]byte, error) {
	defer hashSlot()()
	return bcrypt.GenerateFromPassword([]byte(password), Cost)
}

// dummyHash lets a login for an unknown email take as long as a wrong password,
// so response times don't reveal which emails have accounts.
var dummyHash = sync.OnceValue(func() []byte {
	hash, _ := bcrypt.GenerateFromPassword([]byte("no such user"), Cost)
	return hash
})

// CheckPassword reports whether password matches hash. An empty hash (no such user) never
// matches, and takes just as long to say so.
func CheckPassword(hash []byte, password string) bool {
	defer hashSlot()()
	if len(hash) == 0 {
		_ = bcrypt.CompareHashAndPassword(dummyHash(), []byte(password))
		return false
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil
}

// SignIn starts a new session for userID and sets its cookie. A session this browser
// already held is ended first, so an old cookie can't outlive the new sign-in.
func (m *Manager) SignIn(c *gin.Context, userID uint) error {
	if _, sid, err := m.current(c); err == nil {
		if err := m.revoke(sid); err != nil {
			return err
		}
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	now := time.Now().UTC()
	session := store.LoginSession{ID: hex.EncodeToString(id), UserID: userID, ExpiresAt: now.Add(lifetime)}
	if err := m.db.Where("user_id = ? AND expires_at <= ?", userID, now).Delete(&store.LoginSession{}).Error; err != nil {
		return err
	}
	if err := m.db.Create(&session).Error; err != nil {
		return err
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.RegisteredClaims{
		ID:        session.ID,
		Subject:   strconv.FormatUint(uint64(userID), 10),
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(session.ExpiresAt),
	}).SignedString(m.secret)
	if err != nil {
		return err
	}
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(m.cookie(), token, int(lifetime.Seconds()), "/", "", m.secure, true)
	return nil
}

// SignOut ends the request's session, if it has one, and clears the cookie.
func (m *Manager) SignOut(c *gin.Context) error {
	var err error
	if _, sid, currentErr := m.current(c); currentErr == nil {
		err = m.revoke(sid)
	}
	m.ClearCookie(c)
	return err
}

// ClearCookie removes the session cookie from the browser.
func (m *Manager) ClearCookie(c *gin.Context) {
	c.SetSameSite(http.SameSiteLaxMode)
	c.SetCookie(m.cookie(), "", -1, "/", "", m.secure, true)
}

// RevokeSessions ends the user's sessions on every device, except keep (which may be "").
func (m *Manager) RevokeSessions(userID uint, keep string) error {
	return m.db.Where("user_id = ? AND id <> ?", userID, keep).Delete(&store.LoginSession{}).Error
}

// revoke ends one session by deleting its row.
func (m *Manager) revoke(sessionID string) error {
	return m.db.Where("id = ?", sessionID).Delete(&store.LoginSession{}).Error
}

// SessionActive reports whether a session still exists and hasn't expired. Long-lived
// event streams re-check it, so a revoked session can't keep receiving a user's events.
func (m *Manager) SessionActive(sessionID string) bool {
	var n int64
	err := m.db.Model(&store.LoginSession{}).
		Where("id = ? AND expires_at > ?", sessionID, time.Now().UTC()).Count(&n).Error
	return err == nil && n == 1
}

// current returns the user and session the request's cookie names. It fails with
// errNoSession for anything short of a validly signed token for a live session.
func (m *Manager) current(c *gin.Context) (userID uint, sessionID string, err error) {
	raw, err := c.Cookie(m.cookie())
	if err != nil {
		return 0, "", errNoSession
	}
	var claims jwt.RegisteredClaims
	// Pinning the algorithm stops a forged token from choosing its own, such as "none".
	_, err = jwt.ParseWithClaims(raw, &claims, func(*jwt.Token) (any, error) { return m.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), jwt.WithExpirationRequired())
	if err != nil || claims.ID == "" {
		return 0, "", errNoSession
	}
	id, err := strconv.ParseUint(claims.Subject, 10, 64)
	if err != nil {
		return 0, "", errNoSession
	}
	var n int64
	err = m.db.Model(&store.LoginSession{}).
		Where("id = ? AND user_id = ? AND expires_at > ?", claims.ID, id, time.Now().UTC()).Count(&n).Error
	if err != nil {
		return 0, "", err
	}
	if n != 1 {
		return 0, "", errNoSession
	}
	return uint(id), claims.ID, nil
}

// Required is Gin middleware: it rejects requests without a valid session and records the
// user for the handlers behind it, which then scope every query to that user.
func (m *Manager) Required() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, sid, err := m.current(c)
		switch {
		case errors.Is(err, errNoSession):
			unauthorized(c)
			return
		case err != nil:
			_ = c.Error(err)
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "something went wrong on our side"})
			return
		}
		c.Set(userKey, id)
		c.Set(sessionKey, sid)
		c.Next()
	}
}

// UserID is the signed-in user. Only valid behind Required.
func UserID(c *gin.Context) uint {
	return c.MustGet(userKey).(uint)
}

// SessionID is the current session. Only valid behind Required.
func SessionID(c *gin.Context) string {
	return c.MustGet(sessionKey).(string)
}

// unauthorized stops the request with a 401, which sends the app back to the login page.
func unauthorized(c *gin.Context) {
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "please log in"})
}
