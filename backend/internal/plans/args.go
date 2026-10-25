// Package plans is the life of a plan around the pure scheduler: it builds planner.Input
// from the database, validates requests, stores proposals, and handles accepting,
// rejecting, moving and reconciling blocks. Three paths reach it with the same Args: the
// assistant's plan_focus_blocks tool call, the planning form, and the quick action.
package plans

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// Args is the structured form of a planning request. It is exactly the input schema of
// the assistant's plan_focus_blocks tool, so the form and the model ask the same way.
type Args struct {
	Window        string   `json:"window"` // today, tomorrow, this_week, next_week, custom
	StartDate     string   `json:"start_date,omitempty"`
	EndDate       string   `json:"end_date,omitempty"`
	TaskIDs       []uint   `json:"task_ids,omitempty"`
	NewTasks      []string `json:"new_tasks,omitempty"`
	TotalBlocks   int      `json:"total_blocks,omitempty"`
	BlocksPerTask int      `json:"blocks_per_task,omitempty"`
	ModeHint      string   `json:"mode_hint,omitempty"`
	AllowEvening  bool     `json:"allow_evening,omitempty"`
	AllowWeekend  bool     `json:"allow_weekend,omitempty"`
	AvoidBefore   string   `json:"avoid_before,omitempty"`
	AvoidAfter    string   `json:"avoid_after,omitempty"`
	// Fill places untasked blocks in all remaining free time. The quick action sets it;
	// it is not part of the model's tool.
	Fill bool `json:"fill,omitempty"`
}

// Windows a request may name.
var Windows = []string{"today", "tomorrow", "this_week", "next_week", "custom"}

const (
	MaxTotalBlocks = 12
	MaxNewTasks    = 5
	maxWindowDays  = 14
	maxDaysAhead   = 60
)

// ArgError is a request a model (or a form) can fix and retry: it names the field.
type ArgError struct {
	Field, Msg string
}

func (e *ArgError) Error() string { return e.Field + ": " + e.Msg }

func argErr(field, format string, a ...any) error {
	return &ArgError{Field: field, Msg: fmt.Sprintf(format, a...)}
}

// Validate checks everything a model could get wrong, against the user's own data: an
// unknown window, a custom window without dates, a task ID that belongs to someone else,
// total_blocks of 400. Every rejection says how to fix it, so the model can retry.
func (a *Args) Validate(db *gorm.DB, userID uint, modes []planner.Mode, now time.Time, loc *time.Location) error {
	a.ModeHint = strings.TrimSpace(a.ModeHint)
	if !slices.Contains(Windows, a.Window) {
		return argErr("window", "must be one of %s", strings.Join(Windows, ", "))
	}
	if a.Window == "custom" && a.StartDate == "" {
		return argErr("start_date", "is required when window is custom (YYYY-MM-DD)")
	}
	if _, err := a.Resolve(now, loc); err != nil {
		return err
	}
	if a.TotalBlocks < 0 || a.TotalBlocks > MaxTotalBlocks {
		return argErr("total_blocks", "must be between 1 and %d", MaxTotalBlocks)
	}
	if a.BlocksPerTask < 0 || a.BlocksPerTask > MaxTotalBlocks {
		return argErr("blocks_per_task", "must be between 1 and %d", MaxTotalBlocks)
	}
	for _, f := range []struct{ name, val string }{{"avoid_before", a.AvoidBefore}, {"avoid_after", a.AvoidAfter}} {
		if f.val != "" {
			if _, err := time.Parse("15:04", f.val); err != nil {
				return argErr(f.name, "must be an HH:MM time in the user's zone, e.g. 13:30")
			}
		}
	}
	if a.AvoidBefore != "" && a.AvoidAfter != "" && a.AvoidAfter <= a.AvoidBefore {
		return argErr("avoid_after", "must be later than avoid_before")
	}
	if a.ModeHint != "" && !strings.EqualFold(a.ModeHint, "deep") && !strings.EqualFold(a.ModeHint, "short") &&
		!slices.ContainsFunc(modes, func(m planner.Mode) bool { return strings.EqualFold(m.Name, a.ModeHint) }) {
		names := []string{"deep", "short"}
		for _, m := range modes {
			names = append(names, m.Name)
		}
		return argErr("mode_hint", "must be one of: %s", strings.Join(names, ", "))
	}
	if len(a.NewTasks) > MaxNewTasks {
		return argErr("new_tasks", "at most %d new tasks per request", MaxNewTasks)
	}
	for i, title := range a.NewTasks {
		title = strings.TrimSpace(title)
		if title == "" || len([]rune(title)) > 120 {
			return argErr("new_tasks", "each title must be 1 to 120 characters")
		}
		a.NewTasks[i] = title
	}
	if len(a.TaskIDs) > 0 {
		ids := slices.Compact(slices.Sorted(slices.Values(a.TaskIDs)))
		var found []uint
		if err := db.Model(&store.Task{}).Where("user_id = ? AND id IN ? AND done = ?", userID, ids, false).Pluck("id", &found).Error; err != nil {
			return err
		}
		for _, id := range ids {
			if !slices.Contains(found, id) {
				return argErr("task_ids", "task %d is not one of the user's open tasks; call list_tasks for valid IDs", id)
			}
		}
		a.TaskIDs = ids
	}
	return nil
}

// Resolve turns the named window into local days.
func (a *Args) Resolve(now time.Time, loc *time.Location) (planner.Window, error) {
	local := now.In(loc)
	today := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	day := func(t time.Time) string { return t.Format("2006-01-02") }
	switch a.Window {
	case "today":
		return planner.Window{From: day(today), To: day(today)}, nil
	case "tomorrow":
		t := today.AddDate(0, 0, 1)
		return planner.Window{From: day(t), To: day(t)}, nil
	case "this_week":
		// Through Sunday. Weekend days are skipped unless the request allows them.
		toSunday := (7 - int(today.Weekday())) % 7
		return planner.Window{From: day(today), To: day(today.AddDate(0, 0, toSunday))}, nil
	case "next_week":
		toMonday := (8 - int(today.Weekday())) % 7
		if toMonday == 0 {
			toMonday = 7
		}
		monday := today.AddDate(0, 0, toMonday)
		return planner.Window{From: day(monday), To: day(monday.AddDate(0, 0, 6))}, nil
	case "custom":
		start, err := time.ParseInLocation("2006-01-02", a.StartDate, loc)
		if err != nil {
			return planner.Window{}, argErr("start_date", "must be a YYYY-MM-DD date")
		}
		end := start
		if a.EndDate != "" {
			if end, err = time.ParseInLocation("2006-01-02", a.EndDate, loc); err != nil {
				return planner.Window{}, argErr("end_date", "must be a YYYY-MM-DD date")
			}
		}
		switch {
		case end.Before(start):
			return planner.Window{}, argErr("end_date", "must not be before start_date")
		case end.Before(today):
			return planner.Window{}, argErr("end_date", "is in the past (today is %s); plans can only cover today onward", day(today))
		case start.After(today.AddDate(0, 0, maxDaysAhead)):
			return planner.Window{}, argErr("start_date", "is more than %d days ahead", maxDaysAhead)
		case end.Sub(start) >= maxWindowDays*24*time.Hour:
			return planner.Window{}, argErr("end_date", "a plan covers at most %d days", maxWindowDays)
		}
		if start.Before(today) {
			start = today
		}
		return planner.Window{From: day(start), To: day(end)}, nil
	}
	return planner.Window{}, argErr("window", "must be one of %s", strings.Join(Windows, ", "))
}

// Bounds is the window as instants: the first day's midnight to the midnight after the last.
func Bounds(w planner.Window, loc *time.Location) (time.Time, time.Time, error) {
	from, err1 := time.ParseInLocation("2006-01-02", w.From, loc)
	to, err2 := time.ParseInLocation("2006-01-02", w.To, loc)
	if err := errors.Join(err1, err2); err != nil {
		return time.Time{}, time.Time{}, err
	}
	return from, to.AddDate(0, 0, 1), nil
}

// DefaultArgs is what the planning form starts with, and what a degraded assistant falls
// back to: three blocks today, or tomorrow once today's workday is nearly over.
func DefaultArgs(s store.Settings, now time.Time, loc *time.Location) Args {
	window := "today"
	local := now.In(loc)
	if end, err := time.ParseInLocation("15:04", s.WorkdayEnd, loc); err == nil {
		endToday := time.Date(local.Year(), local.Month(), local.Day(), end.Hour(), end.Minute(), 0, 0, loc)
		if local.Add(time.Hour).After(endToday) {
			window = "tomorrow"
		}
	}
	return Args{Window: window, TotalBlocks: 3}
}
