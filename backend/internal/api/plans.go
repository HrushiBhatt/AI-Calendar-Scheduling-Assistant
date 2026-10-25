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
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/scheduler"
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
	var conflict *plans.ConflictError
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
	case errors.As(err, &conflict):
		c.JSON(http.StatusConflict, gin.H{"error": conflict.Msg, "code": conflict.Code, "block_id": conflict.BlockID})
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

type acceptInput struct {
	BlockIDs []uint `json:"block_ids"` // empty: all of them
}

// acceptPlan accepts all of a proposal or a subset. Users take two of three blocks often
// enough that the partial accept is the main path, and the rejected remainder is the best
// quality signal the scheduler gets.
func (h *handler) acceptPlan(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	var in acceptInput
	if c.Request.ContentLength != 0 && !bind(c, &in) {
		return
	}
	view, err := h.Plans.Accept(auth.UserID(c), id, in.BlockIDs)
	if h.planOK(c, err) {
		c.JSON(http.StatusOK, view)
	}
}

func (h *handler) rejectPlan(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	view, err := h.Plans.Reject(auth.UserID(c), id)
	if h.planOK(c, err) {
		c.JSON(http.StatusOK, view)
	}
}

type moveInput struct {
	StartsAt time.Time `json:"starts_at" binding:"required"`
	Mode     string    `json:"mode" binding:"max=32"`
}

// moveBlock re-validates a dragged or delayed block. On a violation it answers 409 with
// the reason, and the UI snaps the block back and shows it.
func (h *handler) moveBlock(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	var in moveInput
	if !bind(c, &in) {
		return
	}
	block, err := h.Plans.Move(auth.UserID(c), id, in.StartsAt, in.Mode)
	if h.planOK(c, err) {
		c.JSON(http.StatusOK, block)
	}
}

func (h *handler) dropBlock(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	if h.planOK(c, h.Plans.Drop(auth.UserID(c), id)) {
		c.Status(http.StatusNoContent)
	}
}

// startBlock is "Start now" on the countdown: the block starts immediately.
func (h *handler) startBlock(c *gin.Context) {
	id, valid := idParam(c)
	if !valid {
		return
	}
	state, err := h.Dispatcher.StartNow(auth.UserID(c), id)
	switch {
	case errors.Is(err, engine.ErrBusy), errors.Is(err, scheduler.ErrNotStartable):
		c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
	case h.planOK(c, err):
		c.JSON(http.StatusOK, state)
	}
}
