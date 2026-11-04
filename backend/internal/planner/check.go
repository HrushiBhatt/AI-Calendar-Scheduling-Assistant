package planner

import (
	"time"
)

// Violation is the hard constraint a hand-placed block breaks.
type Violation struct {
	Code string    // one of the Violation* codes; "" means the slot is fine
	At   time.Time // the meeting, block or limit it ran into, when there is one
	End  time.Time
}

// Violation codes. The HTTP layer turns them into sentences and a 409.
const (
	ViolationTooSoon    = "too_soon"        // before now plus the lead
	ViolationOffGrid    = "off_grid"        // not on the 15-minute grid
	ViolationWeekend    = "weekend"         // a weekend day the request didn't allow
	ViolationOutsideDay = "outside_workday" // before the workday starts or after it ends
	ViolationLunch      = "lunch"           // overlaps the protected lunch hour
	ViolationMeeting    = "meeting"         // overlaps a meeting or its buffer
	ViolationTooClose   = "too_close"       // overlaps another block or its gap
	ViolationDayCap     = "day_cap"         // the day is at its block or focus cap
)

// Check validates one block placed by hand (dragged, delayed, or accepted after its
// calendar changed) against the same hard constraints Plan applies. in.Window should
// cover the block's day, in.Booked every other block, and in.Request the allowances of
// the plan it came from. It uses the planner's own helpers, so a slot Plan would never
// produce is one Check rejects.
func Check(in Input, start time.Time, m Mode) (Violation, error) {
	in.Modes = []Mode{m}
	in.Request.ModeHint = ""
	p, err := newPlanner(in)
	if err != nil {
		return Violation{}, err
	}
	end := start.Add(m.occupies())
	if start.Before(p.earliest) {
		return Violation{Code: ViolationTooSoon, At: p.earliest}, nil
	}
	if !start.Equal(ceilGrid(start)) {
		return Violation{Code: ViolationOffGrid}, nil
	}
	d := p.dayOf(start)
	if d == nil {
		return Violation{Code: ViolationOutsideDay}, nil
	}
	date, _ := time.ParseInLocation("2006-01-02", d.date, p.loc)
	if wd := date.Weekday(); (wd == time.Saturday || wd == time.Sunday) && !in.Request.AllowWeekend {
		return Violation{Code: ViolationWeekend}, nil
	}
	if start.Before(d.start) || end.After(d.end) {
		return Violation{Code: ViolationOutsideDay, At: d.start, End: d.end}, nil
	}
	if in.Prefs.ProtectLunch {
		ls, le := at(date, lunchStart, p.loc), at(date, lunchEnd, p.loc)
		if start.Before(le) && ls.Before(end) {
			return Violation{Code: ViolationLunch, At: ls, End: le}, nil
		}
	}
	buffer := time.Duration(in.Prefs.BufferMin) * time.Minute
	for _, b := range p.busy {
		if start.Before(b.end.Add(buffer)) && b.start.Add(-buffer).Before(end) {
			return Violation{Code: ViolationMeeting, At: b.start, End: b.end}, nil
		}
	}
	for _, o := range d.occ {
		if p.conflicts(start, end, o) {
			return Violation{Code: ViolationTooClose, At: o.start, End: o.end}, nil
		}
	}
	if d.blocks+1 > in.Prefs.MaxBlocksPerDay || d.focus+m.FocusMin > in.Prefs.MaxFocusMinPerDay {
		return Violation{Code: ViolationDayCap}, nil
	}
	return Violation{}, nil
}
