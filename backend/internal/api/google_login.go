package api

// Sign-in with Google. Accounts are matched on Google's permanent subject ID, never on email,
// because an email address can change hands.

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/demo"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// providerTimeout bounds a call to Google, so a slow provider can't hold a request open.
const providerTimeout = 30 * time.Second

// authProviders tells the login page which sign-in buttons to show.
func (h *handler) authProviders(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"google": h.Login != nil})
}

// googleStart sends a signed-out browser to Google to sign in.
func (h *handler) googleStart(c *gin.Context) {
	h.startLogin(c, 0)
}

// googleLink starts the same flow for a signed-in user, to add Google to their account.
func (h *handler) googleLink(c *gin.Context) {
	uid := auth.UserID(c)
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return
	}
	if user.Email == demo.Email {
		c.JSON(http.StatusForbidden, gin.H{"error": "the demo account can't be linked to Google"})
		return
	}
	h.startLogin(c, uid)
}

// startLogin redirects to Google. linkTo is 0 for a sign-in, or the user adding Google to their account.
func (h *handler) startLogin(c *gin.Context, linkTo uint) {
	if h.Login == nil {
		notFound(c)
		return
	}
	state, err := h.Auth.IssueLoginState(c, linkTo)
	if !ok(c, err) {
		return
	}
	c.Redirect(http.StatusFound, h.Login.AuthURL(state, h.Auth.Derive("nonce", state), h.Auth.Derive("pkce", state)))
}

// googleCallback is where Google sends the browser back. It always ends in a redirect:
// into the app, or to a page that explains what happened.
func (h *handler) googleCallback(c *gin.Context) {
	if h.Login == nil {
		notFound(c)
		return
	}
	state := c.Query("state")
	linkTo, valid := h.Auth.CheckLoginState(c, state)
	back := func(outcome string) {
		if linkTo != 0 {
			c.Redirect(http.StatusFound, "/settings?google="+url.QueryEscape(outcome))
			return
		}
		c.Redirect(http.StatusFound, "/login?error="+url.QueryEscape(outcome))
	}
	if !valid {
		back("expired")
		return
	}
	if c.Query("error") != "" {
		back("denied") // the user said no on Google's screen
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), providerTimeout)
	defer cancel()
	identity, err := h.Login.Exchange(ctx, c.Query("code"), h.Auth.Derive("nonce", state), h.Auth.Derive("pkce", state))
	switch {
	case errors.Is(err, auth.ErrEmailUnverified):
		back("unverified")
		return
	case err != nil:
		log.Printf("auth: %v", err) // never carries a token or the code
		back("failed")
		return
	}
	if linkTo != 0 {
		back(h.linkIdentity(c, linkTo, identity))
		return
	}
	userID, outcome := h.signInIdentity(identity)
	if outcome != "" {
		back(outcome)
		return
	}
	if err := h.Auth.SignIn(c, userID); err != nil {
		log.Printf("auth: starting a session: %v", err)
		back("failed")
		return
	}
	c.Redirect(http.StatusFound, "/")
}

// signInIdentity finds or creates the account for a verified identity. A matching email
// on an existing account is deliberately not enough to sign in to it. Nothing checks the
// email behind a password account here, so anyone could have registered it first, waiting
// for the real owner to arrive through Google and share the account with them. The owner
// signs in with the password and adds Google in Settings instead, which proves both.
func (h *handler) signInIdentity(identity auth.Identity) (userID uint, outcome string) {
	var linked store.Identity
	err := h.DB.Where("provider = ? AND subject = ?", identity.Provider, identity.Subject).Limit(1).Find(&linked).Error
	if err != nil {
		log.Printf("auth: finding an identity: %v", err)
		return 0, "failed"
	}
	if linked.ID != 0 {
		return linked.UserID, ""
	}
	email := strings.ToLower(strings.TrimSpace(identity.Email))
	var taken int64
	if err := h.DB.Model(&store.User{}).Where("email = ?", email).Count(&taken).Error; err != nil {
		log.Printf("auth: checking an email: %v", err)
		return 0, "failed"
	}
	if taken > 0 {
		return 0, "account_exists"
	}
	user := store.User{Email: email, Name: displayName(identity.Name, email), PasswordHash: []byte{}, Settings: store.DefaultSettings}
	err = h.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		return tx.Create(&store.Identity{UserID: user.ID, Provider: identity.Provider, Subject: identity.Subject, Email: email}).Error
	})
	if err != nil {
		log.Printf("auth: creating an account: %v", err)
		return 0, "failed"
	}
	return user.ID, ""
}

// linkIdentity adds a verified identity to the account of whoever started the flow,
// provided that person is still the one signed in on this browser.
func (h *handler) linkIdentity(c *gin.Context, linkTo uint, identity auth.Identity) (outcome string) {
	if current, ok := h.Auth.Current(c); !ok || current != linkTo {
		return "expired"
	}
	var linked store.Identity
	err := h.DB.Where("provider = ? AND subject = ?", identity.Provider, identity.Subject).Limit(1).Find(&linked).Error
	if err != nil {
		log.Printf("auth: finding an identity: %v", err)
		return "failed"
	}
	switch {
	case linked.ID == 0:
	case linked.UserID == linkTo:
		return "linked"
	default:
		return "in_use"
	}
	var existing store.Identity
	if err := h.DB.Where("user_id = ? AND provider = ?", linkTo, identity.Provider).Limit(1).Find(&existing).Error; err != nil {
		log.Printf("auth: finding an identity: %v", err)
		return "failed"
	}
	if existing.ID != 0 {
		return "already_linked" // one Google account per user: unlink the other first
	}
	email := strings.ToLower(strings.TrimSpace(identity.Email))
	err = h.DB.Create(&store.Identity{UserID: linkTo, Provider: identity.Provider, Subject: identity.Subject, Email: email}).Error
	if err != nil {
		log.Printf("auth: linking an identity: %v", err)
		return "failed"
	}
	h.changed(linkTo, "account")
	return "linked"
}

// googleUnlink removes Google sign-in, unless that would leave no way to sign in at all.
func (h *handler) googleUnlink(c *gin.Context) {
	uid := auth.UserID(c)
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return
	}
	if len(user.PasswordHash) == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "set a password first, or you won't be able to sign in"})
		return
	}
	if !ok(c, h.DB.Where("user_id = ? AND provider = ?", uid, "google").Delete(&store.Identity{}).Error) {
		return
	}
	h.changed(uid, "account")
	c.Status(http.StatusNoContent)
}

// displayName tidies a provider's name for the 60-rune column, or falls back to the email.
func displayName(name, email string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if utf8.RuneCountInString(name) > 60 {
		name = string([]rune(name)[:60])
	}
	return name
}
