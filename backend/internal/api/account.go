package api

// Accounts: signing up, signing in and out, passwords and settings.

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/demo"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
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
	Current string `json:"current" binding:"max=1024"` // empty only for an account without a password
	New     string `json:"new" binding:"required,max=1024"`
}

// userView is a user plus how they can sign in. The hash itself is never serialized.
type userView struct {
	store.User
	HasPassword  bool `json:"has_password"`
	GoogleLinked bool `json:"google_linked"`
}

// viewOf adds how the user can sign in, for the account section of Settings.
func (h *handler) viewOf(user store.User) (userView, error) {
	var linked int64
	err := h.DB.Model(&store.Identity{}).Where("user_id = ? AND provider = ?", user.ID, "google").Count(&linked).Error
	return userView{User: user, HasPassword: len(user.PasswordHash) > 0, GoogleLinked: linked > 0}, err
}

// register creates a password account and signs it in.
func (h *handler) register(c *gin.Context) {
	var in registration
	if !bind(c, &in) {
		return
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	var taken int64
	if !ok(c, h.DB.Model(&store.User{}).Where("email = ?", email).Count(&taken).Error) {
		return
	}
	if taken > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "that email already has an account, so try logging in"})
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
	if !ok(c, h.DB.Create(&user).Error) || !ok(c, h.Auth.SignIn(c, user.ID)) {
		return
	}
	if view, err := h.viewOf(user); ok(c, err) {
		c.JSON(http.StatusCreated, view)
	}
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
	if auth.NeedsRehash(user.PasswordHash) {
		// Sign-in is the only moment the password is at hand, so old hashes upgrade here.
		if hash, err := auth.HashPassword(in.Password); err == nil {
			if err := h.DB.Model(&store.User{ID: user.ID}).Update("password_hash", hash).Error; err != nil {
				_ = c.Error(err) // the sign-in still succeeds; it upgrades next time
			}
		}
	}
	if !ok(c, h.Auth.SignIn(c, user.ID)) {
		return
	}
	if view, err := h.viewOf(user); ok(c, err) {
		c.JSON(http.StatusOK, view)
	}
}

// logout ends this browser's session.
func (h *handler) logout(c *gin.Context) {
	if ok(c, h.Auth.SignOut(c)) {
		c.Status(http.StatusNoContent)
	}
}

// logoutAll ends the user's sessions on every device, including this one. On the shared
// demo account it ends only this one, so a visitor can't sign everyone else out.
func (h *handler) logoutAll(c *gin.Context) {
	uid := auth.UserID(c)
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return
	}
	if user.Email == demo.Email {
		if ok(c, h.Auth.SignOut(c)) {
			c.Status(http.StatusNoContent)
		}
		return
	}
	if !ok(c, h.Auth.RevokeSessions(uid, "")) {
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
	if user.Email == demo.Email {
		// Its password is public, so changing it would lock out every other visitor.
		c.JSON(http.StatusForbidden, gin.H{"error": "the demo account's password can't be changed"})
		return
	}
	if len(user.PasswordHash) > 0 && !auth.CheckPassword(user.PasswordHash, in.Current) {
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
	if view, err := h.viewOf(user); ok(c, err) {
		c.JSON(http.StatusOK, view)
	}
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
