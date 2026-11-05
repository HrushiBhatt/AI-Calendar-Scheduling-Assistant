package api

// Accounts: signing up, signing in and out, passwords and settings.

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

type registration struct {
	Email    string `json:"email" binding:"required,email,max=254"`
	Password string `json:"password" binding:"required,max=1024"` // the real rules are in auth.ValidatePassword
	Name     string `json:"name" binding:"max=60"`
}

type credentials struct {
	Email    string `json:"email" binding:"required,max=254"`
	Password string `json:"password" binding:"required,max=1024"`
}

type passwordChange struct {
	Current string `json:"current" binding:"required,max=1024"`
	New     string `json:"new" binding:"required,max=1024"`
}

// register creates a password account and signs it in.
func (h *handler) register(c *gin.Context) {
	var in registration
	if !bind(c, &in) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	// Checked first so a taken email doesn't cost a bcrypt hash.
	if taken, err := h.emailTaken(email); !ok(c, err) {
		return
	} else if taken {
		emailConflict(c)
		return
	}
	name := strings.TrimSpace(in.Name)
	if err := auth.ValidatePassword(in.Password, email, name); err != nil {
		badRequest(c, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if !ok(c, err) {
		return
	}
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	user := store.User{Email: email, Name: name, PasswordHash: hash, Settings: store.DefaultSettings}
	if err := h.DB.Create(&user).Error; err != nil {
		// Two sign-ups for one email can both pass the check above, because goroutines really do
		// run at once. The database's unique index is what actually decides, so a failure here
		// means the same as being taken above, not a server error.
		if taken, _ := h.emailTaken(email); taken {
			emailConflict(c)
			return
		}
		ok(c, err)
		return
	}
	if !ok(c, h.Auth.SignIn(c, user.ID)) {
		return
	}
	c.JSON(http.StatusCreated, user)
}

// emailTaken reports whether an account already uses this email.
func (h *handler) emailTaken(email string) (bool, error) {
	var n int64
	err := h.DB.Model(&store.User{}).Where("email = ?", email).Count(&n).Error
	return n > 0, err
}

func emailConflict(c *gin.Context) {
	c.JSON(http.StatusConflict, gin.H{"error": "that email already has an account, so try logging in"})
}

// login checks a password and starts a session.
func (h *handler) login(c *gin.Context) {
	var in credentials
	if !bind(c, &in) {
		return
	}
	// Per account as well as per address, so spreading guesses over many IPs doesn't help.
	if allowed, wait := h.loginAccount.Allow("login:" + strings.ToLower(strings.TrimSpace(in.Email))); !allowed {
		c.Header("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		c.JSON(http.StatusTooManyRequests, gin.H{"error": "too many sign-in attempts for this account; try again in a few minutes"})
		return
	}
	var user store.User
	err := h.DB.Where("email = ?", strings.ToLower(strings.TrimSpace(in.Email))).Limit(1).Find(&user).Error
	if !ok(c, err) {
		return
	}
	if !auth.CheckPassword(user.PasswordHash, in.Password) { // runs bcrypt even for unknown emails
		c.JSON(http.StatusUnauthorized, gin.H{"error": "wrong email or password"})
		return
	}
	if !ok(c, h.Auth.SignIn(c, user.ID)) {
		return
	}
	c.JSON(http.StatusOK, user)
}

// logout ends this browser's session.
func (h *handler) logout(c *gin.Context) {
	if ok(c, h.Auth.SignOut(c)) {
		c.Status(http.StatusNoContent)
	}
}

// logoutAll ends the user's sessions on every device, including this one. It works because
// each JWT names a database row: a JWT on its own couldn't be taken back before it expired.
func (h *handler) logoutAll(c *gin.Context) {
	if !ok(c, h.Auth.RevokeSessions(auth.UserID(c), "")) {
		return
	}
	h.Auth.ClearCookie(c)
	c.Status(http.StatusNoContent)
}

// changePassword asks for the current password, so a borrowed session can't lock the owner
// out, and ends every other session, so whoever had the old password is signed out too.
func (h *handler) changePassword(c *gin.Context) {
	var in passwordChange
	if !bind(c, &in) {
		return
	}
	uid := auth.UserID(c)
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return
	}
	if !auth.CheckPassword(user.PasswordHash, in.Current) {
		// 403, not 401: the session is fine, and a 401 would sign the page out.
		c.JSON(http.StatusForbidden, gin.H{"error": "your current password isn't right"})
		return
	}
	if err := auth.ValidatePassword(in.New, user.Email, user.Name); err != nil {
		badRequest(c, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.New)
	if !ok(c, err) {
		return
	}
	if !ok(c, h.DB.Model(&store.User{ID: uid}).Update("password_hash", hash).Error) ||
		!ok(c, h.Auth.RevokeSessions(uid, auth.SessionID(c))) {
		return
	}
	h.changed(uid, "account")
	c.Status(http.StatusNoContent)
}

// me returns the signed-in user. The app calls it on load to restore a session.
func (h *handler) me(c *gin.Context) {
	var user store.User
	if err := h.DB.First(&user, auth.UserID(c)).Error; err != nil {
		_ = h.Auth.SignOut(c) // valid token for an account that no longer exists
		c.JSON(http.StatusUnauthorized, gin.H{"error": "please log in"})
		return
	}
	c.JSON(http.StatusOK, user)
}

// saveSettings stores the user's preferences and tells their other tabs and devices.
func (h *handler) saveSettings(c *gin.Context) {
	var settings store.Settings
	if !bind(c, &settings) {
		return
	}
	uid := auth.UserID(c)
	if !ok(c, h.DB.Model(&store.User{ID: uid}).Select("settings").Updates(store.User{Settings: settings}).Error) {
		return
	}
	h.changed(uid, "settings")
	c.JSON(http.StatusOK, settings)
}
