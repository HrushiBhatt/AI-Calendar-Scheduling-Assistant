//go:build evals

// The eval set: about 30 requests with the plan_focus_blocks arguments they should
// produce, run against the real model. It costs money, so it sits behind a build tag
// and CI never runs it:
//
//	ANTHROPIC_API_KEY=... go test -tags evals -run TestEvals -count=1 -v ./internal/assistant
//
// -eval.stub runs it against the phrase-matching Stub instead, which checks the harness
// and costs nothing; those numbers say nothing about a model.
package assistant

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

var (
	evalStub  = flag.Bool("eval.stub", false, "run against the Stub (checks the harness, not a model)")
	evalModel = flag.String("eval.model", DefaultModel, "model to evaluate")
	evalOut   = flag.String("eval.out", "testdata/eval-results.md", "where to write the results table")
)

type evalExpect struct {
	Plan            *bool    `json:"plan"`
	Window          string   `json:"window"`
	WindowAny       []string `json:"window_any"`
	StartDate       string   `json:"start_date"`
	EndDate         string   `json:"end_date"`
	Tasks           []string `json:"tasks"`
	NewTaskContains string   `json:"new_task_contains"`
	Blocks          int      `json:"blocks"`
	BlocksPerTask   int      `json:"blocks_per_task"`
	MaxBlocks       int      `json:"max_blocks"`
	ModeHint        string   `json:"mode_hint"`
	AllowEvening    *bool    `json:"allow_evening"`
	AllowWeekend    *bool    `json:"allow_weekend"`
	AvoidBefore     string   `json:"avoid_before"`
	AvoidAfter      string   `json:"avoid_after"`
	NoTaskIDs       []uint   `json:"no_task_ids"`
	Adversarial     bool     `json:"adversarial"`
	Inject          string   `json:"inject"` // a calendar title to plant, shared with the model
}

type evalRow struct {
	ID     string     `json:"id"`
	Text   string     `json:"text"`
	Expect evalExpect `json:"expect"`
}

// evalWorld is the same user, tasks and week of meetings for every row.
func evalWorld(t *testing.T, client Client, inject string) (*Assistant, store.User, map[string]uint) {
	db, err := store.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	hub := events.NewHub()
	go hub.Run(t.Context())
	planSvc := plans.New(db, hub)
	planSvc.Now = func() time.Time { return time.Date(2026, 10, 26, 8, 0, 0, 0, ny) } // a Monday
	settings := store.DefaultSettings
	settings.TimeZone = "America/New_York"
	settings.ShareEventTitles = inject != ""
	user := store.User{Email: "eval@example.com", PasswordHash: []byte("x"), Settings: settings}
	db.Create(&user)
	due := func(d int) *time.Time { t := time.Date(2026, 10, 26+d, 17, 0, 0, 0, ny).UTC(); return &t }
	tasks := []store.Task{
		{UserID: user.ID, Title: "Compiler project", Estimate: 4, Priority: 2, Energy: store.EnergyDeep, DueAt: due(2)},
		{UserID: user.ID, Title: "Write the design doc", Estimate: 2, Priority: 1, Energy: store.EnergyDeep, DueAt: due(4)},
		{UserID: user.ID, Title: "Review pull requests", Estimate: 2, Energy: store.EnergyLight},
		{UserID: user.ID, Title: "Inbox zero", Estimate: 1, Energy: store.EnergyLight},
		{UserID: user.ID, Title: "Thesis chapter 3", Estimate: 6, Priority: 1},
	}
	db.Create(&tasks)
	ids := map[string]uint{}
	for _, tk := range tasks {
		ids[tk.Title] = tk.ID
	}
	acct := store.CalendarAccount{UserID: user.ID, Provider: "demo", ExternalID: "eval", AccessToken: []byte{}, RefreshToken: []byte{}}
	db.Create(&acct)
	for d := 0; d < 12; d++ {
		day := time.Date(2026, 10, 26+d, 0, 0, 0, 0, ny)
		if day.Weekday() == time.Saturday || day.Weekday() == time.Sunday {
			continue
		}
		at := func(h, m int) time.Time { return time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, ny).UTC() }
		db.Create(&store.CalendarEvent{UserID: user.ID, AccountID: acct.ID, ExternalID: fmt.Sprintf("standup-%d", d), Title: "Standup",
			StartsAt: at(9, 30), EndsAt: at(9, 45), Busy: true})
		db.Create(&store.CalendarEvent{UserID: user.ID, AccountID: acct.ID, ExternalID: fmt.Sprintf("review-%d", d), Title: "Design review",
			StartsAt: at(14, 0), EndsAt: at(15, 0), Busy: true})
	}
	if inject != "" {
		db.Create(&store.CalendarEvent{UserID: user.ID, AccountID: acct.ID, ExternalID: "planted", Title: inject,
			StartsAt: time.Date(2026, 10, 26, 16, 0, 0, 0, ny).UTC(), EndsAt: time.Date(2026, 10, 26, 16, 30, 0, 0, ny).UTC(), Busy: true})
	}
	return New(client, db, planSvc, Options{Model: *evalModel, DailyTokens: 10_000_000}), user, ids
}

type outcome struct {
	row                         evalRow
	planned                     bool
	args                        *plans.Args
	invalid, planCalls          int
	windowOK, windowChecked     bool
	recall                      float64
	recallChecked               bool
	fieldsPassed, fieldsChecked int
	planOK, planChecked         bool
	passed                      bool
	failures                    []string
	tokensIn, tokensOut         int
	latency                     time.Duration
	failure                     string
}

func TestEvals(t *testing.T) {
	var client Client = Stub{}
	label := "stub (harness check only, not a model)"
	if !*evalStub {
		key := os.Getenv("ANTHROPIC_API_KEY")
		if key == "" {
			t.Skip("set ANTHROPIC_API_KEY, or pass -eval.stub to check the harness")
		}
		c := anthropic.NewClient(option.WithAPIKey(key), option.WithMaxRetries(2), option.WithRequestTimeout(60*time.Second))
		client = &c.Messages
		label = *evalModel
	}
	f, err := os.Open("testdata/evals.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var rows []evalRow
	for sc := bufio.NewScanner(f); sc.Scan(); {
		var r evalRow
		if err := json.Unmarshal(sc.Bytes(), &r); err != nil {
			t.Fatal(err)
		}
		rows = append(rows, r)
	}

	var results []outcome
	for _, row := range rows {
		a, user, ids := evalWorld(t, client, row.Expect.Inject)
		started := time.Now()
		res, err := a.Handle(t.Context(), user.ID, row.Text)
		o := outcome{row: row, latency: time.Since(started)}
		if err != nil {
			o.failures = append(o.failures, "error: "+err.Error())
			results = append(results, o)
			continue
		}
		o.planned = res.Plan != nil && !res.Degraded
		o.tokensIn, o.tokensOut, o.failure = res.Usage.InputTokens, res.Usage.OutputTokens, res.Failure
		var turn store.AssistantTurn
		a.db.Order("id DESC").First(&turn)
		for _, call := range turn.ToolCalls {
			if call.Name != toolPlan {
				continue
			}
			o.planCalls++
			if call.Error != "" {
				o.invalid++
				continue
			}
			var args plans.Args
			if json.Unmarshal(call.Input, &args) == nil {
				o.args = &args // the last accepted call is the one that planned
			}
		}
		score(&o, ids)
		results = append(results, o)
		status := "pass"
		if !o.passed {
			status = "FAIL " + strings.Join(o.failures, "; ")
		}
		t.Logf("%-28s %s", row.ID, status)
	}
	table := report(label, results)
	fmt.Println(table)
	if err := os.WriteFile(*evalOut, []byte(table), 0o644); err != nil {
		t.Fatal(err)
	}
}

// score checks one outcome against its expectations.
func score(o *outcome, ids map[string]uint) {
	e := o.row.Expect
	fail := func(format string, a ...any) { o.failures = append(o.failures, fmt.Sprintf(format, a...)) }
	wantPlan := e.Plan == nil || *e.Plan
	if e.Plan != nil || e.Adversarial {
		o.planChecked = true
	}
	o.planOK = o.planned == wantPlan || (e.Plan == nil && e.Adversarial) // an adversarial row may refuse
	if !o.planOK {
		fail("planned=%v, want %v", o.planned, wantPlan)
	}
	args := o.args
	if args == nil {
		args = &plans.Args{}
	}
	if e.Window != "" || len(e.WindowAny) > 0 {
		o.windowChecked = true
		ok := args.Window == e.Window || slices.Contains(e.WindowAny, args.Window)
		if ok && e.StartDate != "" {
			ok = args.StartDate == e.StartDate
		}
		if ok && e.EndDate != "" {
			ok = args.EndDate == e.EndDate
		}
		o.windowOK = ok
		if !ok {
			fail("window %q %s..%s", args.Window, args.StartDate, args.EndDate)
		}
	}
	if len(e.Tasks) > 0 {
		o.recallChecked = true
		hit := 0
		for _, title := range e.Tasks {
			if slices.Contains(args.TaskIDs, ids[title]) {
				hit++
			}
		}
		o.recall = float64(hit) / float64(len(e.Tasks))
		if hit < len(e.Tasks) {
			fail("task_ids %v missed some of %v", args.TaskIDs, e.Tasks)
		}
	}
	check := func(name string, ok bool) {
		o.fieldsChecked++
		if ok {
			o.fieldsPassed++
		} else {
			fail("%s wrong", name)
		}
	}
	if e.NewTaskContains != "" {
		check("new_tasks", slices.ContainsFunc(args.NewTasks, func(s string) bool { return strings.Contains(strings.ToLower(s), e.NewTaskContains) }))
	}
	if e.Blocks > 0 {
		total := args.TotalBlocks
		if total == 0 && args.BlocksPerTask > 0 {
			total = args.BlocksPerTask * max(1, len(args.TaskIDs)+len(args.NewTasks))
		}
		check("block count", total == e.Blocks)
	}
	if e.BlocksPerTask > 0 {
		check("blocks_per_task", args.BlocksPerTask == e.BlocksPerTask)
	}
	if e.MaxBlocks > 0 {
		check("block cap", args.TotalBlocks <= e.MaxBlocks)
	}
	if e.ModeHint != "" {
		check("mode_hint", strings.EqualFold(args.ModeHint, e.ModeHint))
	}
	if e.AllowEvening != nil {
		check("allow_evening", args.AllowEvening == *e.AllowEvening)
	}
	if e.AllowWeekend != nil {
		check("allow_weekend", args.AllowWeekend == *e.AllowWeekend)
	}
	if e.AvoidBefore != "" {
		check("avoid_before", args.AvoidBefore == e.AvoidBefore)
	}
	if e.AvoidAfter != "" {
		check("avoid_after", args.AvoidAfter == e.AvoidAfter)
	}
	for _, id := range e.NoTaskIDs {
		check("no foreign task", !slices.Contains(args.TaskIDs, id))
	}
	o.passed = len(o.failures) == 0
}

func report(label string, rs []outcome) string {
	var windowN, windowOK, recallN, planN, planOK, fieldsN, fieldsOK, invalid, calls, passed, adv, advPassed, tokIn, tokOut int
	var recall float64
	var latencies []time.Duration
	for _, o := range rs {
		if o.windowChecked {
			windowN++
			if o.windowOK {
				windowOK++
			}
		}
		if o.recallChecked {
			recallN++
			recall += o.recall
		}
		if o.planChecked {
			planN++
			if o.planOK {
				planOK++
			}
		}
		fieldsN += o.fieldsChecked
		fieldsOK += o.fieldsPassed
		invalid += o.invalid
		calls += o.planCalls
		if o.passed {
			passed++
		}
		if o.row.Expect.Adversarial {
			adv++
			if o.passed {
				advPassed++
			}
		}
		tokIn += o.tokensIn
		tokOut += o.tokensOut
		latencies = append(latencies, o.latency)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	pct := func(a, b int) string {
		if b == 0 {
			return "n/a"
		}
		return fmt.Sprintf("%.0f%% (%d/%d)", 100*float64(a)/float64(b), a, b)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Model: %s · prompt %s · %d prompts · %s\n\n", label, PromptVersion, len(rs), time.Now().Format("2006-01-02"))
	b.WriteString("| Metric | Result |\n| --- | --- |\n")
	fmt.Fprintf(&b, "| `window` exact match | %s |\n", pct(windowOK, windowN))
	if recallN > 0 {
		fmt.Fprintf(&b, "| `task_ids` recall | %.0f%% over %d prompts |\n", 100*recall/float64(recallN), recallN)
	}
	fmt.Fprintf(&b, "| Other arguments (mode, counts, limits) | %s |\n", pct(fieldsOK, fieldsN))
	fmt.Fprintf(&b, "| Plan / no-plan decision | %s |\n", pct(planOK, planN))
	fmt.Fprintf(&b, "| Invalid `plan_focus_blocks` arguments | %d of %d calls |\n", invalid, calls)
	fmt.Fprintf(&b, "| Adversarial prompts handled | %s |\n", pct(advPassed, adv))
	fmt.Fprintf(&b, "| Prompts fully correct | %s |\n", pct(passed, len(rs)))
	if len(rs) > 0 {
		fmt.Fprintf(&b, "| Tokens per request (mean in / out) | %d / %d |\n", tokIn/len(rs), tokOut/len(rs))
		fmt.Fprintf(&b, "| Latency p50 / max | %v / %v |\n", latencies[len(latencies)/2].Round(10*time.Millisecond), latencies[len(latencies)-1].Round(10*time.Millisecond))
	}
	b.WriteString("\n| Prompt | Result |\n| --- | --- |\n")
	for _, o := range rs {
		status := "pass"
		if !o.passed {
			status = strings.Join(o.failures, "; ")
		}
		fmt.Fprintf(&b, "| %s | %s |\n", o.row.ID, status)
	}
	return b.String()
}
