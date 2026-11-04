package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/assistant"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// assist answers a plain-language request through the assistant. Without one (no
// Anthropic key) it degrades: a plan from the form's defaults, flagged so the frontend
// can say so.
func (h *handler) assist(c *gin.Context, ctx context.Context, uid uint, text string) {
	if h.Assistant == nil {
		h.degraded(c, ctx, uid, text, "The planning assistant isn't set up on this server, so this plan uses the form's defaults.")
		return
	}
	res, err := h.Assistant.Handle(ctx, uid, text)
	switch {
	case errors.Is(err, assistant.ErrBudget):
		c.JSON(http.StatusTooManyRequests, gin.H{"error": err.Error()})
	case errors.Is(err, assistant.ErrDisabled):
		h.degraded(c, ctx, uid, text, "The planning assistant is off in your settings, so this plan uses the form's defaults.")
	case h.planOK(c, err):
		c.JSON(http.StatusOK, planResponse{Plan: res.Plan, Narration: res.Narration, Degraded: res.Degraded, Notice: res.Notice,
			Usage: &tokenUsage{InputTokens: res.Usage.InputTokens, OutputTokens: res.Usage.OutputTokens}})
	}
}

// degraded proposes the default form plan and says why.
func (h *handler) degraded(c *gin.Context, ctx context.Context, uid uint, text, notice string) {
	var user store.User
	if !found(c, h.DB.First(&user, uid).Error) {
		return
	}
	loc, err := user.Settings.Location()
	if !h.planOK(c, err) {
		return
	}
	args := plans.DefaultArgs(user.Settings, h.Plans.Now(), loc)
	view, err := h.Plans.Propose(ctx, uid, plans.Proposal{Args: args, Source: store.SourceForm, Text: text})
	if h.planOK(c, err) {
		c.JSON(http.StatusOK, planResponse{Plan: view, Degraded: true, Notice: notice})
	}
}
