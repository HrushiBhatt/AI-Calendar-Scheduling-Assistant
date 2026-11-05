package api

// The timer over HTTP. The engine owns all timer state; these handlers only pass commands to
// it, and the event stream carries what happens back to every open tab.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/engine"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/events"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

type focusInput struct {
	Mode      string `json:"mode" binding:"required,max=32"`
	Planned   int    `json:"planned" binding:"min=60,max=10800"` // seconds
	Intention string `json:"intention" binding:"max=140"`
	TaskID    *uint  `json:"task_id"`
	Day       string `json:"day" binding:"required,datetime=2006-01-02"`
}

type breakInput struct {
	Length int `json:"length" binding:"min=60,max=3600"` // seconds
}

// keepalive stops proxies from closing an idle event stream.
const keepalive = 25 * time.Second

// timer returns the user's current timer, or an idle one.
func (h *handler) timer(c *gin.Context) {
	c.JSON(http.StatusOK, h.Engine.Current(c.Request.Context(), auth.UserID(c)))
}

// controlTimer handles POST /api/timer/:action: focus and break start a timer,
// everything else is a command for the one that's running.
func (h *handler) controlTimer(c *gin.Context) {
	uid := auth.UserID(c)
	var (
		state engine.State
		err   error
	)
	switch action := engine.Action(c.Param("action")); action {
	case "focus":
		var in focusInput
		if !bind(c, &in) {
			return
		}
		req := engine.FocusRequest{
			Mode: strings.TrimSpace(in.Mode), Planned: time.Duration(in.Planned) * time.Second,
			Intention: strings.TrimSpace(in.Intention), TaskID: in.TaskID, Day: in.Day,
		}
		if in.TaskID != nil {
			var task store.Task
			if !found(c, h.DB.Where("id = ? AND user_id = ?", *in.TaskID, uid).First(&task).Error) {
				return
			}
			if req.Intention == "" {
				req.Intention = task.Title
			}
		}
		state, err = h.Engine.StartFocus(uid, req)
	case "break":
		var in breakInput
		if !bind(c, &in) {
			return
		}
		state, err = h.Engine.StartBreak(uid, time.Duration(in.Length)*time.Second)
	case engine.Pause, engine.Resume, engine.Finish, engine.Cancel, engine.Distraction:
		state, err = h.Engine.Control(c.Request.Context(), uid, action)
	default:
		notFound(c)
		return
	}

	switch {
	case errors.Is(err, engine.ErrBusy), errors.Is(err, engine.ErrNoTimer), errors.Is(err, engine.ErrBadAction):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "timer": state})
	case ok(c, err):
		c.JSON(http.StatusOK, state)
	}
}

// events streams the user's live updates as Server-Sent Events. It opens with a
// snapshot of the timer, so a (re)connecting client is immediately in sync.
func (h *handler) events(c *gin.Context) {
	uid, session := auth.UserID(c), auth.SessionID(c)
	stream, unsubscribe := h.Hub.Subscribe(uid) // subscribe before the snapshot so nothing is missed
	defer unsubscribe()

	c.Header("Cache-Control", "no-cache")
	c.Header("X-Accel-Buffering", "no") // don't let a reverse proxy buffer the stream
	c.SSEvent("timer", h.Engine.Current(c.Request.Context(), uid))
	c.Writer.Flush()

	ping := time.NewTicker(h.Keepalive)
	defer ping.Stop()
	c.Stream(func(w io.Writer) bool {
		select {
		case <-c.Request.Context().Done():
			return false
		case e, open := <-stream:
			if !open { // dropped as too slow, or the server is shutting down
				return false
			}
			c.SSEvent(e.Type, eventData(e.Data))
			return true
		case <-ping.C:
			if !h.Auth.SessionActive(session) {
				return false // signed out since this stream opened
			}
			_, err := io.WriteString(w, ": keepalive\n\n")
			return err == nil
		}
	})
}

// eventOf builds an event for the hub.
func eventOf(kind string, data any) events.Event {
	return events.Event{Type: kind, Data: data}
}

// eventData makes an event with no data valid JSON. Left as nil, the stream would carry the
// text "<nil>", which the page can't parse, and it would drop the event.
func eventData(data any) any {
	if data == nil {
		return json.RawMessage("null")
	}
	return data
}
