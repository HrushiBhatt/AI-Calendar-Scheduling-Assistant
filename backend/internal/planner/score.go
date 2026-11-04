package planner

import (
	"fmt"
	"slices"
	"strings"
	"time"
)

// Step 4: candidates that survive the hard constraints are scored by a weighted sum.
// Every term is normalised to [0, 1] before weighting, so the weights read as relative
// importance. Penalties are subtracted.
const (
	// historyFit: the user's completion rate for blocks started in this hour, blended with
	// a flat prior (see profile). The one personalised term, from data already stored.
	wHistory = 3.0
	// urgency: how close the task's due date is, times how early the slot is in the window.
	// Due tomorrow pulls a task's blocks forward; due next week barely does.
	wUrgency = 2.0
	// priority: the task's explicit priority (0-3), also pulling it earlier.
	wPriority = 1.0
	// energyMatch: deep tasks score in the user's two strongest hours; light tasks score
	// everywhere else, leaving those hours free. The reason a 90-minute block for hard work
	// doesn't land at 4 PM.
	wEnergy = 1.5
	// contiguity: sits next to another block of the same task. Context switching is the
	// cost this app exists to reduce.
	wContiguity = 1.0
	// fragmentation (penalty): the placement strands time that another block could have
	// used, measured as lost capacity (see refresh). Avoids stranding a useless 20 minutes.
	wFragmentation = 1.5
	// meetingAdjacency (penalty): starting straight after an hour or more of meetings,
	// scaled up to two hours. People need a minute to recover.
	wMeetingAdjacency = 1.0
)

// terms holds each weighted contribution, kept for the explanation.
type terms struct {
	history, urgency, priority, energy, contiguity, frag, fatigue float64
	only                                                          bool // the only slot that fits
	first                                                         bool // the earliest slot that fits
}

// score sums the terms. Each product is converted to float64 explicitly: Go may fuse
// a*b+c into one instruction on some CPUs and not others, and an explicit conversion
// forbids that, so a plan is identical on a laptop and in CI.
func (p *planner) score(c *cand, j *job) (float64, terms) {
	var t terms
	early := p.earliness(c.start)
	t.history = float64(wHistory * c.history)
	if j != nil {
		t.urgency = float64(wUrgency * j.urgency * early)
		t.priority = float64(wPriority * float64(j.task.Priority) / 3 * early)
		t.energy = float64(wEnergy * p.energyMatch(c, j))
		t.contiguity = float64(wContiguity * p.contiguity(c, j))
	}
	t.frag = -float64(wFragmentation * c.frag)
	t.fatigue = -float64(wMeetingAdjacency * c.fatigue)
	return t.history + t.urgency + t.priority + t.energy + t.contiguity + t.frag + t.fatigue, t
}

// earliness is 1 at the first possible start and 0 at the end of the window.
func (p *planner) earliness(t time.Time) float64 {
	total := p.horizon.Sub(p.earliest)
	if total <= 0 {
		return 1
	}
	return max(0, min(1, 1-float64(t.Sub(p.earliest))/float64(total)))
}

func (p *planner) energyMatch(c *cand, j *job) float64 {
	if !p.hasPeaks {
		return 0
	}
	switch j.task.Energy {
	case "deep":
		if p.peak[c.hour] {
			return 1
		}
	case "light":
		if !p.peak[c.hour] {
			return 1
		}
	}
	return 0
}

// contiguity is 1 when the candidate sits next to another block of the same task: no
// more idle time between them than the required gap plus one grid step.
func (p *planner) contiguity(c *cand, j *job) float64 {
	for _, o := range p.days[c.day].occ {
		if o.task == "" || o.task != j.key {
			continue
		}
		var idle time.Duration
		switch {
		case !c.start.Before(o.end):
			idle = c.start.Sub(o.end)
		case !o.start.Before(c.end):
			idle = o.start.Sub(c.end)
		default:
			continue
		}
		if idle <= p.gap+Grid {
			return 1
		}
	}
	return 0
}

// explain says why a slot won, in one line built from its strongest reasons. It names no
// times and no meeting titles: it is shown to the model too, which only sees "Busy" unless
// the user shares titles.
func (p *planner) explain(c *cand, j *job, t terms) string {
	type reason struct {
		weight float64
		text   string
	}
	var rs []reason
	add := func(w float64, format string, args ...any) { rs = append(rs, reason{w, fmt.Sprintf(format, args...)}) }

	if t.only {
		add(10, "the only open slot that fits")
	}
	if c.exact && c.segLen > 0 {
		if c.flush {
			add(4, "fills a %d-minute gap exactly", int(c.segLen.Minutes()))
		} else {
			add(4, "fills a %d-minute gap", int(c.segLen.Minutes()))
		}
	}
	if j != nil {
		if t.contiguity > 0 {
			add(3.5, "right next to your other block for this task")
		}
		if t.urgency >= 0.4 && j.task.DueAt != nil {
			add(3+t.urgency, "due %s, so it goes early", j.task.DueAt.In(p.loc).Format("Mon Jan 2"))
		}
		if t.energy > 0 && j.task.Energy == "deep" {
			add(3, "one of your two strongest hours, kept for deep work")
		}
		if t.energy > 0 && j.task.Energy == "light" {
			add(2, "light work outside your peak hours, so they stay free")
		}
		if t.priority >= 0.5 {
			add(1.5, "high priority, so it goes early")
		}
	}
	// A good completion rate is a reason to pick an hour; a poor one isn't, so only a
	// strong hour is quoted.
	h := p.in.History.Hours[c.hour]
	if h.Sessions >= 3 && float64(h.Completed)/float64(h.Sessions) >= 0.6 {
		add(1+t.history, "you finish %.0f%% of blocks you start at this hour", 100*float64(h.Completed)/float64(h.Sessions))
	}
	if t.fatigue == 0 && p.followsMeeting(c.start) {
		add(0.5, "a short break after your meeting first")
	}
	slices.SortStableFunc(rs, func(a, b reason) int {
		return cmpAll(-cmpRate(a.weight, b.weight), strings.Compare(a.text, b.text))
	})
	if len(rs) == 0 {
		switch {
		case t.first:
			return "the earliest open slot that fits"
		case p.afterLongMeeting(c.start):
			return "leaves time to recover after a long meeting"
		case t.frag == 0:
			return "keeps the rest of your free time in usable pieces"
		}
		return "the best open slot left"
	}
	parts := []string{rs[0].text}
	if len(rs) > 1 {
		parts = append(parts, rs[1].text)
	}
	return strings.Join(parts, ", and ")
}

// followsMeeting reports whether a meeting ends within the buffer plus a grid step before t.
func (p *planner) followsMeeting(t time.Time) bool {
	window := time.Duration(p.in.Prefs.BufferMin)*time.Minute + Grid
	for _, b := range p.busy {
		if !b.end.After(t) && t.Sub(b.end) <= window {
			return true
		}
	}
	return false
}

// afterLongMeeting reports whether an hour or more of meetings ended in the hour before t.
func (p *planner) afterLongMeeting(t time.Time) bool {
	for _, b := range p.busy {
		if !b.end.After(t) && t.Sub(b.end) <= time.Hour && b.len() >= time.Hour {
			return true
		}
	}
	return false
}
