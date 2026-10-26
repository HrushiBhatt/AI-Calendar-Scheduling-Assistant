// Package demo seeds an account that shows the planner working without any OAuth: a
// fake calendar with two weeks of meetings, a few tasks, and a month of past sessions so
// the completion-by-hour profile has something to say.
package demo

import (
	"context"
	"fmt"
	"math/rand/v2"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const (
	Email    = "demo@brewfocus.dev"
	Password = "brewfocus"
	Zone     = "America/New_York"
)

// Seed creates the demo account on first run. On every run it regenerates the fake
// calendar around today, so the demo always has meetings tomorrow.
func Seed(ctx context.Context, db *gorm.DB, cal *calendar.Service, fake *calendar.Fake, now time.Time) error {
	loc, err := time.LoadLocation(Zone)
	if err != nil {
		return err
	}
	var user store.User
	if err := db.Where("email = ?", Email).Limit(1).Find(&user).Error; err != nil {
		return err
	}
	if user.ID == 0 {
		hash, err := auth.HashPassword(Password)
		if err != nil {
			return err
		}
		settings := store.DefaultSettings
		settings.TimeZone = Zone
		user = store.User{Email: Email, Name: "Demo", PasswordHash: hash, Settings: settings}
		if err := db.Create(&user).Error; err != nil {
			return err
		}
		if err := seedWork(db, user.ID, now, loc); err != nil {
			return err
		}
	}
	fake.Reset(Email, meetings(now, loc))
	var acct store.CalendarAccount
	if err := db.Where("user_id = ? AND provider = ?", user.ID, fake.Name()).Limit(1).Find(&acct).Error; err != nil {
		return err
	}
	if acct.ID == 0 {
		_, err = cal.ConnectDemo(ctx, user.ID, fake.Name(), &calendar.Credentials{Account: Email})
		return err
	}
	return cal.Sync(ctx, acct.ID)
}

// seedWork adds tasks and a month of finished sessions. Mornings complete far more
// often than afternoons, so the planner's history term visibly prefers them.
func seedWork(db *gorm.DB, userID uint, now time.Time, loc *time.Location) error {
	day := func(n int) time.Time {
		l := now.In(loc)
		return time.Date(l.Year(), l.Month(), l.Day()+n, 17, 0, 0, 0, loc)
	}
	due := func(n int) *time.Time { t := day(n).UTC(); return &t }
	tasks := []store.Task{
		{UserID: userID, Title: "Compiler project: register allocator", Estimate: 4, Priority: 2, Energy: store.EnergyDeep, DueAt: due(3)},
		{UserID: userID, Title: "Write the design doc for sync", Estimate: 2, Priority: 1, Energy: store.EnergyDeep, DueAt: due(6)},
		{UserID: userID, Title: "Review open pull requests", Estimate: 2, Priority: 1, Energy: store.EnergyLight},
		{UserID: userID, Title: "Inbox zero", Estimate: 1, Energy: store.EnergyLight},
	}
	if err := db.Create(&tasks).Error; err != nil {
		return err
	}
	rng := rand.New(rand.NewPCG(7, 11)) // #nosec G404 -- a fixed seed so the demo is the same every time; nothing secret

	var sessions []store.Session
	for d := -30; d < 0; d++ {
		date := now.In(loc).AddDate(0, 0, d)
		if date.Weekday() == time.Saturday || date.Weekday() == time.Sunday {
			continue
		}
		for _, hour := range []int{9, 10, 11, 14, 15, 16} {
			if rng.Float64() < 0.35 {
				continue
			}
			// The pattern the history term should find: strong mornings, a weak afternoon slump.
			rate := map[int]float64{9: 0.9, 10: 0.85, 11: 0.7, 14: 0.45, 15: 0.35, 16: 0.4}[hour]
			completed := rng.Float64() < rate
			start := time.Date(date.Year(), date.Month(), date.Day(), hour, 0, 0, 0, loc)
			focused := 1500
			if !completed {
				focused = 300 + rng.IntN(900)
			}
			// Untasked: the history is for the hour-of-day profile, and shouldn't use up the
			// estimates of the tasks the demo is about to plan.
			sessions = append(sessions, store.Session{
				UserID: userID, Mode: "Pomodoro", Planned: 1500, Focused: focused, Completed: completed,
				Day: start.Format("2006-01-02"), State: store.StateDone, CreatedAt: start.UTC(),
			})
		}
	}
	return db.Create(&sessions).Error
}

// meetings is two weeks of a plausible calendar around now, in loc.
func meetings(now time.Time, loc *time.Location) []calendar.Event {
	var out []calendar.Event
	at := func(d time.Time, h, m int) time.Time {
		return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, loc).UTC()
	}
	add := func(id, title string, start time.Time, minutes int) {
		out = append(out, calendar.Event{ID: id, Title: title, Start: start, End: start.Add(time.Duration(minutes) * time.Minute), Busy: true})
	}
	today := now.In(loc)
	for d := -2; d < 14; d++ {
		date := today.AddDate(0, 0, d)
		key := date.Format("20060102")
		if date.Weekday() == time.Saturday || date.Weekday() == time.Sunday {
			continue
		}
		add("standup-"+key, "Team standup", at(date, 9, 30), 15)
		switch date.Weekday() {
		case time.Monday:
			add("planning-"+key, "Sprint planning", at(date, 13, 0), 90)
			add("1on1-"+key, "1:1 with Sam", at(date, 16, 0), 30)
		case time.Tuesday:
			add("review-"+key, "Design review", at(date, 11, 0), 60)
			add("interview-"+key, "Interview loop", at(date, 14, 30), 60)
		case time.Wednesday:
			add("allhands-"+key, "All hands", at(date, 15, 0), 60)
		case time.Thursday:
			add("arch-"+key, "Architecture sync", at(date, 10, 30), 90)
			add("customer-"+key, "Customer call", at(date, 14, 0), 45)
			out = append(out, calendar.Event{ID: "optional-" + key, Title: "Optional: brown bag talk",
				Start: at(date, 12, 0), End: at(date, 13, 0), Busy: false}) // declined, so not busy
		case time.Friday:
			add("demo-"+key, "Sprint demo", at(date, 15, 30), 60)
		}
	}
	// One all-day event, as context: it doesn't block time.
	offsite := today.AddDate(0, 0, 5)
	start := time.Date(offsite.Year(), offsite.Month(), offsite.Day(), 0, 0, 0, 0, loc)
	out = append(out, calendar.Event{ID: fmt.Sprintf("offsite-%s", offsite.Format("20060102")), Title: "Team offsite (remote)",
		Start: start.UTC(), End: start.AddDate(0, 0, 1).UTC(), AllDay: true})
	return out
}
