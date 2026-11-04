package api

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type rate struct {
	Count int      `json:"count"`
	Of    int      `json:"of"`
	Rate  *float64 `json:"rate"` // null when there is nothing to divide by yet
}

func ratio(count, of int) rate {
	r := rate{Count: count, Of: of}
	if of > 0 {
		v := float64(count) / float64(of)
		r.Rate = &v
	}
	return r
}

// insights computes the planning numbers from rows the schema already stores. The
// planned-vs-ad-hoc completion split, on Session.ScheduledID, is the one that answers
// whether scheduling actually helps.
func (h *handler) insights(c *gin.Context) {
	uid := auth.UserID(c)
	db := h.DB

	var blocks []store.ScheduledSession
	if !ok(c, db.Where("user_id = ?", uid).Find(&blocks).Error) {
		return
	}
	decided, accepted, conflicted := 0, 0, 0
	for _, b := range blocks {
		switch b.Status {
		case store.BlockProposed:
			continue // still open: not yet a decision either way
		case store.BlockRejected:
		default:
			accepted++ // accepted, then started, finished, skipped, moved or conflicted
		}
		decided++
		if b.ConflictedAt != nil {
			conflicted++
		}
	}

	var acceptedPlans []store.Plan
	if !ok(c, db.Where("user_id = ? AND status = ?", uid, store.PlanAccepted).Find(&acceptedPlans).Error) {
		return
	}
	partial := 0
	for _, p := range acceptedPlans {
		var left int64
		if !ok(c, db.Model(&store.ScheduledSession{}).Where("plan_id = ? AND status = ? AND note = ?", p.ID, store.BlockRejected, "not picked").Count(&left).Error) {
			return
		}
		if left > 0 {
			partial++
		}
	}

	type split struct {
		Planned rate `json:"planned"`
		AdHoc   rate `json:"ad_hoc"`
	}
	count := func(planned, completedOnly bool) (int, bool) {
		q := db.Model(&store.Session{}).Scopes(store.Done(uid))
		if planned {
			q = q.Where("scheduled_id IS NOT NULL")
		} else {
			q = q.Where("scheduled_id IS NULL")
		}
		if completedOnly {
			q = q.Where("completed = ?", true)
		}
		var n int64
		if !ok(c, q.Count(&n).Error) {
			return 0, false
		}
		return int(n), true
	}
	plannedAll, ok1 := count(true, false)
	plannedDone, ok2 := count(true, true)
	adHocAll, ok3 := count(false, false)
	adHocDone, ok4 := count(false, true)
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return
	}

	// Estimate accuracy: for finished tasks, full brews actually needed against the estimate.
	var estimates []struct {
		Estimate int
		Brews    int
	}
	if !ok(c, db.Model(&store.Task{}).
		Select("tasks.estimate AS estimate, (SELECT COUNT(*) FROM sessions s WHERE s.task_id = tasks.id AND s.state = ? AND s.completed) AS brews", store.StateDone).
		Where("tasks.user_id = ? AND tasks.done = ?", uid, true).Scan(&estimates).Error) {
		return
	}
	within := 0
	var ratioSum float64
	for _, e := range estimates {
		if d := e.Brews - e.Estimate; d >= -1 && d <= 1 {
			within++
		}
		ratioSum += float64(e.Brews) / float64(max(1, e.Estimate))
	}
	var meanRatio *float64
	if len(estimates) > 0 {
		v := ratioSum / float64(len(estimates))
		meanRatio = &v
	}

	var turns []store.AssistantTurn
	if !ok(c, db.Where("user_id = ?", uid).Find(&turns).Error) {
		return
	}
	calls, invalid, degraded := 0, 0, 0
	failures := map[string]int{}
	for _, t := range turns {
		for _, call := range t.ToolCalls {
			if call.Name == "plan_focus_blocks" {
				calls++
				if call.Error != "" {
					invalid++
				}
			}
		}
		if t.Degraded {
			degraded++
		}
		if t.Failure != "" {
			kind := t.Failure
			for i, ch := range kind {
				if ch == ':' {
					kind = kind[:i]
					break
				}
			}
			failures[kind]++
		}
	}

	p50, p99, samples := h.Plans.Latency.Percentiles()
	c.JSON(http.StatusOK, gin.H{
		"acceptance":         ratio(accepted, decided),
		"partial_accept":     ratio(partial, len(acceptedPlans)),
		"completion":         split{Planned: ratio(plannedDone, plannedAll), AdHoc: ratio(adHocDone, adHocAll)},
		"estimate_accuracy":  gin.H{"within_one": ratio(within, len(estimates)), "mean_actual_over_estimate": meanRatio},
		"tool_call_validity": ratio(calls-invalid, calls),
		"assistant":          gin.H{"turns": len(turns), "degraded": degraded, "failures": failures},
		"conflicts":          ratio(conflicted, accepted),
		"scheduler_latency":  gin.H{"p50_us": p50.Microseconds(), "p99_us": p99.Microseconds(), "samples": samples},
	})
}
