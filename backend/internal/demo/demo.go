// Package demo seeds a sample account, so the app can be tried with something to look at:
// a few tasks and a month of past sessions behind the progress page.
package demo

import (
	"math/rand/v2"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// The demo account's public sign-in. It holds no real data, and the API won't let a visitor
// change its password or link it to Google, so one visitor can't lock out the rest.
const (
	Email    = "demo@brewfocus.dev"
	Password = "brewfocus"
)

// Seed creates the demo account on first run and leaves it alone after that.
func Seed(db *gorm.DB, now time.Time) error {
	var user store.User
	if err := db.Where("email = ?", Email).Limit(1).Find(&user).Error; err != nil {
		return err
	}
	if user.ID != 0 {
		return nil
	}
	hash, err := auth.HashPassword(Password)
	if err != nil {
		return err
	}
	user = store.User{Email: Email, Name: "Demo", PasswordHash: hash, Settings: store.DefaultSettings}
	if err := db.Create(&user).Error; err != nil {
		return err
	}
	return seedWork(db, user.ID, now)
}

// seedWork adds the sample tasks and a month of finished weekday sessions.
func seedWork(db *gorm.DB, userID uint, now time.Time) error {
	tasks := []store.Task{
		{UserID: userID, Title: "Compiler project: register allocator", Estimate: 4},
		{UserID: userID, Title: "Write the design doc", Estimate: 2},
		{UserID: userID, Title: "Review open pull requests", Estimate: 2},
		{UserID: userID, Title: "Inbox zero", Estimate: 1},
	}
	if err := db.Create(&tasks).Error; err != nil {
		return err
	}

	rng := rand.New(rand.NewPCG(7, 11)) // #nosec G404 -- a fixed seed so the demo is the same every time; nothing secret
	var sessions []store.Session
	for d := -30; d < 0; d++ {
		date := now.AddDate(0, 0, d)
		if date.Weekday() == time.Saturday || date.Weekday() == time.Sunday {
			continue
		}
		for _, hour := range []int{9, 10, 11, 14, 15, 16} {
			if rng.Float64() < 0.35 {
				continue // not every slot gets a session
			}
			completed := rng.Float64() < 0.7
			focused := 1500 // a full 25 minutes
			if !completed {
				focused = 300 + rng.IntN(900) // ended early, somewhere between 5 and 20 minutes
			}
			start := time.Date(date.Year(), date.Month(), date.Day(), hour, 0, 0, 0, now.Location())
			sessions = append(sessions, store.Session{
				UserID: userID, Mode: "Pomodoro", Planned: 1500, Focused: focused, Completed: completed,
				Day: start.Format("2006-01-02"), State: store.StateDone, CreatedAt: start.UTC(),
			})
		}
	}
	return db.Create(&sessions).Error
}
