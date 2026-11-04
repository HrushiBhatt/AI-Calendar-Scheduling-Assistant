package plans

import (
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// BuiltinModes mirror the frontend's built-in rhythms (frontend/src/app/core/modes.ts).
var BuiltinModes = []planner.Mode{
	{Name: "Pomodoro", FocusMin: 25, RestMin: 5},
	{Name: "52 / 17", FocusMin: 52, RestMin: 17},
	{Name: "Animedoro", FocusMin: 50, RestMin: 10},
	{Name: "Deep Work", FocusMin: 90, RestMin: 20},
}

// historyDays is how far back the completion profile looks.
const historyDays = 90

// liveBlocks occupy time: accepted and not yet over.
var liveBlocks = []string{store.BlockAccepted, store.BlockStarted}

// Modes returns the user's rhythms, built-in then custom, with the one they have finished
// the most sessions in lately moved to the front: it is the default when nothing is asked.
func Modes(db *gorm.DB, userID uint, now time.Time) ([]planner.Mode, error) {
	modes := slices.Clone(BuiltinModes)
	var presets []store.Preset
	if err := db.Where("user_id = ?", userID).Order("id").Find(&presets).Error; err != nil {
		return nil, err
	}
	for _, p := range presets {
		if !slices.ContainsFunc(modes, func(m planner.Mode) bool { return strings.EqualFold(m.Name, p.Name) }) {
			modes = append(modes, planner.Mode{Name: p.Name, FocusMin: p.FocusMin, RestMin: p.RestMin})
		}
	}
	var used []struct {
		Mode string
		N    int
	}
	err := db.Model(&store.Session{}).Scopes(store.Done(userID)).Where("created_at > ?", now.AddDate(0, 0, -historyDays)).
		Select("mode, COUNT(*) AS n").Group("mode").Order("n DESC, mode").Scan(&used).Error
	if err != nil {
		return nil, err
	}
	for _, u := range used {
		if i := slices.IndexFunc(modes, func(m planner.Mode) bool { return m.Name == u.Mode }); i >= 0 {
			favourite := modes[i]
			modes = append([]planner.Mode{favourite}, slices.Delete(modes, i, i+1)...)
			break
		}
	}
	return modes, nil
}

// Profile counts the user's finished sessions by the local hour they started in.
func Profile(db *gorm.DB, userID uint, loc *time.Location, now time.Time) (planner.Profile, error) {
	var rows []struct {
		CreatedAt time.Time
		Completed bool
	}
	err := db.Model(&store.Session{}).Scopes(store.Done(userID)).Where("created_at > ?", now.AddDate(0, 0, -historyDays)).
		Select("created_at, completed").Scan(&rows).Error
	var p planner.Profile
	for _, r := range rows {
		h := &p.Hours[r.CreatedAt.In(loc).Hour()]
		h.Sessions++
		if r.Completed {
			h.Completed++
		}
	}
	return p, err
}

// prefsOf maps settings to the planner's hard limits.
func prefsOf(s store.Settings) planner.Prefs {
	return planner.Prefs{
		WorkdayStart: s.WorkdayStart, WorkdayEnd: s.WorkdayEnd, BufferMin: s.BufferMin, MinGapMin: s.MinGapMin,
		MaxBlocksPerDay: s.MaxBlocksPerDay, MaxFocusMinPerDay: s.MaxFocusMinPerDay, ProtectLunch: s.ProtectLunch,
	}
}

// BuildInput gathers everything the planner needs for a request. exclude names blocks to
// leave out of the booked set (the conflicted ones a re-plan is replacing).
func BuildInput(db *gorm.DB, user store.User, loc *time.Location, args Args, now time.Time, modes []planner.Mode, exclude []uint) (planner.Input, error) {
	window, err := args.Resolve(now, loc)
	if err != nil {
		return planner.Input{}, err
	}
	from, to, err := Bounds(window, loc)
	if err != nil {
		return planner.Input{}, err
	}
	in := planner.Input{
		Now: now, Loc: loc, Window: window, Prefs: prefsOf(user.Settings), Modes: modes,
		Request: planner.Ask{
			TaskIDs: args.TaskIDs, TotalBlocks: args.TotalBlocks, BlocksPerTask: args.BlocksPerTask, ModeHint: args.ModeHint,
			AllowEvening: args.AllowEvening, AllowWeekend: args.AllowWeekend, AvoidBefore: args.AvoidBefore, AvoidAfter: args.AvoidAfter,
			Fill: args.Fill,
		},
	}
	if in.History, err = Profile(db, user.ID, loc, now); err != nil {
		return in, err
	}

	// Events from every connected calendar, a day either side so an overnight one is seen.
	var events []store.CalendarEvent
	if err := db.Where("user_id = ? AND starts_at < ? AND ends_at > ?", user.ID, to.AddDate(0, 0, 1), from.AddDate(0, 0, -1)).
		Order("starts_at, id").Find(&events).Error; err != nil {
		return in, err
	}
	for _, e := range events {
		in.Busy = append(in.Busy, planner.Interval{Start: e.StartsAt, End: e.EndsAt, AllDay: e.AllDay, Free: !e.Busy, Ours: e.OwnedByUs})
	}

	// Blocks accepted in earlier plans.
	var booked []store.ScheduledSession
	q := db.Where("user_id = ? AND status IN ? AND starts_at < ? AND starts_at >= ?", user.ID, liveBlocks, to.AddDate(0, 0, 1), from.AddDate(0, 0, -1))
	if len(exclude) > 0 {
		q = q.Where("id NOT IN ?", exclude)
	}
	if err := q.Order("starts_at, id").Find(&booked).Error; err != nil {
		return in, err
	}
	for _, b := range booked {
		var task uint
		if b.TaskID != nil {
			task = *b.TaskID
		}
		in.Booked = append(in.Booked, planner.Booked{Start: b.StartsAt, FocusMin: b.FocusMin, RestMin: b.RestMin, TaskID: task})
	}

	// Open tasks, with what is left of each estimate after finished brews and blocks
	// already booked for it.
	var tasks []store.Task
	if err := db.Where("user_id = ? AND done = ?", user.ID, false).Order("id").Find(&tasks).Error; err != nil {
		return in, err
	}
	var brews []struct {
		TaskID uint
		N      int
	}
	if err := db.Model(&store.Session{}).Scopes(store.Done(user.ID)).Where("task_id IS NOT NULL AND completed = ?", true).
		Select("task_id, COUNT(*) AS n").Group("task_id").Scan(&brews).Error; err != nil {
		return in, err
	}
	var ahead []struct {
		TaskID uint
		N      int
	}
	if err := db.Model(&store.ScheduledSession{}).Where("user_id = ? AND status IN ? AND task_id IS NOT NULL AND starts_at >= ?", user.ID, liveBlocks, now).
		Select("task_id, COUNT(*) AS n").Group("task_id").Scan(&ahead).Error; err != nil {
		return in, err
	}
	count := func(rows []struct {
		TaskID uint
		N      int
	}, id uint) int {
		for _, r := range rows {
			if r.TaskID == id {
				return r.N
			}
		}
		return 0
	}
	for _, t := range tasks {
		remaining := max(0, t.Estimate-count(brews, t.ID)-count(ahead, t.ID))
		in.Tasks = append(in.Tasks, planner.Task{ID: t.ID, Title: t.Title, Remaining: remaining, DueAt: t.DueAt,
			Priority: t.Priority, Energy: t.Energy})
	}
	for _, title := range args.NewTasks {
		if i := slices.IndexFunc(tasks, func(t store.Task) bool { return strings.EqualFold(t.Title, title) }); i >= 0 {
			in.Request.TaskIDs = append(in.Request.TaskIDs, tasks[i].ID) // they meant the existing one
			continue
		}
		// A task the user named that doesn't exist yet. It is created only if they accept.
		in.Tasks = append(in.Tasks, planner.Task{Title: title})
	}
	return in, nil
}
