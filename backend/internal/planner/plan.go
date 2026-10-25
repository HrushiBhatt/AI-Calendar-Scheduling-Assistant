package planner

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

const (
	// Grid is the step candidate starts walk on. A grid, not arbitrary minutes: it bounds
	// the search, and 09:00 and 09:15 are real starts where 09:07 is not. Every UTC offset
	// in use today is a whole number of quarter hours (even +5:45 and +12:45), so the UTC
	// quarter-hour grid is also the local one.
	Grid = 15 * time.Minute
	// Lead is the least notice a block gets: nothing starts within 5 minutes of now.
	Lead = 5 * time.Minute
	// MaxDays bounds the window.
	MaxDays = 31

	lunchStart = "12:00"
	lunchEnd   = "13:00"
	// eveningEnd is how late a day may run when the user asks for evening work.
	eveningEnd = "21:00"
)

// earliestStart is the first instant a block may start: Now plus the lead, on the grid.
func earliestStart(now time.Time) time.Time { return ceilGrid(now.Add(Lead)) }

func ceilGrid(t time.Time) time.Time {
	if f := t.Truncate(Grid); f.Equal(t) {
		return f
	} else {
		return f.Add(Grid)
	}
}

type span struct{ start, end time.Time }

func (s span) len() time.Duration { return s.end.Sub(s.start) }

// occupant is a block already on a day, from this plan or an earlier one.
type occupant struct {
	start, end time.Time // end includes the rest
	task       string    // contiguity key; "" for untasked blocks
}

type day struct {
	date  string // YYYY-MM-DD in Loc
	start time.Time
	end   time.Time
	free  []span
	occ   []occupant
	cands []int // indices into planner.cands, in generation order
	// blocks and focus count booked and placed blocks, for the caps.
	blocks, focus int
	// dirty means a placement changed this day, so its candidates' fragmentation is stale.
	dirty bool
	full  bool // noted once when the day reaches a cap
}

type cand struct {
	day, mode              int
	start, focusEnd, end   time.Time
	hour                   int
	history, fatigue, frag float64
	segLen                 time.Duration
	exact                  bool // fills its free gap to within the grid
	flush                  bool // fills it to the minute
	dead                   bool // overlaps a placed block, or comes too close to one
}

type job struct {
	task     Task
	key      string
	explicit bool
	wanted   int
	urgency  float64
}

type planner struct {
	in       Input
	loc      *time.Location
	earliest time.Time
	horizon  time.Time
	modes    []Mode
	minFit   time.Duration
	gap      time.Duration
	busy     []span // merged blocking events, without buffers
	days     []*day
	cands    []cand
	rates    [24]float64
	peak     [24]bool
	hasPeaks bool
	notes    []string
}

// Plan places focus blocks. It returns an error only for malformed input; a request that
// cannot be met yields a Result whose Unplaced entries say why.
func Plan(in Input) (Result, error) {
	p, err := newPlanner(in)
	if err != nil {
		return Result{}, err
	}
	return p.run(), nil
}

func newPlanner(in Input) (*planner, error) {
	if in.Loc == nil {
		return nil, errors.New("planner: no time zone")
	}
	if len(in.Modes) == 0 {
		return nil, errors.New("planner: no modes")
	}
	for _, m := range in.Modes {
		if m.FocusMin < 5 || m.RestMin < 0 || m.FocusMin+m.RestMin > 12*60 {
			return nil, fmt.Errorf("planner: mode %q has an impossible length", m.Name)
		}
	}
	pr := in.Prefs
	if pr.MaxBlocksPerDay < 1 || pr.MaxFocusMinPerDay < 1 || pr.BufferMin < 0 || pr.MinGapMin < 0 {
		return nil, errors.New("planner: caps must be positive and buffers non-negative")
	}
	ws, err1 := clock(pr.WorkdayStart)
	we, err2 := clock(pr.WorkdayEnd)
	if err := errors.Join(err1, err2); err != nil {
		return nil, err
	}
	if we <= ws {
		return nil, errors.New("planner: the workday must end after it starts")
	}
	for _, t := range []string{in.Request.AvoidBefore, in.Request.AvoidAfter} {
		if t != "" {
			if _, err := clock(t); err != nil {
				return nil, err
			}
		}
	}
	first, err := time.ParseInLocation("2006-01-02", in.Window.From, in.Loc)
	if err != nil {
		return nil, fmt.Errorf("planner: window start %q is not a YYYY-MM-DD day", in.Window.From)
	}
	last, err := time.ParseInLocation("2006-01-02", in.Window.To, in.Loc)
	if err != nil {
		return nil, fmt.Errorf("planner: window end %q is not a YYYY-MM-DD day", in.Window.To)
	}
	if last.Before(first) {
		return nil, errors.New("planner: the window ends before it starts")
	}

	p := &planner{in: in, loc: in.Loc, earliest: earliestStart(in.Now), gap: time.Duration(pr.MinGapMin) * time.Minute}
	p.horizon = p.earliest
	p.modes = p.allowedModes()
	p.minFit = p.modes[0].occupies()
	for _, m := range p.modes {
		p.minFit = min(p.minFit, m.occupies())
	}
	p.profile()
	p.mergeBusy()
	for date := first; !date.After(last); date = date.AddDate(0, 0, 1) {
		if len(p.days) == MaxDays {
			return nil, fmt.Errorf("planner: plan at most %d days at a time", MaxDays)
		}
		p.addDay(date)
	}
	p.addBooked()
	p.addCandidates()
	return p, nil
}

// clock parses "HH:MM" into minutes after midnight.
func clock(s string) (int, error) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, fmt.Errorf("planner: %q is not an HH:MM time", s)
	}
	return t.Hour()*60 + t.Minute(), nil
}

// at is the instant the clock in loc reads hh:mm on date. time.Date normalizes a wall
// time that a DST jump skips, and a day is never built by adding 24 hours.
func at(date time.Time, hhmm string, loc *time.Location) time.Time {
	m, _ := clock(hhmm) // validated in newPlanner
	y, mo, d := date.Date()
	return time.Date(y, mo, d, m/60, m%60, 0, 0, loc)
}

// allowedModes resolves the request's mode hint against the user's modes.
func (p *planner) allowedModes() []Mode {
	hint := strings.ToLower(strings.TrimSpace(p.in.Request.ModeHint))
	all := p.in.Modes
	pick := func(keep func(Mode) bool) []Mode {
		var out []Mode
		for _, m := range all {
			if keep(m) {
				out = append(out, m)
			}
		}
		return out
	}
	var modes []Mode
	switch hint {
	case "":
		modes = all[:1]
	case "deep":
		// Longest first: at a given start the longest deep rhythm that fits wins the tie.
		modes = pick(func(m Mode) bool { return m.FocusMin >= 45 })
		slices.SortStableFunc(modes, func(a, b Mode) int { return b.FocusMin - a.FocusMin })
	case "short":
		modes = pick(func(m Mode) bool { return m.FocusMin <= 30 })
	default:
		modes = pick(func(m Mode) bool { return strings.ToLower(m.Name) == hint })
	}
	if len(modes) == 0 {
		p.note("mode_hint_unmatched: %q, using %s", p.in.Request.ModeHint, all[0].Name)
		modes = all[:1]
	}
	names := make([]string, len(modes))
	for i, m := range modes {
		names[i] = fmt.Sprintf("%s %d/%d", m.Name, m.FocusMin, m.RestMin)
	}
	p.note("modes: %s", strings.Join(names, ", "))
	return modes
}

// The cold-start prior. A new user has no history, so historyFit falls back to a flat
// prior rather than zero; otherwise the first plan would be dominated by whichever term
// happened to be non-zero. Each hour blends toward the user's own completion rate as
// sessions accumulate there: w = n / (n + priorWeight), personal rate weighted by w and
// the prior by 1 - w. That is a Beta prior worth priorWeight pseudo-sessions per hour, so
// one lucky session at 6 AM can't make 6 AM the best hour of the day.
const (
	priorRate   = 0.6
	priorWeight = 20.0
	// peakMinSessions is how much history it takes before "your strongest hours" means anything.
	peakMinSessions = 10
)

func (p *planner) profile() {
	for h, s := range p.in.History.Hours {
		n := float64(s.Sessions)
		personal := 0.0
		if s.Sessions > 0 {
			personal = float64(s.Completed) / n
		}
		w := n / (n + priorWeight)
		p.rates[h] = float64(w*personal) + float64((1-w)*priorRate)
	}
	total := p.in.History.Sessions()
	if total < peakMinSessions {
		p.note("history: cold start (%d past sessions), so every hour is weighted the same", total)
		return
	}
	hours := make([]int, 0, 24)
	for h, s := range p.in.History.Hours {
		if s.Sessions > 0 {
			hours = append(hours, h)
		}
	}
	slices.SortStableFunc(hours, func(a, b int) int { return cmpRate(p.rates[b], p.rates[a]) }) // best first, earlier hour on a tie
	for _, h := range hours[:min(2, len(hours))] {
		p.peak[h] = true
	}
	p.hasPeaks = len(hours) > 0
	var peaks []string
	for h := range 24 {
		if p.peak[h] {
			peaks = append(peaks, fmt.Sprintf("%02d:00 (%.0f%%)", h, 100*p.rates[h]))
		}
	}
	p.note("history: %d past sessions; strongest hours %s", total, strings.Join(peaks, " and "))
}

// mergeBusy sorts the events that block time and merges overlaps with a standard sweep.
func (p *planner) mergeBusy() {
	var spans []span
	for _, iv := range p.in.Busy {
		if iv.blocks() && iv.End.After(iv.Start) {
			spans = append(spans, span{iv.Start, iv.End})
		}
	}
	p.busy = merge(spans)
}

func merge(spans []span) []span {
	slices.SortFunc(spans, func(a, b span) int { return cmpAll(a.start.Compare(b.start), a.end.Compare(b.end)) })
	var out []span
	for _, s := range spans {
		if n := len(out); n > 0 && !s.start.After(out[n-1].end) {
			if s.end.After(out[n-1].end) {
				out[n-1].end = s.end
			}
			continue
		}
		out = append(out, s)
	}
	return out
}

// subtract removes cut from every span in free.
func subtract(free []span, cut span) []span {
	var out []span
	for _, f := range free {
		if !cut.start.Before(f.end) || !cut.end.After(f.start) { // no overlap
			out = append(out, f)
			continue
		}
		if cut.start.After(f.start) {
			out = append(out, span{f.start, cut.start})
		}
		if cut.end.Before(f.end) {
			out = append(out, span{cut.end, f.end})
		}
	}
	return out
}

// addDay builds one day's free intervals: the workday (stretched or trimmed by the
// request), minus meetings widened by the buffer, minus lunch, minus the past.
func (p *planner) addDay(date time.Time) {
	ask, pr := p.in.Request, p.in.Prefs
	d := &day{date: date.Format("2006-01-02"), dirty: true}
	p.days = append(p.days, d)
	d.start, d.end = at(date, pr.WorkdayStart, p.loc), at(date, pr.WorkdayEnd, p.loc)
	if wd := date.Weekday(); (wd == time.Saturday || wd == time.Sunday) && !ask.AllowWeekend {
		p.note("weekend_skipped: %s", d.date)
		return
	}
	if ask.AllowEvening {
		if e := at(date, eveningEnd, p.loc); e.After(d.end) {
			d.end = e
		}
	}
	if ask.AvoidBefore != "" {
		if a := at(date, ask.AvoidBefore, p.loc); a.After(d.start) {
			d.start = a
		}
	}
	if ask.AvoidAfter != "" {
		if a := at(date, ask.AvoidAfter, p.loc); a.Before(d.end) {
			d.end = a
		}
	}
	if !d.end.After(d.start) {
		return
	}
	free := []span{{d.start, d.end}}
	buffer := time.Duration(pr.BufferMin) * time.Minute
	for _, b := range p.busy {
		// Widening every meeting by the buffer is the same as trimming the buffer off each
		// end of a free interval that touches one: a block never ends as a call starts.
		free = subtract(free, span{b.start.Add(-buffer), b.end.Add(buffer)})
	}
	if pr.ProtectLunch {
		free = subtract(free, span{at(date, lunchStart, p.loc), at(date, lunchEnd, p.loc)})
	}
	free = subtract(free, span{d.start.Add(-48 * time.Hour), p.earliest})
	for _, f := range free {
		if f.len() >= p.minFit {
			d.free = append(d.free, f)
		}
	}
	for _, iv := range p.in.Busy {
		if iv.AllDay {
			if y, m, dd := iv.Start.In(p.loc).Date(); time.Date(y, m, dd, 0, 0, 0, 0, p.loc).Equal(date) {
				p.note("all_day_event: %s (does not block time)", d.date)
			}
		}
	}
	if len(d.free) == 0 && d.end.After(p.earliest) {
		p.note("no_free_time: %s", d.date)
	}
}

// dayOf returns the day containing t, or nil if t is outside the window.
func (p *planner) dayOf(t time.Time) *day {
	local := t.In(p.loc)
	key := local.Format("2006-01-02")
	for _, d := range p.days {
		if d.date == key {
			return d
		}
	}
	return nil
}

func taskKey(id uint, title string) string {
	if id > 0 {
		return fmt.Sprintf("id:%d", id)
	}
	return "new:" + strings.ToLower(strings.TrimSpace(title))
}

// addBooked records blocks accepted in earlier plans: they occupy time and use up caps.
func (p *planner) addBooked() {
	for _, b := range p.in.Booked {
		d := p.dayOf(b.Start)
		if d == nil {
			continue
		}
		key := ""
		if b.TaskID > 0 {
			key = taskKey(b.TaskID, "")
		}
		d.occ = append(d.occ, occupant{b.Start, b.Start.Add(time.Duration(b.FocusMin+b.RestMin) * time.Minute), key})
		d.blocks++
		d.focus += b.FocusMin
	}
}

// addCandidates enumerates every start on the grid, in every free interval, for every
// allowed mode, walking forward while focus plus rest still fits. The search space is
// small (a workday has about 32 grid points, times a handful of modes, times the days in
// the window), so exhaustive enumeration followed by greedy selection is both correct and
// fast. A solver would be slower to run and harder to explain.
func (p *planner) addCandidates() {
	for di, d := range p.days {
		for _, f := range d.free {
			for mi, m := range p.modes {
				for t := ceilGrid(f.start); !t.Add(m.occupies()).After(f.end); t = t.Add(Grid) {
					c := cand{
						day: di, mode: mi, start: t, focusEnd: t.Add(time.Duration(m.FocusMin) * time.Minute),
						end: t.Add(m.occupies()), hour: t.In(p.loc).Hour(),
					}
					c.history = p.rates[c.hour]
					c.fatigue = p.fatigue(t)
					for _, o := range d.occ {
						if p.conflicts(c.start, c.end, o) {
							c.dead = true
						}
					}
					d.cands = append(d.cands, len(p.cands))
					p.cands = append(p.cands, c)
				}
			}
		}
		if len(d.free) > 0 && d.free[len(d.free)-1].end.After(p.horizon) {
			p.horizon = d.free[len(d.free)-1].end
		}
	}
}

// conflicts reports whether a block over [start, end) overlaps o or sits closer to it
// than the minimum gap. Each block's own rest is already inside its occupancy.
func (p *planner) conflicts(start, end time.Time, o occupant) bool {
	return start.Before(o.end.Add(p.gap)) && o.start.Before(end.Add(p.gap))
}

// fatigue is the meetingAdjacency penalty: starting right after a long run of meetings.
func (p *planner) fatigue(t time.Time) float64 {
	buffer := time.Duration(p.in.Prefs.BufferMin) * time.Minute
	for _, b := range p.busy {
		if b.end.After(t) || t.Sub(b.end) > buffer+Grid {
			continue
		}
		if l := b.len(); l >= time.Hour {
			return min(1, l.Minutes()/120)
		}
	}
	return 0
}

// run is step 5: greedy selection with a deterministic tiebreak.
func (p *planner) run() Result {
	var out Result
	jobs := p.jobs()
	target := p.in.Request.TotalBlocks
	for _, j := range jobs {
		placed := 0
		for placed < j.wanted {
			if target > 0 && len(out.Blocks) >= target {
				out.Unplaced = append(out.Unplaced, unplaced(j, placed, ReasonTotalReached))
				break
			}
			ci, s, why, ok := p.best(j)
			if !ok {
				out.Unplaced = append(out.Unplaced, unplaced(j, placed, p.why(j)))
				break
			}
			out.Blocks = append(out.Blocks, p.place(ci, j, s, why))
			placed++
		}
	}
	named := false
	for _, j := range jobs {
		named = named || j.explicit
	}
	if p.in.Request.Fill || (!named && target > len(out.Blocks)) {
		for target == 0 || len(out.Blocks) < target {
			ci, s, why, ok := p.best(nil)
			if !ok {
				break
			}
			out.Blocks = append(out.Blocks, p.place(ci, nil, s, why))
		}
	}
	slices.SortStableFunc(out.Blocks, func(a, b Block) int { return a.StartsAt.Compare(b.StartsAt) })
	focus := 0
	for _, b := range out.Blocks {
		focus += b.FocusMin
	}
	p.note("placed: %d blocks, %d focus minutes", len(out.Blocks), focus)
	out.Notes = p.notes
	if out.Blocks == nil {
		out.Blocks = []Block{}
	}
	if out.Unplaced == nil {
		out.Unplaced = []Unplaced{}
	}
	return out
}

func unplaced(j *job, placed int, reason string) Unplaced {
	return Unplaced{TaskID: idPtr(j.task.ID), Task: j.task.Title, Wanted: j.wanted, Placed: placed, Reason: reason}
}

func idPtr(id uint) *uint {
	if id == 0 {
		return nil
	}
	return &id
}

// jobs decides which tasks get blocks, how many each wants, and in what order.
//
// A task the user named wants Ask.BlocksPerTask blocks, or an equal share of TotalBlocks,
// or else its remaining estimate (at least one: they asked for it). An unnamed task, when
// nothing is named, wants its remaining estimate, capped by BlocksPerTask. Order is by
// urgency (earliest due date first), then priority, then task ID, so the output is stable.
func (p *planner) jobs() []*job {
	ask := p.in.Request
	named := map[uint]bool{}
	for _, id := range ask.TaskIDs {
		named[id] = true
	}
	var jobs []*job
	for _, t := range p.in.Tasks {
		j := &job{task: t, key: taskKey(t.ID, t.Title), explicit: t.ID == 0 || named[t.ID]}
		jobs = append(jobs, j)
	}
	anyNamed := slices.ContainsFunc(jobs, func(j *job) bool { return j.explicit })
	countNamed := 0
	for _, j := range jobs {
		if j.explicit {
			countNamed++
		}
	}
	var out []*job
	for _, j := range jobs {
		switch {
		case anyNamed && !j.explicit:
			continue
		case j.explicit && ask.BlocksPerTask > 0:
			j.wanted = ask.BlocksPerTask
		case j.explicit && ask.TotalBlocks > 0:
			j.wanted = (ask.TotalBlocks + countNamed - 1) / countNamed
		case j.explicit:
			j.wanted = max(1, j.task.Remaining)
		case ask.BlocksPerTask > 0:
			j.wanted = min(j.task.Remaining, ask.BlocksPerTask)
		default:
			j.wanted = j.task.Remaining
		}
		if j.wanted <= 0 {
			continue
		}
		if d := j.task.DueAt; d != nil {
			hours := d.Sub(p.earliest).Hours()
			j.urgency = math.Max(0, math.Min(1, 1-hours/(7*24))) // due now: 1; a week or more away: 0
		}
		out = append(out, j)
	}
	slices.SortStableFunc(out, func(a, b *job) int {
		return cmpAll(cmpDue(a.task.DueAt, b.task.DueAt), b.task.Priority-a.task.Priority,
			int(a.task.ID)-int(b.task.ID), strings.Compare(a.key, b.key))
	})
	return out
}

func cmpDue(a, b *time.Time) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1 // no due date sorts last
	case b == nil:
		return -1
	}
	return a.Compare(*b)
}

// best is the highest-scoring candidate that survives the hard constraints for j (nil
// for an untasked block). Never iterate a Go map here: map order would make plans flaky.
func (p *planner) best(j *job) (int, float64, terms, bool) {
	maxBlocks, maxFocus := p.in.Prefs.MaxBlocksPerDay, p.in.Prefs.MaxFocusMinPerDay
	bestIdx, bestScore, bestTerms, fits := -1, 0.0, terms{}, 0
	var first time.Time // the earliest start that survives, to say so in the explanation
	for _, d := range p.days {
		if d.blocks >= maxBlocks {
			continue
		}
		if d.dirty {
			p.refresh(d)
		}
		for _, ci := range d.cands {
			c := &p.cands[ci]
			if c.dead || d.focus+p.modes[c.mode].FocusMin > maxFocus {
				continue
			}
			if j != nil && j.task.DueAt != nil && c.focusEnd.After(*j.task.DueAt) {
				continue // a block after the deadline is no help
			}
			fits++
			if first.IsZero() || c.start.Before(first) {
				first = c.start
			}
			s, t := p.score(c, j)
			if bestIdx < 0 || p.better(s, c, bestScore, &p.cands[bestIdx]) {
				bestIdx, bestScore, bestTerms = ci, s, t
			}
		}
	}
	bestTerms.only = fits == 1
	if bestIdx >= 0 {
		bestTerms.first = p.cands[bestIdx].start.Equal(first)
	}
	return bestIdx, bestScore, bestTerms, bestIdx >= 0
}

// better orders candidates: higher score, then earlier start, then the mode listed first.
// Scores are compared after rounding to a millionth, so the order cannot hinge on the last
// bit of a float, which may differ between CPUs.
func (p *planner) better(s float64, c *cand, bs float64, b *cand) bool {
	if q, bq := quantize(s), quantize(bs); q != bq {
		return q > bq
	}
	if !c.start.Equal(b.start) {
		return c.start.Before(b.start)
	}
	return c.mode < b.mode
}

func quantize(s float64) int64 { return int64(math.Round(s * 1e6)) }

func cmpRate(a, b float64) int {
	switch qa, qb := quantize(a), quantize(b); {
	case qa < qb:
		return -1
	case qa > qb:
		return 1
	}
	return 0
}

// why names the hard constraint that left j without a slot.
func (p *planner) why(j *job) string {
	if d := j.task.DueAt; d != nil && !d.After(p.earliest) {
		return ReasonDuePassed
	}
	maxBlocks, maxFocus := p.in.Prefs.MaxBlocksPerDay, p.in.Prefs.MaxFocusMinPerDay
	capped, afterDue := false, false
	for _, d := range p.days {
		for _, ci := range d.cands {
			c := &p.cands[ci]
			if c.dead {
				continue
			}
			if d.blocks >= maxBlocks || d.focus+p.modes[c.mode].FocusMin > maxFocus {
				capped = true
			} else {
				afterDue = true // it survived everything else, so the deadline ruled it out
			}
		}
	}
	switch {
	case afterDue:
		return ReasonNoSlotBeforeDue
	case capped:
		return ReasonDayCap
	}
	return ReasonNoGap
}

// place commits candidate ci and re-filters only its own day: candidates elsewhere are
// unaffected by this block, so they keep their scores.
func (p *planner) place(ci int, j *job, score float64, why terms) Block {
	c := &p.cands[ci]
	d := p.days[c.day]
	m := p.modes[c.mode]
	key := ""
	if j != nil {
		key = j.key
	}
	o := occupant{c.start, c.end, key}
	d.occ = append(d.occ, o)
	d.blocks++
	d.focus += m.FocusMin
	d.dirty = true
	for _, other := range d.cands {
		if oc := &p.cands[other]; !oc.dead && p.conflicts(oc.start, oc.end, o) {
			oc.dead = true
		}
	}
	if !d.full && (d.blocks >= p.in.Prefs.MaxBlocksPerDay || d.focus >= p.in.Prefs.MaxFocusMinPerDay) {
		d.full = true
		p.note("day_full: %s (%d blocks, %d focus minutes)", d.date, d.blocks, d.focus)
	}
	b := Block{StartsAt: c.start, FocusMin: m.FocusMin, RestMin: m.RestMin, Mode: m.Name,
		Score: math.Round(score*1000) / 1000, Explain: p.explain(c, j, why)}
	if j != nil {
		b.TaskID, b.Task = idPtr(j.task.ID), j.task.Title
	}
	return b
}

// refresh recomputes the fragmentation of a day's live candidates against the day's free
// gaps as they stand now, that is, the free intervals minus every placed block and its gap.
//
// Fragmentation is measured as lost capacity: how many blocks of the shortest allowed
// rhythm the gap could hold before this placement, minus the one being placed, minus how
// many its two leftover pieces can still hold. A leftover piece too short for any rhythm
// is stranded time, and it costs something only when it eats room another block could
// have used. Penalising every short remainder instead would steer a block away from a
// gap that could never hold two anyway.
func (p *planner) refresh(d *day) {
	segs := slices.Clone(d.free)
	for _, o := range d.occ {
		segs = subtract(segs, span{o.start.Add(-p.gap), o.end.Add(p.gap)})
	}
	for _, ci := range d.cands {
		c := &p.cands[ci]
		if c.dead {
			continue
		}
		c.frag, c.exact, c.flush, c.segLen = 0, false, false, 0
		for _, s := range segs {
			if s.start.After(c.start) || s.end.Before(c.end) {
				continue
			}
			before := p.capacity(s.start, s.end)
			after := p.capacity(s.start, c.start.Add(-p.gap)) + p.capacity(c.end.Add(p.gap), s.end)
			c.frag = min(1, float64(max(0, before-1-after)))
			c.exact = c.start.Sub(s.start) < Grid && s.end.Sub(c.end) < Grid
			c.flush = c.start.Equal(s.start) && c.end.Equal(s.end)
			c.segLen = s.len()
			break
		}
	}
	d.dirty = false
}

// capacity is how many blocks of the shortest allowed rhythm fit in [start, end) on the
// grid, with the minimum gap between them.
func (p *planner) capacity(start, end time.Time) int {
	first := ceilGrid(start)
	if end.Sub(first) < p.minFit {
		return 0
	}
	step := ceilGrid(time.Time{}.Add(p.minFit + p.gap)).Sub(time.Time{}) // the next start, on the grid
	return 1 + int(end.Sub(first.Add(p.minFit))/step)
}

func (p *planner) note(format string, args ...any) {
	p.notes = append(p.notes, fmt.Sprintf(format, args...))
}
