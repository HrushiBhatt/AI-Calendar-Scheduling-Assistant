package store

// This file holds the database tables. GORM creates and updates them from these structs, so the
// schema lives in one place, next to the JSON names the API uses.

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// Settings are a user's preferences, stored on the server so they follow them across devices.
type Settings struct {
	Sound     bool   `json:"sound"`
	Notify    bool   `json:"notify"`
	AutoBreak bool   `json:"autoBreak"`
	Strict    bool   `json:"strict"` // log tab switches during focus as distractions
	Breathe   bool   `json:"breathe"`
	Tick      string `json:"tick" binding:"oneof=off clock ominous"`
}

// DefaultSettings apply to new accounts, and fill in fields an older account never saved.
var DefaultSettings = Settings{Sound: true, AutoBreak: true, Breathe: true, Tick: "off"}

// UnmarshalJSON starts from DefaultSettings, so a field missing from the stored JSON (an
// account created before the field existed) or from a request gets its default, not zero.
func (s *Settings) UnmarshalJSON(b []byte) error {
	type plain Settings // no methods, so no recursion
	p := plain(DefaultSettings)
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*s = Settings(p)
	return nil
}

// User is an account. The password hash never leaves the server.
type User struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	Email        string    `json:"email" gorm:"size:254;uniqueIndex;not null"`
	Name         string    `json:"name" gorm:"size:60"`
	PasswordHash []byte    `json:"-" gorm:"not null"`
	Settings     Settings  `json:"settings" gorm:"serializer:json"`
	CreatedAt    time.Time `json:"created_at"`
}

// LoginSession is one signed-in browser. The session cookie names a row here, so ending a
// session is a delete: signing out, changing a password or "sign out everywhere" stops a
// stolen cookie at once rather than when it expires. The ID alone is useless to anyone who
// reads the database, because the cookie must also be signed with the server's key.
type LoginSession struct {
	ID        string    `gorm:"primaryKey;size:32"`
	UserID    uint      `gorm:"index;not null"`
	ExpiresAt time.Time `gorm:"index;not null"`
	CreatedAt time.Time
}

// Preset is a saved custom timing mode, e.g. "Thesis 75/15".
type Preset struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	UserID    uint      `json:"-" gorm:"index;not null"`
	Name      string    `json:"name" gorm:"size:32;not null"`
	FocusMin  int       `json:"focus" gorm:"not null"`
	RestMin   int       `json:"rest" gorm:"not null"`
	CreatedAt time.Time `json:"-"`
}

// Task is something to get done, worked on over one or more focus sessions.
type Task struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	UserID    uint      `json:"-" gorm:"index;not null"`
	Title     string    `json:"title" gorm:"size:120;not null"`
	Estimate  int       `json:"estimate"` // planned number of focus blocks
	Done      bool      `json:"done"`
	CreatedAt time.Time `json:"created_at"`
}

// Session states. A focus session is written when it starts and updated as it runs, so a
// restarted server can pick it back up. Only done sessions count in stats.
const (
	StateRunning = "running"
	StatePaused  = "paused"
	StateDone    = "done"
)

// Session is one focus block (breaks are not stored).
type Session struct {
	ID           uint   `json:"id" gorm:"primaryKey"`
	UserID       uint   `json:"-" gorm:"index;not null"`
	TaskID       *uint  `json:"task_id"`
	Mode         string `json:"mode" gorm:"size:32;not null"`
	Planned      int    `json:"planned"`   // seconds
	Focused      int    `json:"focused"`   // seconds
	Completed    bool   `json:"completed"` // ran to zero rather than ended early
	Intention    string `json:"intention" gorm:"size:140"`
	Reflection   string `json:"reflection" gorm:"size:280"`
	Distractions int    `json:"distractions"`
	// The user's local calendar day when the block started, so streaks follow their midnight.
	Day         string     `json:"day" gorm:"size:10;index"`
	State       string     `json:"-" gorm:"size:8;index"`
	EndsAt      *time.Time `json:"-"` // while running
	RemainingMs int64      `json:"-"` // while paused
	CreatedAt   time.Time  `json:"created_at"`
}

// Done scopes a query to one user's finished sessions.
func Done(userID uint) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Where("user_id = ? AND state = ?", userID, StateDone)
	}
}

// Cafe lists the pixel decorations and the number of full brews that unlocks each.
// IDs match the sprites in the frontend.
var Cafe = []struct {
	ID string
	At int
}{
	{"sprout", 1}, {"lamp", 3}, {"cat", 5}, {"books", 10},
	{"moka", 20}, {"vinyl", 35}, {"candle", 50}, {"golden-mug", 100},
}

// CafeUnlock returns the decoration earned on reaching n full brews, or "".
func CafeUnlock(n int) string {
	for _, item := range Cafe {
		if item.At == n {
			return item.ID
		}
	}
	return ""
}
