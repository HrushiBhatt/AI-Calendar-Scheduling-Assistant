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

// ---- presets (custom timing modes) ------------------------------------------------

type presetInput struct {
	Name  string `json:"name" binding:"required,max=32"`
	Focus *int   `json:"focus" binding:"required,min=1,max=180"` // pointers so 0 means "sent 0", not "missing"
	Rest  *int   `json:"rest" binding:"required,min=0,max=60"`
}

func (h *handler) listPresets(c *gin.Context) {
	presets := []store.Preset{}
	if ok(c, h.DB.Where("user_id = ?", auth.UserID(c)).Order("id").Find(&presets).Error) {
		c.JSON(http.StatusOK, presets)
	}
}

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

func (h *handler) deletePreset(c *gin.Context) {
	h.deleteOwned(c, &store.Preset{}, "presets")
}

// ---- tasks --------------------------------------------------------------------------

type taskInput struct {
	Title    string  `json:"title" binding:"required,max=120"`
	Estimate int     `json:"estimate" binding:"min=1,max=20"`
	DueAt    *string `json:"due_at"` // RFC 3339; "" or absent for none
	Priority int     `json:"priority" binding:"min=0,max=3"`
	Energy   string  `json:"energy" binding:"omitempty,oneof=deep light"`
}

type taskPatch struct {
	Title    *string `json:"title" binding:"omitempty,max=120"`
	Estimate *int    `json:"estimate" binding:"omitempty,min=1,max=20"`
	Done     *bool   `json:"done"`
	DueAt    *string `json:"due_at"` // RFC 3339, or "" to clear
	Priority *int    `json:"priority" binding:"omitempty,min=0,max=3"`
	Energy   *string `json:"energy" binding:"omitempty,oneof=deep light ''"`
}

// parseDue reads an optional RFC 3339 deadline. "" clears it.
func parseDue(raw *string) (*time.Time, error) {
	if raw == nil || *raw == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, *raw)
	if err != nil {
		return nil, errors.New("due_at must be an RFC 3339 time, e.g. 2026-10-30T17:00:00-05:00")
	}
	t = t.UTC()
	return &t, nil
}

// taskView is a task plus the focus time logged against it.
type taskView struct {
	store.Task
	Brews   int `json:"brews"` // full focus blocks
	Minutes int `json:"minutes"`
}

func (h *handler) listTasks(c *gin.Context) {
	uid := auth.UserID(c)
	var tasks []store.Task
	if !ok(c, h.DB.Where("user_id = ?", uid).Order("done, id").Find(&tasks).Error) {
		return
	}
	var totals []struct {
		TaskID  uint
		Brews   int
		Seconds int
	}
	err := h.DB.Model(&store.Session{}).Scopes(store.Done(uid)).Where("task_id IS NOT NULL").
		Select("task_id, SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS brews, SUM(focused) AS seconds").
		Group("task_id").Scan(&totals).Error
	if !ok(c, err) {
		return
	}
	byTask := make(map[uint]taskView, len(totals))
	for _, t := range totals {
		byTask[t.TaskID] = taskView{Brews: t.Brews, Minutes: t.Seconds / 60}
	}
	views := make([]taskView, len(tasks))
	for i, task := range tasks {
		views[i] = byTask[task.ID]
		views[i].Task = task
	}
	c.JSON(http.StatusOK, views)
}

func (h *handler) createTask(c *gin.Context) {
	in := taskInput{Estimate: 1}
	if !bind(c, &in) {
		return
	}
	uid := auth.UserID(c)
	due, err := parseDue(in.DueAt)
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	task := store.Task{UserID: uid, Title: strings.TrimSpace(in.Title), Estimate: in.Estimate,
		DueAt: due, Priority: in.Priority, Energy: in.Energy}
	if task.Title == "" {
		badRequest(c, "title is required")
		return
	}
	if ok(c, h.DB.Create(&task).Error) {
		h.changed(uid, "tasks")
		c.JSON(http.StatusCreated, taskView{Task: task})
	}
}

func (h *handler) updateTask(c *gin.Context) {
	uid := auth.UserID(c)
	id, valid := idParam(c)
	var task store.Task
	if !valid || !found(c, h.DB.Where("id = ? AND user_id = ?", id, uid).First(&task).Error) {
		return
	}
	var in taskPatch
	if !bind(c, &in) {
		return
	}
	if in.Title != nil {
		if task.Title = strings.TrimSpace(*in.Title); task.Title == "" {
			badRequest(c, "title is required")
			return
		}
	}
	if in.Estimate != nil {
		task.Estimate = *in.Estimate
	}
	if in.Done != nil {
		task.Done = *in.Done
	}
	if in.DueAt != nil {
		due, err := parseDue(in.DueAt)
		if err != nil {
			badRequest(c, err.Error())
			return
		}
		task.DueAt = due
	}
	if in.Priority != nil {
		task.Priority = *in.Priority
	}
	if in.Energy != nil {
		task.Energy = *in.Energy
	}
	if ok(c, h.DB.Save(&task).Error) {
		h.changed(uid, "tasks")
		c.JSON(http.StatusOK, task)
	}
}

func (h *handler) deleteTask(c *gin.Context) {
	h.deleteOwned(c, &store.Task{}, "tasks")
}

// deleteOwned deletes the :id record of model if it belongs to the signed-in user.
func (h *handler) deleteOwned(c *gin.Context, model any, kind string) {
	uid := auth.UserID(c)
	id, valid := idParam(c)
	if !valid {
		return
	}
	res := h.DB.Where("id = ? AND user_id = ?", id, uid).Delete(model)
	if !ok(c, res.Error) {
		return
	}
	if res.RowsAffected == 0 {
		notFound(c)
		return
	}
	h.changed(uid, kind)
	c.Status(http.StatusNoContent)
}

// ---- sessions (the journal) ------------------------------------------------------

type reflectionInput struct {
	Reflection string `json:"reflection" binding:"max=280"`
}

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

func (h *handler) clearSessions(c *gin.Context) {
	uid := auth.UserID(c)
	if ok(c, h.DB.Scopes(store.Done(uid)).Delete(&store.Session{}).Error) {
		h.changed(uid, "sessions")
		c.Status(http.StatusNoContent)
	}
}
