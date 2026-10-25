// Package store defines the database models and opens the SQLite database.
package store

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"time"

	"github.com/glebarez/sqlite" // pure-Go SQLite driver: no C compiler needed
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Settings are a user's preferences, stored on the server so they follow them across devices.
type Settings struct {
	Sound     bool   `json:"sound"`
	Notify    bool   `json:"notify"`
	AutoBreak bool   `json:"autoBreak"`
	Strict    bool   `json:"strict"`
	Breathe   bool   `json:"breathe"`
	Tick      string `json:"tick" binding:"oneof=off clock ominous"`

	// Planning. The scheduler's hard constraints are the user's preferences, not constants.
	TimeZone          string `json:"timeZone" binding:"required,max=64"` // IANA name, e.g. "America/Chicago"
	WorkdayStart      string `json:"workdayStart" binding:"required,datetime=15:04"`
	WorkdayEnd        string `json:"workdayEnd" binding:"required,datetime=15:04"`
	MinGapMin         int    `json:"minGapMin" binding:"min=0,max=120"` // between blocks, beyond the mode's own rest
	BufferMin         int    `json:"bufferMin" binding:"min=0,max=60"`  // kept clear on each side of a meeting
	MaxBlocksPerDay   int    `json:"maxBlocksPerDay" binding:"min=1,max=12"`
	MaxFocusMinPerDay int    `json:"maxFocusMinPerDay" binding:"min=25,max=720"`
	ProtectLunch      bool   `json:"protectLunch"` // keep 12:00–13:00 free
	WriteBack         bool   `json:"writeBack"`    // copy accepted blocks to a "Brew Focus" Google calendar
	AssistantEnabled  bool   `json:"assistantEnabled"`
	// ShareEventTitles sends meeting titles to the assistant's model. Off by default,
	// so the model sees only "Busy"; the scheduler works identically either way.
	ShareEventTitles bool `json:"shareEventTitles"`
}

// DefaultSettings apply to new accounts, and fill in fields an older account never saved.
var DefaultSettings = Settings{
	Sound: true, AutoBreak: true, Breathe: true, Tick: "off",
	WorkdayStart: "09:00", WorkdayEnd: "17:00", BufferMin: 10, MinGapMin: 0,
	MaxBlocksPerDay: 4, MaxFocusMinPerDay: 240, ProtectLunch: true, AssistantEnabled: true,
}

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

// ErrNoTimeZone means the user has not saved a time zone yet, so days can't be placed.
var ErrNoTimeZone = errors.New("set your time zone in settings first")

// Location loads the user's IANA time zone. All planning arithmetic happens in it.
func (s Settings) Location() (*time.Location, error) {
	return LoadZone(s.TimeZone)
}

// LoadZone loads an IANA zone name, rejecting the empty string and "Local", which
// time.LoadLocation accepts but which mean the server's zone rather than the user's.
func LoadZone(name string) (*time.Location, error) {
	if name == "" {
		return nil, ErrNoTimeZone
	}
	if strings.EqualFold(name, "Local") {
		return nil, errors.New("timeZone must be an IANA name such as Europe/Berlin")
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, errors.New("timeZone must be an IANA name such as Europe/Berlin")
	}
	return loc, nil
}

type User struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	Email        string    `json:"email" gorm:"size:254;uniqueIndex;not null"`
	Name         string    `json:"name" gorm:"size:60"`
	PasswordHash []byte    `json:"-" gorm:"not null"`
	Settings     Settings  `json:"settings" gorm:"serializer:json"`
	CreatedAt    time.Time `json:"created_at"`
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

// Task energy levels: deep work goes in the user's strongest hours, light work fills the rest.
const (
	EnergyDeep  = "deep"
	EnergyLight = "light"
)

// Task is something to get done, worked on over one or more focus sessions.
type Task struct {
	ID        uint       `json:"id" gorm:"primaryKey"`
	UserID    uint       `json:"-" gorm:"index;not null"`
	Title     string     `json:"title" gorm:"size:120;not null"`
	Estimate  int        `json:"estimate"` // planned number of focus blocks
	Done      bool       `json:"done"`
	DueAt     *time.Time `json:"due_at"`
	Priority  int        `json:"priority"`             // 0 (none) to 3 (urgent)
	Energy    string     `json:"energy" gorm:"size:8"` // deep, light, or "" for unspecified
	CreatedAt time.Time  `json:"created_at"`
}

// Session states. A focus session is written when it starts and updated as it runs,
// so a restarted server can pick it back up. Only done sessions count in stats.
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
	// ScheduledID links a session to the planned block that started it. Null means the
	// user started it by hand, which is what the planned-vs-ad-hoc comparison splits on.
	ScheduledID *uint     `json:"scheduled_id" gorm:"index"`
	CreatedAt   time.Time `json:"created_at"`
}

// Done scopes a query to one user's finished sessions.
func Done(userID uint) func(*gorm.DB) *gorm.DB {
	return func(db *gorm.DB) *gorm.DB {
		return db.Where("user_id = ? AND state = ?", userID, StateDone)
	}
}

// ---- calendars ---------------------------------------------------------------------

// CalendarAccount is a connected external calendar. Tokens are encrypted at rest.
type CalendarAccount struct {
	ID           uint      `json:"id" gorm:"primaryKey"`
	UserID       uint      `json:"-" gorm:"index;not null"`
	Provider     string    `json:"provider" gorm:"size:16;not null"`     // "google"
	ExternalID   string    `json:"external_id" gorm:"size:254;not null"` // the account's email
	AccessToken  []byte    `json:"-" gorm:"serializer:sealed;not null"`  // AES-GCM sealed
	RefreshToken []byte    `json:"-" gorm:"serializer:sealed;not null"`  // AES-GCM sealed
	Expiry       time.Time `json:"-"`
	SyncToken    string    `json:"-" gorm:"size:512"` // Google's incremental sync cursor
	// FullSyncAt is the last full pull. Incremental sync only reports changed events, so an
	// old event drifting into the 60-day window would never arrive; a weekly full pull fixes that.
	FullSyncAt *time.Time `json:"-"`
	// Push notifications. Google echoes ChannelToken in X-Goog-Channel-Token, which is how
	// the unauthenticated webhook tells a real notification from a forged one.
	ChannelID       string     `json:"-" gorm:"size:64;index"`
	ChannelToken    string     `json:"-" gorm:"size:64"`
	ChannelResource string     `json:"-" gorm:"size:128"` // Google's resourceId, needed to stop the channel
	ChannelExpiry   time.Time  `json:"-"`
	WriteCalID      string     `json:"-" gorm:"size:254"` // our own calendar, for write-back
	LastSyncAt      *time.Time `json:"last_sync_at"`
	SyncError       string     `json:"sync_error" gorm:"size:200"`
	CreatedAt       time.Time  `json:"created_at"`
}

// CalendarEvent is a busy interval pulled from a provider. Only what scheduling needs
// is stored: no attendees, no description, no location.
type CalendarEvent struct {
	ID         uint      `json:"id" gorm:"primaryKey"`
	UserID     uint      `json:"-" gorm:"index:idx_evt_user_window,priority:1;not null"`
	AccountID  uint      `json:"-" gorm:"uniqueIndex:idx_evt_account_ext,priority:1;not null"`
	ExternalID string    `json:"-" gorm:"size:254;uniqueIndex:idx_evt_account_ext,priority:2;not null"`
	Title      string    `json:"title" gorm:"size:200"`
	StartsAt   time.Time `json:"starts_at" gorm:"index:idx_evt_user_window,priority:2;not null"`
	EndsAt     time.Time `json:"ends_at" gorm:"not null"`
	AllDay     bool      `json:"all_day"`
	Busy       bool      `json:"busy"`        // not transparent and not declined
	OwnedByUs  bool      `json:"owned_by_us"` // we created it; never treat as busy
	UpdatedAt  time.Time `json:"-"`
}

// ---- plans -------------------------------------------------------------------------

// Plan statuses.
const (
	PlanProposed   = "proposed"
	PlanAccepted   = "accepted"
	PlanRejected   = "rejected"
	PlanSuperseded = "superseded"
)

// Plan sources: which of the three paths into the planner produced it, plus reconciliation.
const (
	SourceAssistant = "assistant"
	SourceForm      = "form"
	SourceQuick     = "quick"
	SourceConflict  = "conflict"
)

// UnplacedTask is a task the scheduler could not fit, with a machine-readable reason.
type UnplacedTask struct {
	TaskID *uint  `json:"task_id"`
	Task   string `json:"task"`
	Wanted int    `json:"wanted"`
	Placed int    `json:"placed"`
	Reason string `json:"reason"` // no_gap_long_enough, day_cap_reached, due_date_passed, ...
}

// Plan is one scheduling proposal covering a window.
type Plan struct {
	ID          uint      `json:"id" gorm:"primaryKey"`
	UserID      uint      `json:"-" gorm:"index;not null"`
	Status      string    `json:"status" gorm:"size:12;index;not null"` // proposed|accepted|rejected|superseded
	Source      string    `json:"source" gorm:"size:12"`
	WindowStart time.Time `json:"window_start" gorm:"not null"`
	WindowEnd   time.Time `json:"window_end" gorm:"not null"`
	Request     string    `json:"request" gorm:"size:500"`    // the user's words, verbatim
	Rationale   string    `json:"rationale" gorm:"size:1200"` // the model's narration
	InputHash   string    `json:"-" gorm:"size:64;index"`     // sha256 of planner.Input, for cache + reproducibility
	// RequestHash covers the user's words plus everything the model could look up, so an
	// identical request against an unchanged calendar reuses the plan without a model call.
	RequestHash string         `json:"-" gorm:"size:64;index"`
	Unplaced    []UnplacedTask `json:"unplaced" gorm:"serializer:json"`
	Notes       []string       `json:"notes" gorm:"serializer:json"`
	// Replaces lists the conflicted blocks a reconciliation plan would replace.
	Replaces []uint `json:"replaces,omitempty" gorm:"serializer:json"`
	// What the request allowed, so a block dragged later is held to the same limits.
	AllowEvening bool      `json:"allow_evening"`
	AllowWeekend bool      `json:"allow_weekend"`
	CreatedAt    time.Time `json:"created_at"`
}

// Scheduled block statuses.
const (
	BlockProposed   = "proposed"
	BlockAccepted   = "accepted"
	BlockRejected   = "rejected"
	BlockStarted    = "started"
	BlockDone       = "done"
	BlockSkipped    = "skipped"
	BlockConflicted = "conflicted"
)

// ScheduledSession is one planned focus block. It becomes a store.Session when it starts.
type ScheduledSession struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	UserID    uint      `json:"-" gorm:"index:idx_sched_due,priority:1;not null"`
	PlanID    uint      `json:"plan_id" gorm:"index;not null"`
	TaskID    *uint     `json:"task_id"`
	NewTask   bool      `json:"new_task"`   // the task is created, titled Intention, when the block is accepted
	SessionID *uint     `json:"session_id"` // set once the engine starts it
	Mode      string    `json:"mode" gorm:"size:32;not null"`
	StartsAt  time.Time `json:"starts_at" gorm:"index:idx_sched_due,priority:2;not null"`
	FocusMin  int       `json:"focus_min" gorm:"not null"`
	RestMin   int       `json:"rest_min"`
	Intention string    `json:"intention" gorm:"size:140"`
	Status    string    `json:"status" gorm:"size:12;index;not null"` // proposed|accepted|rejected|started|done|skipped|conflicted
	Explain   string    `json:"explain" gorm:"size:300"`              // why the scheduler chose this slot
	Score     float64   `json:"score"`
	Note      string    `json:"note" gorm:"size:160"` // why it was skipped, conflicted or moved
	// Write-back: the Google event we created for it, and on which account.
	CalendarAccountID *uint     `json:"-"`
	ExternalEventID   string    `json:"-" gorm:"size:254"`
	CreatedAt         time.Time `json:"created_at"`
}

// EndsAt is when the block's focus and rest are both over.
func (s ScheduledSession) EndsAt() time.Time {
	return s.StartsAt.Add(time.Duration(s.FocusMin+s.RestMin) * time.Minute)
}

// ToolCall is one tool call the model emitted, kept verbatim for the eval set.
type ToolCall struct {
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
	Error string          `json:"error,omitempty"` // why it was rejected, if it was
}

// AssistantTurn is one exchange, kept for the eval set and for spend accounting.
type AssistantTurn struct {
	ID            uint       `json:"id" gorm:"primaryKey"`
	UserID        uint       `json:"-" gorm:"index;not null"`
	PlanID        *uint      `json:"plan_id"`
	UserText      string     `json:"user_text" gorm:"size:500"`
	ToolCalls     []ToolCall `json:"tool_calls" gorm:"serializer:json"`
	Narration     string     `json:"narration" gorm:"size:1200"`
	Model         string     `json:"model" gorm:"size:48"`
	PromptVersion string     `json:"prompt_version" gorm:"size:24"`
	InputTokens   int        `json:"input_tokens"`
	OutputTokens  int        `json:"output_tokens"`
	LatencyMs     int        `json:"latency_ms"`
	Degraded      bool       `json:"degraded"`
	Failure       string     `json:"failure" gorm:"size:120"` // refusal, bad args, timeout, ...
	CreatedAt     time.Time  `json:"created_at" gorm:"index"`
}

// ---- the café -------------------------------------------------------------------------

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

// Open connects to the SQLite database at path (":memory:" for tests) and migrates the schema.
func Open(path string) (*gorm.DB, error) {
	dsn := path
	if path != ":memory:" {
		// WAL lets readers proceed while a write is in flight, and the busy timeout makes a
		// writer wait for the lock instead of failing: HTTP handlers, the timer engine, the
		// dispatcher and the calendar syncer now share this database.
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		dsn = path + sep + "_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	}
	db, err := gorm.Open(&sqlite.Dialector{DriverName: utcDriverName, DSN: dsn}, &gorm.Config{
		NowFunc: func() time.Time { return time.Now().UTC() },
		Logger: logger.New(log.New(os.Stderr, "", log.LstdFlags), logger.Config{
			SlowThreshold:             200 * time.Millisecond,
			LogLevel:                  logger.Warn,
			IgnoreRecordNotFoundError: true, // a 404, not a problem worth logging
		}),
	})
	if err != nil {
		return nil, err
	}
	sqlDB, err := db.DB()
	if err != nil {
		return nil, err
	}
	// One connection: SQLite serializes writes anyway, and ":memory:" gives each connection its own database.
	sqlDB.SetMaxOpenConns(1)
	return db, db.AutoMigrate(
		&User{}, &Preset{}, &Task{}, &Session{},
		&CalendarAccount{}, &CalendarEvent{}, &Plan{}, &ScheduledSession{}, &AssistantTurn{},
	)
}
