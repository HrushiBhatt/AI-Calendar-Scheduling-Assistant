package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

// Sessions are the journal: every finished focus block, with an optional reflection.

type reflectionInput struct {
	Reflection string `json:"reflection" binding:"max=280"`
}

// listSessions returns the newest finished sessions, up to ?limit= (at most 100).
func (h *handler) listSessions(c *gin.Context) {
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if err != nil {
		limit = 20
	}
	sessions := []store.Session{}
	query := h.DB.Scopes(store.Done(auth.UserID(c))).Order("id DESC").Limit(min(max(limit, 1), 100))
	if ok(c, query.Find(&sessions).Error) {
		c.JSON(http.StatusOK, sessions)
	}
}

// reflect saves the one-sentence note a user writes after a block.
func (h *handler) reflect(c *gin.Context) {
	uid := auth.UserID(c)
	id, valid := idParam(c)
	var session store.Session
	if !valid || !found(c, h.DB.Scopes(store.Done(uid)).First(&session, id).Error) {
		return
	}
	var in reflectionInput
	if !bind(c, &in) {
		return
	}
	session.Reflection = strings.TrimSpace(in.Reflection)
	if ok(c, h.DB.Model(&session).Update("reflection", session.Reflection).Error) {
		// Every open tab showed the reflection prompt; the others can close it now.
		h.Hub.Publish(uid, eventOf("session.reflected", gin.H{"id": session.ID}))
		c.JSON(http.StatusOK, session)
	}
}

// clearSessions deletes the user's whole history. Tasks and modes stay.
func (h *handler) clearSessions(c *gin.Context) {
	uid := auth.UserID(c)
	if ok(c, h.DB.Scopes(store.Done(uid)).Delete(&store.Session{}).Error) {
		h.changed(uid, "sessions")
		c.Status(http.StatusNoContent)
	}
}
