package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// planRequest is POST /api/assistant/plan: plain words for the assistant, the form's
// structured ask, or a quick action. All three end in the same planner.
type planRequest struct {
	Text  string      `json:"text" binding:"max=4000"`
	Ask   *plans.Args `json:"ask"`
	Quick string      `json:"quick" binding:"omitempty,oneof=fill_today"`
}

// planResponse carries the plan as the scheduler built it. The model's narration is a
// separate, labelled field: nothing the frontend draws comes from model output.
type planResponse struct {
	Plan      *plans.View `json:"plan"`
	Narration string      `json:"narration"`
	Degraded  bool        `json:"degraded"`
	Notice    string      `json:"notice,omitempty"` // why the request took the fallback path
	Usage     *tokenUsage `json:"usage,omitempty"`
}

type tokenUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

const planTimeout = 45 * time.Second

func (h *handler) requestPlan(c *gin.Context) {
	uid := auth.UserID(c)
	var in planRequest
	if !bind(c, &in) {
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), planTimeout)
	defer cancel()
	switch {
	case in.Ask != nil:
		view, err := h.Plans.Propose(ctx, uid, plans.Proposal{Args: *in.Ask, Source: store.SourceForm})
		if h.planOK(c, err) {
			c.JSON(http.StatusOK, planResponse{Plan: view})
		}
	case in.Quick == "fill_today":
		view, err := h.Plans.Propose(ctx, uid, plans.Proposal{Args: plans.Args{Window: "today", Fill: true}, Source: store.SourceQuick})
		if h.planOK(c, err) {
			c.JSON(http.StatusOK, planResponse{Plan: view})
		}
	case strings.TrimSpace(in.Text) != "":
		h.assist(c, ctx, uid, strings.TrimSpace(in.Text))
	default:
		badRequest(c, "send text, ask or quick")
	}
}

// planOK reports whether err is nil, replying with the right status otherwise: a request
// the user (or model) can fix is a 400 that names the field.
func (h *handler) planOK(c *gin.Context, err error) bool {
	var argErr *plans.ArgError
	switch {
	case err == nil:
		return true
	case errors.As(err, &argErr):
		c.JSON(http.StatusBadRequest, gin.H{"error": argErr.Field + " " + argErr.Msg, "field": argErr.Field})
	case errors.Is(err, store.ErrNoTimeZone):
		badRequest(c, err.Error())
	case errors.Is(err, gorm.ErrRecordNotFound):
		notFound(c)
	case errors.Is(err, plans.ErrNotProposed):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	default:
		ok(c, err)
	}
	return false
}

func (h *handler) livePlans(c *gin.Context) {
	views, err := h.Plans.Live(auth.UserID(c))
	if ok(c, err) {
		if views == nil {
			views = []*plans.View{}
		}
		c.JSON(http.StatusOK, views)
	}
}

func (h *handler) getPlan(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	view, err := h.Plans.Get(auth.UserID(c), id)
	if h.planOK(c, err) {
		c.JSON(http.StatusOK, view)
	}
}
