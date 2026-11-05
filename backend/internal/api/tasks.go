package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

type taskInput struct {
	Title    string `json:"title" binding:"required,max=120"`
	Estimate int    `json:"estimate" binding:"min=1,max=20"`
}

// taskPatch changes only the fields that were sent.
type taskPatch struct {
	Title    *string `json:"title" binding:"omitempty,max=120"`
	Estimate *int    `json:"estimate" binding:"omitempty,min=1,max=20"`
	Done     *bool   `json:"done"`
}

// taskView is a task plus the focus time logged against it.
type taskView struct {
	store.Task
	Brews   int `json:"brews"` // full focus blocks
	Minutes int `json:"minutes"`
}

// listTasks returns open tasks first, each with its totals from finished sessions.
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

// createTask adds a task; the estimate defaults to one focus block.
func (h *handler) createTask(c *gin.Context) {
	in := taskInput{Estimate: 1}
	if !bind(c, &in) {
		return
	}
	uid := auth.UserID(c)
	task := store.Task{UserID: uid, Title: strings.TrimSpace(in.Title), Estimate: in.Estimate}
	if task.Title == "" {
		badRequest(c, "title is required")
		return
	}
	if ok(c, h.DB.Create(&task).Error) {
		h.changed(uid, "tasks")
		c.JSON(http.StatusCreated, taskView{Task: task})
	}
}

// updateTask renames, re-estimates or ticks off one of the user's tasks.
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
	if ok(c, h.DB.Save(&task).Error) {
		h.changed(uid, "tasks")
		c.JSON(http.StatusOK, task)
	}
}

// deleteTask removes one of the user's tasks.
func (h *handler) deleteTask(c *gin.Context) {
	h.deleteOwned(c, &store.Task{}, "tasks")
}
