package api

// Progress numbers: today, streaks, totals and the year heatmap.

import (
	"maps"
	"net/http"
	"slices"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
)

const (
	dayLayout   = "2006-01-02"
	heatmapDays = 371 // 53 weeks, enough to fill a GitHub-style grid
)

type dayTotals struct {
	Day       string
	Sessions  int
	Seconds   int
	Completed int
}

// stats aggregates the user's sessions per day into today's totals, streaks, all-time
// totals and a heatmap. The client passes ?today= so "today" means the user's local day.
func (h *handler) stats(c *gin.Context) {
	today := c.DefaultQuery("today", time.Now().Format(dayLayout))
	if _, err := time.Parse(dayLayout, today); err != nil {
		badRequest(c, "today must be a YYYY-MM-DD date")
		return
	}

	var rows []dayTotals
	err := h.DB.Model(&store.Session{}).Scopes(store.Done(auth.UserID(c))).
		Select("day, COUNT(*) AS sessions, SUM(focused) AS seconds, SUM(CASE WHEN completed THEN 1 ELSE 0 END) AS completed").
		Group("day").
		Scan(&rows).Error
	if !ok(c, err) {
		return
	}

	minutes := make(map[string]int, len(rows))
	var totalMinutes, totalSessions, totalCompleted, todaySessions int
	for _, r := range rows {
		minutes[r.Day] = r.Seconds / 60
		totalMinutes += r.Seconds / 60
		totalSessions += r.Sessions
		totalCompleted += r.Completed
		if r.Day == today {
			todaySessions = r.Sessions
		}
	}

	cutoff := shift(today, -heatmapDays)
	heatmap := make(map[string]int)
	for day, m := range minutes {
		if day > cutoff {
			heatmap[day] = m
		}
	}

	current, best := streaks(minutes, today)
	c.JSON(http.StatusOK, gin.H{
		"today":       gin.H{"minutes": minutes[today], "sessions": todaySessions},
		"streak":      current,
		"best_streak": best,
		"total":       gin.H{"minutes": totalMinutes, "sessions": totalSessions, "completed": totalCompleted},
		"heatmap":     heatmap,
	})
}

// streaks returns the current and best runs of consecutive active days. The current
// streak survives until the end of today, so it counts back from yesterday when
// nothing has been logged yet today.
func streaks(active map[string]int, today string) (current, best int) {
	days := slices.Sorted(maps.Keys(active))
	run := 0
	for i, day := range days {
		if i > 0 && shift(days[i-1], 1) == day {
			run++
		} else {
			run = 1
		}
		best = max(best, run)
	}

	cursor := today
	if _, ok := active[cursor]; !ok {
		cursor = shift(today, -1)
	}
	for {
		if _, ok := active[cursor]; !ok {
			return current, best
		}
		current++
		cursor = shift(cursor, -1)
	}
}

// shift moves a YYYY-MM-DD day by n days. Days are validated on the way in, so parsing can't fail.
func shift(day string, n int) string {
	t, _ := time.Parse(dayLayout, day)
	return t.AddDate(0, 0, n).Format(dayLayout)
}
