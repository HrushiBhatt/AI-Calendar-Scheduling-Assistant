package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type registration struct {
	Email    string `json:"email" binding:"required,email,max=254"`
	Password string `json:"password" binding:"required,min=8,max=72"` // bcrypt reads at most 72 bytes
	Name     string `json:"name" binding:"max=60"`
	TimeZone string `json:"time_zone" binding:"max=64"` // the browser's IANA zone; optional
}

type credentials struct {
	Email    string `json:"email" binding:"required"`
	Password string `json:"password" binding:"required"`
}

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
	hash, err := auth.HashPassword(in.Password)
	if !ok(c, err) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	settings := store.DefaultSettings
	if in.TimeZone != "" {
		if _, err := store.LoadZone(in.TimeZone); err != nil {
			badRequest(c, err.Error())
			return
		}
		settings.TimeZone = in.TimeZone
	}
	user := store.User{Email: email, Name: name, PasswordHash: hash, Settings: settings}
	if !ok(c, h.DB.Create(&user).Error) || !ok(c, h.Auth.SignIn(c, user.ID)) {
		return
	}
	c.JSON(http.StatusCreated, user)
}

func (h *handler) login(c *gin.Context) {
	var in credentials
	if !bind(c, &in) {
		return
	}
	// Per account as well as per address, so spreading guesses over many IPs doesn't help.
	if allowed, wait := h.loginAccount.allow("login:" + strings.ToLower(strings.TrimSpace(in.Email))); !allowed {
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
	if ok(c, h.Auth.SignIn(c, user.ID)) {
		c.JSON(http.StatusOK, user)
	}
}

func (h *handler) logout(c *gin.Context) {
	h.Auth.SignOut(c)
	c.Status(http.StatusNoContent)
}

func (h *handler) me(c *gin.Context) {
	var user store.User
	if err := h.DB.First(&user, auth.UserID(c)).Error; err != nil {
		h.Auth.SignOut(c) // valid token for an account that no longer exists
		c.JSON(http.StatusUnauthorized, gin.H{"error": "please log in"})
		return
	}
	c.JSON(http.StatusOK, user)
}

func (h *handler) saveSettings(c *gin.Context) {
	var settings store.Settings
	if !bind(c, &settings) {
		return
	}
	if err := validateSettings(settings); err != nil {
		badRequest(c, err.Error())
		return
	}
	uid := auth.UserID(c)
	var before store.User
	if !found(c, h.DB.First(&before, uid).Error) {
		return
	}
	if !ok(c, h.DB.Model(&store.User{ID: uid}).Select("settings").Updates(store.User{Settings: settings}).Error) {
		return
	}
	if settings.WriteBack && !before.Settings.WriteBack && h.Plans != nil {
		if err := h.Plans.Backfill(uid); err != nil {
			_ = c.Error(err) // the settings are saved; the backfill is best effort
		}
	}
	h.changed(uid, "settings")
	c.JSON(http.StatusOK, settings)
}

// validateSettings checks what struct tags can't: a real IANA zone and a workday that ends after it starts.
func validateSettings(s store.Settings) error {
	if _, err := s.Location(); err != nil {
		return err
	}
	start, _ := time.Parse("15:04", s.WorkdayStart) // formats were validated by the binding tags
	end, _ := time.Parse("15:04", s.WorkdayEnd)
	if end.Sub(start) < time.Hour {
		return errors.New("the workday must end at least an hour after it starts")
	}
	return nil
}
