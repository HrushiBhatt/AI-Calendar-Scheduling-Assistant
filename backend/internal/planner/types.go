// Package planner places focus blocks into free time. It is pure: the same Input always
// produces the same Plan. It reads no clock (Now is an argument), makes no network calls,
// logs nothing and never consults a model. That is what makes it exhaustively testable,
// and why "why 2pm?" always has an answer that does not involve replaying a prompt.
package planner

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"time"
)

// Input is everything a plan depends on.
type Input struct {
	Now     time.Time      `json:"now"`
	Loc     *time.Location `json:"-"` // serialized as "zone"
	Window  Window         `json:"window"`
	Busy    []Interval     `json:"busy"`             // events from every calendar; Interval says which block time
	Booked  []Booked       `json:"booked,omitempty"` // accepted blocks from earlier plans
	Tasks   []Task         `json:"tasks"`            // candidates: estimate, due date, priority, energy
	Prefs   Prefs          `json:"prefs"`
	Modes   []Mode         `json:"modes"` // Modes[0] is the default rhythm
	Request Ask            `json:"request"`
	History Profile        `json:"history"`
}

// Window is the span of local days being planned, both ends inclusive, in Loc.
type Window struct {
	From string `json:"from"` // YYYY-MM-DD
	To   string `json:"to"`
}

// Interval is a calendar event. The flags record why an event does not block time, so
// the rule for what counts as busy lives here, in one tested place.
type Interval struct {
	Start  time.Time `json:"start"`
	End    time.Time `json:"end"`
	AllDay bool      `json:"all_day,omitempty"` // context only: people work through their own birthdays
	Free   bool      `json:"free,omitempty"`    // marked free (transparent), or an invite the user declined
	Ours   bool      `json:"ours,omitempty"`    // a focus block we wrote back, not a meeting
}

// blocks reports whether the event makes the user unavailable.
func (iv Interval) blocks() bool { return !iv.AllDay && !iv.Free && !iv.Ours }

// Booked is an accepted block from an earlier plan: nothing may overlap it, and it counts
// toward the day's caps.
type Booked struct {
	Start    time.Time `json:"start"`
	FocusMin int       `json:"focus_min"`
	RestMin  int       `json:"rest_min"`
	TaskID   uint      `json:"task_id,omitempty"`
}

// Task is a candidate for blocks.
type Task struct {
	ID        uint       `json:"id"`    // 0 for a task the user named that does not exist yet
	Title     string     `json:"title"` // identifies a new task
	Remaining int        `json:"remaining"`
	DueAt     *time.Time `json:"due_at,omitempty"`
	Priority  int        `json:"priority,omitempty"` // 0–3
	Energy    string     `json:"energy,omitempty"`   // deep, light or ""
}

// Mode is a focus/rest rhythm, e.g. 50/10.
type Mode struct {
	Name     string `json:"name"`
	FocusMin int    `json:"focus_min"`
	RestMin  int    `json:"rest_min"`
}

func (m Mode) occupies() time.Duration { return time.Duration(m.FocusMin+m.RestMin) * time.Minute }

// Prefs are the user's hard limits. Times of day are "HH:MM" in Loc.
type Prefs struct {
	WorkdayStart      string `json:"workday_start"`
	WorkdayEnd        string `json:"workday_end"`
	BufferMin         int    `json:"buffer_min"`  // kept clear either side of a meeting
	MinGapMin         int    `json:"min_gap_min"` // between blocks, beyond a mode's own rest
	MaxBlocksPerDay   int    `json:"max_blocks_per_day"`
	MaxFocusMinPerDay int    `json:"max_focus_min_per_day"`
	ProtectLunch      bool   `json:"protect_lunch"`
}

// Ask is the structured form of what the user asked for.
type Ask struct {
	TaskIDs       []uint `json:"task_ids,omitempty"`        // named tasks; new tasks are Input.Tasks with ID 0
	TotalBlocks   int    `json:"total_blocks,omitempty"`    // 0 means no total beyond the day caps
	BlocksPerTask int    `json:"blocks_per_task,omitempty"` // 0 means each task's remaining estimate
	ModeHint      string `json:"mode_hint,omitempty"`       // a mode name, or "deep" / "short"
	AllowEvening  bool   `json:"allow_evening,omitempty"`
	AllowWeekend  bool   `json:"allow_weekend,omitempty"`
	AvoidBefore   string `json:"avoid_before,omitempty"` // "HH:MM"
	AvoidAfter    string `json:"avoid_after,omitempty"`
	// Fill places untasked blocks in whatever free time remains, up to the caps
	// ("fill my free time today").
	Fill bool `json:"fill,omitempty"`
}

// Profile is how often the user finishes blocks started at each local hour.
type Profile struct {
	Hours [24]HourStat `json:"hours"`
}

// HourStat counts finished sessions that started in one hour of the day.
type HourStat struct {
	Sessions  int `json:"sessions"`
	Completed int `json:"completed"` // ran all the way to zero
}

// Sessions is the total number of sessions in the profile.
func (p Profile) Sessions() int {
	n := 0
	for _, h := range p.Hours {
		n += h.Sessions
	}
	return n
}

// Result is the scheduler's answer. (The spec calls it Plan, but Go can't give a type and
// the function that returns it the same name in one package.)
type Result struct {
	Blocks   []Block    `json:"blocks"`
	Unplaced []Unplaced `json:"unplaced"` // a task that did not fit is reported, never silently dropped
	Notes    []string   `json:"notes"`    // machine-readable facts for the model to narrate
}

// Block is one placed focus block.
type Block struct {
	TaskID   *uint     `json:"task_id"`
	Task     string    `json:"task"` // the title; for a new task, the only identity it has
	StartsAt time.Time `json:"starts_at"`
	FocusMin int       `json:"focus_min"`
	RestMin  int       `json:"rest_min"`
	Mode     string    `json:"mode"`
	Score    float64   `json:"score"`
	Explain  string    `json:"explain"` // why this slot, in one line, for the UI and the model
}

// Unplaced is a task that got fewer blocks than it wanted, and why.
type Unplaced struct {
	TaskID *uint  `json:"task_id"`
	Task   string `json:"task"`
	Wanted int    `json:"wanted"`
	Placed int    `json:"placed"`
	Reason string `json:"reason"`
}

// Reasons a task got fewer blocks than it wanted. The model narrates these; it never invents them.
const (
	ReasonNoGap           = "no_gap_long_enough"
	ReasonDayCap          = "day_cap_reached"
	ReasonDuePassed       = "due_date_passed"
	ReasonNoSlotBeforeDue = "no_slot_before_due"
	ReasonTotalReached    = "total_blocks_reached"
)

// MarshalJSON writes Loc as its IANA name, so fixtures and hashes are plain JSON.
func (in Input) MarshalJSON() ([]byte, error) {
	type plain Input // drops the methods, so no recursion
	zone := ""
	if in.Loc != nil {
		zone = in.Loc.String()
	}
	return json.Marshal(struct {
		Zone string `json:"zone"`
		plain
	}{zone, plain(in)})
}

func (in *Input) UnmarshalJSON(b []byte) error {
	type plain Input
	aux := struct {
		Zone string `json:"zone"`
		*plain
	}{plain: (*plain)(in)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	if aux.Zone == "" {
		return fmt.Errorf("planner: input has no zone")
	}
	loc, err := time.LoadLocation(aux.Zone)
	if err != nil {
		return err
	}
	in.Loc = loc
	return nil
}

// Canonical returns the input in a normal form that plans identically: slices sorted, and
// Now moved to the last instant with the same earliest start. The planner uses Now only
// through that earliest start (Now plus the lead, rounded up to the grid), so two requests
// a few minutes apart in the same grid slot have the same canonical input and hash.
func (in Input) Canonical() Input {
	out := in
	out.Now = earliestStart(in.Now).Add(-Lead).In(time.UTC)
	out.Busy = slices.Clone(in.Busy)
	slices.SortFunc(out.Busy, func(a, b Interval) int {
		return cmpAll(a.Start.Compare(b.Start), a.End.Compare(b.End), cmpBool(a.AllDay, b.AllDay), cmpBool(a.Free, b.Free), cmpBool(a.Ours, b.Ours))
	})
	for i := range out.Busy {
		out.Busy[i].Start, out.Busy[i].End = out.Busy[i].Start.UTC(), out.Busy[i].End.UTC()
	}
	out.Booked = slices.Clone(in.Booked)
	slices.SortFunc(out.Booked, func(a, b Booked) int { return cmpAll(a.Start.Compare(b.Start), int(a.TaskID)-int(b.TaskID)) })
	for i := range out.Booked {
		out.Booked[i].Start = out.Booked[i].Start.UTC()
	}
	out.Tasks = slices.Clone(in.Tasks)
	slices.SortFunc(out.Tasks, func(a, b Task) int { return cmpAll(int(a.ID)-int(b.ID), strings.Compare(a.Title, b.Title)) })
	for i := range out.Tasks {
		if d := out.Tasks[i].DueAt; d != nil {
			u := d.UTC()
			out.Tasks[i].DueAt = &u
		}
	}
	out.Request.TaskIDs = slices.Sorted(slices.Values(in.Request.TaskIDs))
	return out
}

// Hash is the sha256 of the canonical input: equal hashes mean equal plans.
func (in Input) Hash() string {
	b, err := json.Marshal(in.Canonical())
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func cmpAll(cs ...int) int {
	for _, c := range cs {
		if c != 0 {
			return c
		}
	}
	return 0
}

func cmpBool(a, b bool) int {
	switch {
	case a == b:
		return 0
	case !a:
		return -1
	}
	return 1
}
