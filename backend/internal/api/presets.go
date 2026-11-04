package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// presetInput is a custom timing mode. Pointers, so 0 means "sent 0" rather than "missing".
type presetInput struct {
	Name  string `json:"name" binding:"required,max=32"`
	Focus *int   `json:"focus" binding:"required,min=1,max=180"`
	Rest  *int   `json:"rest" binding:"required,min=0,max=60"`
}

// listPresets returns the user's custom modes.
func (h *handler) listPresets(c *gin.Context) {
	presets := []store.Preset{}
	if ok(c, h.DB.Where("user_id = ?", auth.UserID(c)).Order("id").Find(&presets).Error) {
		c.JSON(http.StatusOK, presets)
	}
}

// createPreset saves a custom mode and tells the user's other tabs.
func (h *handler) createPreset(c *gin.Context) {
	var in presetInput
	if !bind(c, &in) {
		return
	}
	uid := auth.UserID(c)
	preset := store.Preset{UserID: uid, Name: strings.TrimSpace(in.Name), FocusMin: *in.Focus, RestMin: *in.Rest}
	if preset.Name == "" {
		badRequest(c, "name is required")
		return
	}
	if ok(c, h.DB.Create(&preset).Error) {
		h.changed(uid, "presets")
		c.JSON(http.StatusCreated, preset)
	}
}

// deletePreset removes one of the user's custom modes.
func (h *handler) deletePreset(c *gin.Context) {
	h.deleteOwned(c, &store.Preset{}, "presets")
}
