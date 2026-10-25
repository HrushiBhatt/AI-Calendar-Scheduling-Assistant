package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
)

const providerTimeout = 30 * time.Second

// calendarConnect starts the OAuth flow: it sets the signed state cookie and returns the
// consent URL for the frontend to navigate to.
func (h *handler) calendarConnect(c *gin.Context) {
	uid := auth.UserID(c)
	if _, ok := h.Calendar.CanConnect(); !ok {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": calendar.ErrNotConfigured.Error()})
		return
	}
	state, err := h.Auth.IssueState(c, uid)
	if !ok(c, err) {
		return
	}
	authURL, err := h.Calendar.AuthURL(state)
	if ok(c, err) {
		c.JSON(http.StatusOK, gin.H{"auth_url": authURL})
	}
}

// calendarCallback is where the provider sends the browser back. It always ends in a
// redirect to the settings page, carrying the outcome in the query string.
func (h *handler) calendarCallback(c *gin.Context) {
	uid := auth.UserID(c)
	back := func(outcome string) {
		c.Redirect(http.StatusFound, "/settings?calendar="+url.QueryEscape(outcome))
	}
	if c.Query("error") != "" {
		back("denied") // the user said no on the consent screen
		return
	}
	if !h.Auth.CheckState(c, uid, c.Query("state")) {
		back("expired")
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), providerTimeout)
	defer cancel()
	if _, err := h.Calendar.Connect(ctx, uid, c.Query("code")); err != nil {
		log.Printf("calendar: connecting user %d: %v", uid, err) // provider errors are scrubbed of tokens
		back("error")
		return
	}
	back("connected")
}

func (h *handler) calendarAccounts(c *gin.Context) {
	accounts, err := h.Calendar.Accounts(auth.UserID(c))
	provider, configured := h.Calendar.CanConnect()
	if ok(c, err) {
		c.JSON(http.StatusOK, gin.H{"configured": configured, "provider": provider, "accounts": accounts})
	}
}

func (h *handler) calendarDisconnect(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), providerTimeout)
	defer cancel()
	err := h.Calendar.Disconnect(ctx, auth.UserID(c), id)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		notFound(c)
		return
	}
	if ok(c, err) {
		c.Status(http.StatusNoContent)
	}
}

// calendarSync forces a sync of every connected account (rate limited to one a minute).
func (h *handler) calendarSync(c *gin.Context) {
	uid := auth.UserID(c)
	ctx, cancel := context.WithTimeout(c.Request.Context(), providerTimeout)
	defer cancel()
	syncErr := h.Calendar.SyncUser(ctx, uid)
	accounts, err := h.Calendar.Accounts(uid)
	if !ok(c, err) {
		return
	}
	if syncErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "the calendar provider didn't answer cleanly; see the account's sync error", "accounts": accounts})
		return
	}
	c.JSON(http.StatusOK, gin.H{"accounts": accounts})
}

// calendarPush receives Google's change notifications. It is unauthenticated, so it trusts
// nothing in the request beyond a channel ID and token it can check, never syncs inline,
// and answers 200 at once either way: Google retries anything else.
func (h *handler) calendarPush(c *gin.Context) {
	h.Calendar.Notify(c.GetHeader("X-Goog-Channel-ID"), c.GetHeader("X-Goog-Channel-Token"), c.GetHeader("X-Goog-Resource-State"))
	c.Status(http.StatusOK)
}
