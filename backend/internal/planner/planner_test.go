package planner

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden.json from the current planner")

func loadInput(t *testing.T, path string) Input {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return in
}

// TestGolden runs every testdata/*.input.json fixture and compares the plan with its
// .golden.json byte for byte. `go test ./internal/planner -update` rewrites the goldens;
// review the diff before committing it. Each fixture also has a semantic check below, so
// a golden file can't quietly enshrine a wrong answer.
func TestGolden(t *testing.T) {
	inputs, _ := filepath.Glob("testdata/*.input.json")
	if len(inputs) == 0 {
		t.Fatal("no fixtures")
	}
	seen := map[string]bool{}
	for _, path := range inputs {
		name := strings.TrimSuffix(filepath.Base(path), ".input.json")
		seen[name] = true
		t.Run(name, func(t *testing.T) {
			in := loadInput(t, path)
			got, err := Plan(in)
			if err != nil {
				t.Fatal(err)
			}
			gotJSON, _ := json.MarshalIndent(got, "", "  ")
			gotJSON = append(gotJSON, '\n')
			golden := strings.TrimSuffix(path, ".input.json") + ".golden.json"
			if *update {
				if err := os.WriteFile(golden, gotJSON, 0o644); err != nil {
					t.Fatal(err)
				}
			} else {
				want, err := os.ReadFile(golden)
				if err != nil {
					t.Fatalf("no golden file (run with -update): %v", err)
				}
				if !bytes.Equal(want, gotJSON) {
					t.Errorf("plan differs from %s:\n%s", golden, lineDiff(string(want), string(gotJSON)))
				}
			}
			checkInvariants(t, in, got)
			check, ok := checks[name]
			if !ok {
				t.Fatalf("fixture %s has no semantic check", name)
			}
			check(t, in, got)
		})
	}
	for name := range checks {
		if !seen[name] {
			t.Errorf("check %s has no fixture", name)
		}
	}
}

// ---- what each scenario pins -----------------------------------------------------

func local(in Input, b Block) time.Time { return b.StartsAt.In(in.Loc) }

func hhmm(in Input, t time.Time) string { return t.In(in.Loc).Format("15:04") }

func reasonsOf(r Result) map[string]string {
	out := map[string]string{}
	for _, u := range r.Unplaced {
		out[u.Task] = u.Reason
	}
	return out
}

var checks = map[string]func(*testing.T, Input, Result){
	"empty-day": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != in.Prefs.MaxBlocksPerDay {
			t.Errorf("%d blocks, want the cap of %d", len(r.Blocks), in.Prefs.MaxBlocksPerDay)
		}
		if reasonsOf(r)["Compiler project"] != ReasonDayCap {
			t.Errorf("unplaced = %+v, want the rest reported as day_cap_reached", r.Unplaced)
		}
	},
	"back-to-back-meetings": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 0 {
			t.Errorf("placed %d blocks in 15-minute gaps", len(r.Blocks))
		}
		if reasonsOf(r)["Compiler project"] != ReasonNoGap {
			t.Errorf("unplaced = %+v", r.Unplaced)
		}
	},
	"one-exact-gap": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 1 || hhmm(in, r.Blocks[0].StartsAt) != "14:00" || r.Blocks[0].FocusMin != 50 {
			t.Fatalf("blocks = %+v, want one 50-minute block at 14:00", r.Blocks)
		}
		if !strings.Contains(r.Blocks[0].Explain, "only open slot") {
			t.Errorf("explain = %q", r.Blocks[0].Explain)
		}
		if u := r.Unplaced; len(u) != 1 || u[0].Wanted != 3 || u[0].Placed != 1 {
			t.Errorf("unplaced = %+v", u)
		}
	},
	"dst-spring-forward": func(t *testing.T, in Input, r Result) {
		first := map[string]time.Time{}
		for _, b := range r.Blocks {
			d := local(in, b).Format("2006-01-02")
			if f, ok := first[d]; !ok || b.StartsAt.Before(f) {
				first[d] = b.StartsAt
			}
		}
		for _, d := range []string{"2026-03-07", "2026-03-08", "2026-03-09"} {
			if f, ok := first[d]; !ok || hhmm(in, f) != "09:00" {
				t.Errorf("%s: first block at %v, want 09:00 local", d, f.In(in.Loc))
			}
		}
		if want := time.Date(2026, 3, 8, 13, 0, 0, 0, time.UTC); !first["2026-03-08"].Equal(want) {
			t.Errorf("09:00 on the spring-forward day is %v, want 13:00 UTC (EDT)", first["2026-03-08"].UTC())
		}
	},
	"overnight-meeting": func(t *testing.T, in Input, r Result) {
		mon, tue := 0, 0
		for _, b := range r.Blocks {
			end := b.StartsAt.Add(time.Duration(b.FocusMin+b.RestMin) * time.Minute)
			switch local(in, b).Format("2006-01-02") {
			case "2026-10-26":
				mon++
				if end.After(time.Date(2026, 10, 26, 19, 50, 0, 0, in.Loc)) {
					t.Errorf("Monday block runs into the flight: %v", local(in, b))
				}
			case "2026-10-27":
				tue++
				if local(in, b).Before(time.Date(2026, 10, 27, 10, 40, 0, 0, in.Loc)) {
					t.Errorf("Tuesday block during the flight: %v", local(in, b))
				}
			}
		}
		if mon != 4 || tue != 4 {
			t.Errorf("blocks on Monday %d, Tuesday %d, want 4 and 4: the flight clips both days, it doesn't erase them", mon, tue)
		}
	},
	"due-tomorrow-vs-next-week": func(t *testing.T, in Input, r Result) {
		var lab, grant []time.Time
		for _, b := range r.Blocks {
			switch b.Task {
			case "Lab report":
				lab = append(lab, b.StartsAt)
			case "Grant proposal":
				grant = append(grant, b.StartsAt)
			}
		}
		if len(lab) != 2 || len(grant) != 2 {
			t.Fatalf("lab %v grant %v", lab, grant)
		}
		if slices.MaxFunc(lab, time.Time.Compare).After(slices.MinFunc(grant, time.Time.Compare)) {
			t.Errorf("the task due tomorrow didn't get the earlier slots: lab %v, grant %v", lab, grant)
		}
	},
	"cold-start-no-history": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 3 {
			t.Errorf("%d blocks, want 3", len(r.Blocks))
		}
		if !slices.ContainsFunc(r.Notes, func(n string) bool { return strings.Contains(n, "cold start") }) {
			t.Errorf("notes = %v", r.Notes)
		}
		for _, b := range r.Blocks {
			if b.Score < wHistory*priorRate-wFragmentation {
				t.Errorf("score %.3f: the history term collapsed toward zero", b.Score)
			}
		}
	},
	"all-unplaced": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 0 {
			t.Fatalf("blocks = %+v", r.Blocks)
		}
		want := map[string]string{"Quarterly report": ReasonDuePassed, "Expense report": ReasonNoGap, "Read the RFC": ReasonNoGap}
		if got := reasonsOf(r); !reflect.DeepEqual(got, want) {
			t.Errorf("reasons = %v, want %v", got, want)
		}
	},
	"declined-meeting": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) == 0 || local(in, r.Blocks[0]).Hour() >= 12 {
			t.Errorf("blocks = %+v, want the declined morning used", r.Blocks)
		}
	},
	"our-own-blocks": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) == 0 || hhmm(in, r.Blocks[0].StartsAt) != "09:00" {
			t.Errorf("blocks = %+v, want 09:00: our own blocks aren't meetings", r.Blocks)
		}
	},
	"due-before-free-slot": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 0 || reasonsOf(r)["Expense report"] != ReasonNoSlotBeforeDue {
			t.Errorf("blocks %+v unplaced %+v", r.Blocks, r.Unplaced)
		}
	},
	"total-blocks": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 3 {
			t.Errorf("%d blocks, want the requested 3", len(r.Blocks))
		}
		if !slices.ContainsFunc(r.Unplaced, func(u Unplaced) bool { return u.Reason == ReasonTotalReached }) {
			t.Errorf("unplaced = %+v", r.Unplaced)
		}
	},
	"history-peaks": func(t *testing.T, in Input, r Result) {
		for _, b := range r.Blocks {
			h := local(in, b).Hour()
			peak := h == 9 || h == 10
			if b.Task == "Register allocator" && !peak {
				t.Errorf("deep work at %d:00, outside the 9 and 10 o'clock peaks", h)
			}
			if b.Task == "Inbox" && peak {
				t.Errorf("light work took a peak hour (%d:00)", h)
			}
		}
		if len(r.Blocks) != 3 {
			t.Errorf("%d blocks, want 3", len(r.Blocks))
		}
	},
	"fill-free-time": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != in.Prefs.MaxBlocksPerDay {
			t.Errorf("%d blocks, want the day filled to the cap", len(r.Blocks))
		}
		for _, b := range r.Blocks {
			if b.TaskID != nil || b.Task != "" {
				t.Errorf("a fill block has a task: %+v", b)
			}
		}
	},
	"contiguity": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 2 {
			t.Fatalf("blocks = %+v", r.Blocks)
		}
		end := r.Blocks[0].StartsAt.Add(time.Duration(r.Blocks[0].FocusMin+r.Blocks[0].RestMin) * time.Minute)
		if !r.Blocks[1].StartsAt.Equal(end) {
			t.Errorf("second block at %s, want it right after the first (%s)", hhmm(in, r.Blocks[1].StartsAt), hhmm(in, end))
		}
		if !strings.Contains(r.Blocks[1].Explain, "next to your other block") {
			t.Errorf("explain = %q", r.Blocks[1].Explain)
		}
	},
	"booked-blocks": func(t *testing.T, in Input, r Result) {
		if len(r.Blocks) != 1 {
			t.Errorf("%d blocks, want 1: two of the cap of three are already booked", len(r.Blocks))
		}
	},
	"avoid-before-after": func(t *testing.T, in Input, r Result) {
		for _, b := range r.Blocks {
			start := local(in, b)
			end := start.Add(time.Duration(b.FocusMin+b.RestMin) * time.Minute)
			if start.Hour() < 10 || end.After(time.Date(start.Year(), start.Month(), start.Day(), 15, 0, 0, 0, in.Loc)) {
				t.Errorf("block %s–%s outside 10:00–15:00", hhmm(in, start), hhmm(in, end))
			}
		}
		if len(r.Blocks) == 0 {
			t.Error("no blocks")
		}
	},
}

// ---- invariants every plan must satisfy --------------------------------------------

func checkInvariants(t *testing.T, in Input, r Result) {
	t.Helper()
	earliest := earliestStart(in.Now)
	gap := time.Duration(in.Prefs.MinGapMin) * time.Minute
	buffer := time.Duration(in.Prefs.BufferMin) * time.Minute
	type occ struct {
		start, end time.Time
		focus      int
		placed     bool
	}
	var all []occ
	for _, b := range in.Booked {
		all = append(all, occ{b.Start, b.Start.Add(time.Duration(b.FocusMin+b.RestMin) * time.Minute), b.FocusMin, false})
	}
	for _, b := range r.Blocks {
		end := b.StartsAt.Add(time.Duration(b.FocusMin+b.RestMin) * time.Minute)
		if b.StartsAt.Before(earliest) {
			t.Errorf("block at %v starts before now plus the lead (%v)", b.StartsAt, earliest)
		}
		if !b.StartsAt.Equal(ceilGrid(b.StartsAt)) {
			t.Errorf("block at %v is off the 15-minute grid", b.StartsAt)
		}
		for _, iv := range in.Busy {
			if iv.blocks() && b.StartsAt.Before(iv.End.Add(buffer)) && iv.Start.Add(-buffer).Before(end) {
				t.Errorf("block %v–%v overlaps a meeting %v–%v (with buffer)", b.StartsAt, end, iv.Start, iv.End)
			}
		}
		local := b.StartsAt.In(in.Loc)
		if wd := local.Weekday(); (wd == time.Saturday || wd == time.Sunday) && !in.Request.AllowWeekend {
			t.Errorf("block on a weekend without asking: %v", local)
		}
		ws := at(local, in.Prefs.WorkdayStart, in.Loc)
		we := at(local, in.Prefs.WorkdayEnd, in.Loc)
		if in.Request.AllowEvening {
			we = at(local, eveningEnd, in.Loc)
		}
		if b.StartsAt.Before(ws) || end.After(we) {
			t.Errorf("block %v–%v outside the day %v–%v", b.StartsAt, end, ws, we)
		}
		if in.Prefs.ProtectLunch {
			ls, le := at(local, lunchStart, in.Loc), at(local, lunchEnd, in.Loc)
			if b.StartsAt.Before(le) && ls.Before(end) {
				t.Errorf("block %v overlaps lunch", local)
			}
		}
		if b.Explain == "" {
			t.Errorf("block %v has no explanation", local)
		}
		all = append(all, occ{b.StartsAt, end, b.FocusMin, true})
	}
	type tally struct{ blocks, focus, placed int }
	perDay := map[string]tally{}
	for i, a := range all {
		for _, b := range all[i+1:] {
			if (a.placed || b.placed) && a.start.Before(b.end.Add(gap)) && b.start.Before(a.end.Add(gap)) {
				t.Errorf("blocks %v and %v overlap or sit closer than the gap", a.start, b.start)
			}
		}
		d := a.start.In(in.Loc).Format("2006-01-02")
		c := perDay[d]
		c.blocks, c.focus = c.blocks+1, c.focus+a.focus
		if a.placed {
			c.placed++
		}
		perDay[d] = c
	}
	for d, c := range perDay {
		// Earlier bookings may already exceed a cap; the planner just must not add to such a day.
		if c.placed > 0 && (c.blocks > in.Prefs.MaxBlocksPerDay || c.focus > in.Prefs.MaxFocusMinPerDay) {
			t.Errorf("%s: %d blocks and %d focus minutes break the caps", d, c.blocks, c.focus)
		}
	}
	// Determinism: the same input, twice and in canonical form, gives the same plan.
	again, _ := Plan(in)
	canon, _ := Plan(in.Canonical())
	if !reflect.DeepEqual(norm(r), norm(again)) || !reflect.DeepEqual(norm(r), norm(canon)) {
		t.Error("the plan is not deterministic")
	}
}

// norm makes plans comparable across inputs whose times carry different locations.
func norm(r Result) string {
	for i := range r.Blocks {
		r.Blocks[i].StartsAt = r.Blocks[i].StartsAt.UTC()
	}
	b, _ := json.Marshal(r)
	return string(b)
}

// ---- properties, over random calendars ------------------------------------------------

// TestProperties generates random weeks and checks the invariants above on each plan:
// no overlaps, nothing in a meeting, nothing before now, caps held, and the same plan
// for the same input, including after shuffling every list in it. Seeds are fixed, so a
// failure names one that reproduces it.
func TestProperties(t *testing.T) {
	zones := []string{"America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Lord_Howe", "UTC"}
	for seed := range uint64(400) {
		rng := rand.New(rand.NewPCG(seed, 99))
		loc, _ := time.LoadLocation(zones[rng.IntN(len(zones))])
		in := randomInput(rng, loc)
		r, err := Plan(in)
		if err != nil {
			t.Fatalf("seed %d: %v", seed, err)
		}
		ok := t.Run(fmt.Sprintf("seed-%d", seed), func(t *testing.T) {
			checkInvariants(t, in, r)
			shuffled := in
			shuffled.Busy = slices.Clone(in.Busy)
			shuffled.Tasks = slices.Clone(in.Tasks)
			shuffled.Booked = slices.Clone(in.Booked)
			rng.Shuffle(len(shuffled.Busy), func(i, j int) { shuffled.Busy[i], shuffled.Busy[j] = shuffled.Busy[j], shuffled.Busy[i] })
			rng.Shuffle(len(shuffled.Tasks), func(i, j int) { shuffled.Tasks[i], shuffled.Tasks[j] = shuffled.Tasks[j], shuffled.Tasks[i] })
			rng.Shuffle(len(shuffled.Booked), func(i, j int) { shuffled.Booked[i], shuffled.Booked[j] = shuffled.Booked[j], shuffled.Booked[i] })
			r2, _ := Plan(shuffled)
			if norm(r) != norm(r2) {
				t.Error("shuffling the input changed the plan")
			}
			if in.Hash() != shuffled.Hash() {
				t.Error("shuffling the input changed its hash")
			}
		})
		if !ok {
			raw, _ := json.MarshalIndent(in, "", "  ")
			t.Logf("seed %d input:\n%s", seed, raw)
			return
		}
	}
}

func randomInput(rng *rand.Rand, loc *time.Location) Input {
	start := time.Date(2026, time.Month(1+rng.IntN(12)), 1+rng.IntN(27), 0, 0, 0, 0, loc)
	days := 1 + rng.IntN(5)
	now := start.Add(time.Duration(rng.IntN(36*60)-12*60) * time.Minute)
	clockAt := func(m int) string { return fmt.Sprintf("%02d:%02d", m/60, m%60) }
	ws := 7*60 + 15*rng.IntN(12)
	we := ws + 4*60 + 15*rng.IntN(24)
	in := Input{
		Now:    now,
		Loc:    loc,
		Window: Window{From: start.Format("2006-01-02"), To: start.AddDate(0, 0, days-1).Format("2006-01-02")},
		Prefs: Prefs{
			WorkdayStart: clockAt(ws), WorkdayEnd: clockAt(min(we, 23*60+45)),
			BufferMin: []int{0, 5, 10, 15}[rng.IntN(4)], MinGapMin: []int{0, 0, 10, 15}[rng.IntN(4)],
			MaxBlocksPerDay: 1 + rng.IntN(6), MaxFocusMinPerDay: 60 + 30*rng.IntN(10), ProtectLunch: rng.IntN(2) == 0,
		},
		Modes: []Mode{{"Pomodoro", 25, 5}, {"Animedoro", 50, 10}, {"Deep Work", 90, 20}, {"52/17", 52, 17}},
		Request: Ask{
			ModeHint:     []string{"", "", "deep", "short", "Animedoro", "nonsense"}[rng.IntN(6)],
			AllowEvening: rng.IntN(4) == 0, AllowWeekend: rng.IntN(4) == 0,
			TotalBlocks: []int{0, 0, 2, 5}[rng.IntN(4)], Fill: rng.IntN(5) == 0,
		},
	}
	for d := range days {
		for range rng.IntN(7) {
			s := start.AddDate(0, 0, d).Add(time.Duration(6*60+5*rng.IntN(170)) * time.Minute)
			in.Busy = append(in.Busy, Interval{Start: s, End: s.Add(time.Duration(5+5*rng.IntN(40)) * time.Minute),
				Free: rng.IntN(8) == 0, Ours: rng.IntN(10) == 0, AllDay: rng.IntN(20) == 0})
		}
		if rng.IntN(3) == 0 {
			s := start.AddDate(0, 0, d).Add(time.Duration(8*60+15*rng.IntN(40)) * time.Minute)
			in.Booked = append(in.Booked, Booked{Start: s, FocusMin: 25, RestMin: 5, TaskID: uint(1 + rng.IntN(3))})
		}
	}
	if rng.IntN(5) == 0 { // an overnight meeting
		s := start.Add(time.Duration(20*60) * time.Minute)
		in.Busy = append(in.Busy, Interval{Start: s, End: s.Add(14 * time.Hour)})
	}
	for i := range rng.IntN(5) {
		task := Task{ID: uint(i + 1), Title: fmt.Sprintf("task %d", i+1), Remaining: rng.IntN(5),
			Priority: rng.IntN(4), Energy: []string{"", "deep", "light"}[rng.IntN(3)]}
		if rng.IntN(2) == 0 {
			due := start.Add(time.Duration(rng.IntN(days*24*60)) * time.Minute)
			task.DueAt = &due
		}
		in.Tasks = append(in.Tasks, task)
	}
	if rng.IntN(3) == 0 && len(in.Tasks) > 0 {
		in.Request.TaskIDs = []uint{in.Tasks[0].ID}
		in.Request.BlocksPerTask = rng.IntN(4)
	}
	for h := range 24 {
		if n := rng.IntN(6); n > 0 {
			in.History.Hours[h] = HourStat{Sessions: n, Completed: rng.IntN(n + 1)}
		}
	}
	return in
}

// ---- edges ------------------------------------------------------------------------------

func TestMalformedInputIsAnError(t *testing.T) {
	good := loadInput(t, "testdata/empty-day.input.json")
	for name, mutate := range map[string]func(*Input){
		"no zone":        func(in *Input) { in.Loc = nil },
		"no modes":       func(in *Input) { in.Modes = nil },
		"bad workday":    func(in *Input) { in.Prefs.WorkdayStart = "9am" },
		"inverted day":   func(in *Input) { in.Prefs.WorkdayStart, in.Prefs.WorkdayEnd = "17:00", "09:00" },
		"inverted range": func(in *Input) { in.Window.To = "2026-10-01" },
		"too many days":  func(in *Input) { in.Window.To = "2026-12-31" },
		"zero cap":       func(in *Input) { in.Prefs.MaxBlocksPerDay = 0 },
		"bad avoid":      func(in *Input) { in.Request.AvoidBefore = "noon" },
		"tiny mode":      func(in *Input) { in.Modes = []Mode{{"Blink", 1, 0}} },
	} {
		in := good
		mutate(&in)
		if _, err := Plan(in); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestCanonicalNowSharesTheGridSlot(t *testing.T) {
	in := loadInput(t, "testdata/empty-day.input.json")
	a, b := in, in
	a.Now = time.Date(2026, 10, 25, 20, 1, 0, 0, in.Loc)
	b.Now = time.Date(2026, 10, 25, 20, 9, 0, 0, in.Loc) // both round to a 20:15 earliest start
	if a.Hash() != b.Hash() {
		t.Error("requests in the same grid slot hash differently")
	}
	b.Now = time.Date(2026, 10, 25, 20, 11, 0, 0, in.Loc) // rounds to 20:30
	if a.Hash() == b.Hash() {
		t.Error("requests in different grid slots hash the same")
	}
	if c := a.Canonical(); earliestStart(c.Now) != earliestStart(c.Canonical().Now) {
		t.Error("Canonical is not idempotent")
	}
}

func TestInputJSONRoundTrip(t *testing.T) {
	in := loadInput(t, "testdata/history-peaks.input.json")
	raw, _ := json.Marshal(in)
	var back Input
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Loc.String() != "America/New_York" || in.Hash() != back.Hash() {
		t.Errorf("round trip changed the input: %s vs %s", in.Hash(), back.Hash())
	}
}

// BenchmarkPlan is the latency claim: a week of a busy calendar, five tasks, all modes.
func BenchmarkPlan(b *testing.B) {
	rng := rand.New(rand.NewPCG(1, 2))
	loc, _ := time.LoadLocation("America/New_York")
	in := randomInput(rng, loc)
	in.Window.To = mustDay(in.Window.From).AddDate(0, 0, 6).Format("2006-01-02")
	in.Request = Ask{ModeHint: "deep", Fill: true}
	for b.Loop() {
		if _, err := Plan(in); err != nil {
			b.Fatal(err)
		}
	}
}

func mustDay(s string) time.Time {
	t, _ := time.Parse("2006-01-02", s)
	return t
}

// lineDiff shows the first differing lines, enough to see what moved.
func lineDiff(want, got string) string {
	w, g := strings.Split(want, "\n"), strings.Split(got, "\n")
	var out []string
	for i := 0; i < max(len(w), len(g)) && len(out) < 20; i++ {
		var a, b string
		if i < len(w) {
			a = w[i]
		}
		if i < len(g) {
			b = g[i]
		}
		if a != b {
			out = append(out, fmt.Sprintf("line %d\n  want: %s\n  got:  %s", i+1, a, b))
		}
	}
	return strings.Join(out, "\n")
}
