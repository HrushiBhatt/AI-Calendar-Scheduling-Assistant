// Package assistant turns plain-language planning requests into scheduler calls.
//
// The model does two jobs only: translate a request into a plan_focus_blocks call, and
// narrate the plan that comes back. It never picks a time. Everything the frontend draws
// comes from the plan rows; the model's prose is a separate, labelled field, and it is
// dropped if it names a time that no tool result contained.
package assistant

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const (
	// DefaultModel is small and fast: this is structured extraction, not open-ended reasoning.
	DefaultModel = "claude-haiku-5-5"
	// DefaultDailyTokens is each user's daily budget, input and output together.
	DefaultDailyTokens = 50_000
	// MaxRounds caps the tool rounds in one request; one more call writes the narration,
	// so a request makes at most MaxRounds+1 model calls.
	MaxRounds = 3
	// MaxInput is how much of the user's text reaches the model.
	MaxInput = 500
	// maxNarration bounds what is kept of the narration, which should be two sentences.
	maxNarration = 600
)

// Client is the one SDK method the assistant uses. &anthropic.Client.Messages satisfies
// it; tests use a fake that returns canned tool calls.
type Client interface {
	New(ctx context.Context, body anthropic.MessageNewParams, opts ...option.RequestOption) (*anthropic.Message, error)
}

// Options configure an Assistant.
type Options struct {
	Model       string
	Effort      string // output_config.effort; "" means low, "default" sends none
	DailyTokens int
}

// Assistant answers planning requests.
type Assistant struct {
	llm    Client
	db     *gorm.DB
	plans  *plans.Service
	model  string
	effort anthropic.OutputConfigEffort
	budget int
	now    func() time.Time
}

func New(llm Client, db *gorm.DB, planSvc *plans.Service, opts Options) *Assistant {
	a := &Assistant{llm: llm, db: db, plans: planSvc, model: opts.Model, budget: opts.DailyTokens, now: planSvc.Now}
	if a.model == "" {
		a.model = DefaultModel
	}
	if a.budget <= 0 {
		a.budget = DefaultDailyTokens
	}
	switch opts.Effort {
	case "":
		a.effort = anthropic.OutputConfigEffortLow
	case "default":
	default:
		a.effort = anthropic.OutputConfigEffort(opts.Effort)
	}
	return a
}

// Model is the model ID requests use.
func (a *Assistant) Model() string { return a.model }

// Result is what one request produced.
type Result struct {
	Plan      *plans.View
	Narration string
	Degraded  bool   // the model was unavailable or refused, so the plan uses the form's defaults
	Notice    string // why, for the user
	Failure   string // what went wrong with the model's part, for the eval set
	Usage     Usage
	Cached    bool
}

// Usage is the tokens a request spent.
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

var (
	// ErrBudget means the user spent their daily token budget.
	ErrBudget = errors.New("you've used today's planning assistant budget; the form still works")
	// ErrDisabled means the user turned the assistant off.
	ErrDisabled = errors.New("the planning assistant is off in your settings; use the form")
)

// turn is the state of one request.
type turn struct {
	a        *Assistant
	user     store.User
	loc      *time.Location
	now      time.Time
	modes    []planner.Mode
	text     string
	planView *plans.View
	allowed  map[int]bool // minutes of the day the narration may mention
	calls    []store.ToolCall
}

// allow records clock times the model has been shown, which it may repeat.
func (t *turn) allow(times ...time.Time) {
	for _, tm := range times {
		l := tm.In(t.loc)
		t.allowed[l.Hour()*60+l.Minute()] = true
	}
}

// allowText records every clock time written in a tool result.
func (t *turn) allowText(s string) {
	for _, m := range mentions(s) {
		if len(m.minutes) == 1 {
			t.allowed[m.minutes[0]] = true
		} else {
			for _, minute := range m.minutes[:1] { // "15:04" output is unambiguous 24-hour time
				t.allowed[minute] = true
			}
		}
	}
}

// Handle answers one request: the model parses it, the scheduler plans it, the model
// narrates the plan. A provider error or a refusal degrades to the form's defaults
// rather than failing: an assistant that returns nothing when an API is slow is worse
// than one that returns a reasonable default.
func (a *Assistant) Handle(ctx context.Context, userID uint, text string) (*Result, error) {
	text = truncateRunes(strings.TrimSpace(text), MaxInput)
	var user store.User
	if err := a.db.First(&user, userID).Error; err != nil {
		return nil, err
	}
	if !user.Settings.AssistantEnabled {
		return nil, ErrDisabled
	}
	loc, err := user.Settings.Location()
	if err != nil {
		return nil, err
	}
	now := a.now()
	if spent, err := a.spentToday(userID, loc, now); err != nil {
		return nil, err
	} else if spent >= a.budget {
		return nil, ErrBudget
	}
	modes, err := plans.Modes(a.db, userID, now)
	if err != nil {
		return nil, err
	}
	key, err := a.requestHash(user, loc, now, text)
	if err != nil {
		return nil, err
	}
	if view, err := a.cached(userID, key, now); err != nil || view != nil {
		if view == nil {
			return nil, err
		}
		return &Result{Plan: view, Narration: view.Rationale, Cached: true}, nil
	}

	var openTasks int64
	a.db.Model(&store.Task{}).Where("user_id = ? AND done = ?", userID, false).Count(&openTasks)
	system, err := systemPrompt(user, loc, now, modes, int(openTasks))
	if err != nil {
		return nil, err
	}
	t := &turn{a: a, user: user, loc: loc, now: now, modes: modes, text: text, allowed: map[int]bool{}}
	for _, hhmm := range []string{user.Settings.WorkdayStart, user.Settings.WorkdayEnd} {
		t.allowText(hhmm) // the prompt states the workday, so the model may too
	}

	started := time.Now()
	res, narration, failure := a.converse(ctx, t, system)
	res.Failure = failure
	if t.planView == nil && (strings.HasPrefix(failure, "provider") || failure == "refusal" || failure == "timeout") {
		if err := a.degrade(ctx, t, res, failure); err != nil {
			return nil, err
		}
	}
	if t.planView != nil {
		res.Plan = t.planView
		if bad := inventedTime(narration, t.allowed); bad != "" {
			// The model named a time no tool result contained. Its prose is not shown.
			res.Failure = "narration_invented_time: " + bad
			narration = ""
		}
		if !res.Degraded {
			res.Narration = narration
			if err := a.plans.SetNarration(t.planView.ID, narration); err != nil {
				return nil, err
			}
			res.Plan.Rationale = narration
			if err := a.db.Model(&store.Plan{}).Where("id = ?", t.planView.ID).Update("request_hash", key).Error; err != nil {
				return nil, err
			}
		}
	} else if res.Failure == "" {
		// The model chose not to plan (the request wasn't about planning). Its reply may
		// stand, as long as it names no time.
		res.Failure = "no_plan"
		if inventedTime(narration, t.allowed) == "" {
			res.Narration = narration
		}
	}
	a.record(t, res, time.Since(started))
	return res, nil
}

// converse runs the tool loop. It returns the result so far, the model's final text and
// a failure label ("" when the model did its part).
func (a *Assistant) converse(ctx context.Context, t *turn, system string) (*Result, string, string) {
	res := &Result{}
	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(a.model),
		MaxTokens: 4096,
		System:    []anthropic.TextBlockParam{{Text: system}},
		Tools:     tools,
		Messages:  []anthropic.MessageParam{anthropic.NewUserMessage(anthropic.NewTextBlock(t.text))},
	}
	if a.effort != "" {
		params.OutputConfig = anthropic.OutputConfigParam{Effort: a.effort}
	}
	for round := 0; ; round++ {
		msg, err := a.llm.New(ctx, params)
		if err != nil {
			return res, "", providerFailure(ctx, err)
		}
		res.Usage.InputTokens += int(msg.Usage.InputTokens)
		res.Usage.OutputTokens += int(msg.Usage.OutputTokens)
		if msg.StopReason == anthropic.StopReasonRefusal {
			return res, "", "refusal"
		}
		params.Messages = append(params.Messages, msg.ToParam())

		var text []string
		var results []anthropic.ContentBlockParamUnion
		wantsTools := false
		for _, block := range msg.Content {
			_, isTool := block.AsAny().(anthropic.ToolUseBlock)
			wantsTools = wantsTools || isTool
		}
		if wantsTools && round >= MaxRounds {
			// Three tool rounds and still not done. If a plan exists the user gets it,
			// just without narration.
			return res, "", "too_many_tool_rounds"
		}
		for _, block := range msg.Content {
			switch b := block.AsAny().(type) {
			case anthropic.TextBlock:
				text = append(text, b.Text)
			case anthropic.ToolUseBlock:
				call := store.ToolCall{Name: b.Name, Input: json.RawMessage(b.JSON.Input.Raw())}
				if len(call.Input) == 0 {
					call.Input = b.Input
				}
				out, err := t.run(ctx, b.Name, call.Input)
				var toolErr errTool
				switch {
				case errors.As(err, &toolErr):
					call.Error = toolErr.msg
					results = append(results, anthropic.NewToolResultBlock(b.ID, toolErr.msg, true))
				case err != nil:
					log.Printf("assistant: %s for user %d: %v", b.Name, t.user.ID, err)
					call.Error = "internal error"
					results = append(results, anthropic.NewToolResultBlock(b.ID, "the tool failed on the server; try once more or give up", true))
				default:
					t.allowText(out)
					results = append(results, anthropic.NewToolResultBlock(b.ID, out, false))
				}
				t.calls = append(t.calls, call)
			}
		}
		if len(results) == 0 {
			return res, strings.TrimSpace(strings.Join(text, " ")), "" // done: this is the narration
		}
		params.Messages = append(params.Messages, anthropic.NewUserMessage(results...))
	}
}

// degrade proposes the form's default plan when the model couldn't take part.
func (a *Assistant) degrade(ctx context.Context, t *turn, res *Result, failure string) error {
	args := plans.DefaultArgs(t.user.Settings, t.now, t.loc)
	view, err := a.plans.Propose(ctx, t.user.ID, plans.Proposal{Args: args, Source: store.SourceForm, Text: t.text})
	if err != nil {
		return err
	}
	t.planView = view
	res.Degraded = true
	res.Notice = "The assistant didn't answer, so this plan uses the form's defaults."
	if failure == "refusal" {
		res.Notice = "The assistant declined that request, so this plan uses the form's defaults."
	}
	return nil
}

// providerFailure labels a failed API call. The SDK already retried it once.
func providerFailure(ctx context.Context, err error) string {
	var apiErr *anthropic.Error
	switch {
	case errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil:
		return "timeout"
	case errors.As(err, &apiErr):
		return fmt.Sprintf("provider_error: %d", apiErr.StatusCode)
	}
	return "provider_error: " + truncateRunes(err.Error(), 80)
}

// record stores the turn for spend accounting and the eval set.
func (a *Assistant) record(t *turn, res *Result, latency time.Duration) {
	turn := store.AssistantTurn{
		UserID: t.user.ID, UserText: t.text, ToolCalls: t.calls, Narration: truncateRunes(res.Narration, maxNarration),
		Model: a.model, PromptVersion: PromptVersion, InputTokens: res.Usage.InputTokens, OutputTokens: res.Usage.OutputTokens,
		LatencyMs: int(latency.Milliseconds()), Degraded: res.Degraded, Failure: truncateRunes(res.Failure, 120), CreatedAt: a.now().UTC(),
	}
	if res.Plan != nil {
		turn.PlanID = &res.Plan.ID
	}
	if err := a.db.Create(&turn).Error; err != nil {
		log.Printf("assistant: recording a turn: %v", err)
	}
}

// spentToday sums the user's tokens since their local midnight.
func (a *Assistant) spentToday(userID uint, loc *time.Location, now time.Time) (int, error) {
	l := now.In(loc)
	midnight := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, loc)
	var spent struct{ N int }
	err := a.db.Model(&store.AssistantTurn{}).Where("user_id = ? AND created_at >= ?", userID, midnight).
		Select("COALESCE(SUM(input_tokens + output_tokens), 0) AS n").Scan(&spent).Error
	return spent.N, err
}

// requestHash covers the user's words and everything the model could look up: settings,
// open tasks, the next two weeks of calendar and planned blocks, the history, the time
// slot and the prompt version. An identical request against an unchanged world reuses the
// stored plan instead of calling the model, which is also what keeps a demo fast.
func (a *Assistant) requestHash(user store.User, loc *time.Location, now time.Time, text string) (string, error) {
	until := now.AddDate(0, 0, 15)
	var tasks []store.Task
	var events []store.CalendarEvent
	var blocks []store.ScheduledSession
	if err := errors.Join(
		a.db.Where("user_id = ? AND done = ?", user.ID, false).Order("id").Find(&tasks).Error,
		a.db.Where("user_id = ? AND ends_at > ? AND starts_at < ?", user.ID, now, until).Order("id").Find(&events).Error,
		a.db.Where("user_id = ? AND status IN ? AND starts_at < ?", user.ID, []string{store.BlockAccepted, store.BlockStarted}, until).Order("id").Find(&blocks).Error,
	); err != nil {
		return "", err
	}
	profile, err := plans.Profile(a.db, user.ID, loc, now)
	if err != nil {
		return "", err
	}
	for i := range events {
		events[i].UpdatedAt = time.Time{}
	}
	for i := range blocks {
		blocks[i].CreatedAt = time.Time{}
	}
	in := planner.Input{Now: now, Loc: loc}
	b, err := json.Marshal(struct {
		Version, Model, Text, Slot string
		Settings                   store.Settings
		Tasks                      []store.Task
		Events                     []store.CalendarEvent
		Blocks                     []store.ScheduledSession
		Profile                    planner.Profile
	}{PromptVersion, a.model, strings.ToLower(text), in.Canonical().Now.Format(time.RFC3339), user.Settings, tasks, events, blocks, profile})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:]), nil
}

func (a *Assistant) cached(userID uint, key string, now time.Time) (*plans.View, error) {
	var plan store.Plan
	err := a.db.Where("user_id = ? AND request_hash = ? AND status = ? AND created_at > ?", userID, key, store.PlanProposed, now.Add(-plans.CacheFor)).
		Order("id DESC").Limit(1).Find(&plan).Error
	if err != nil || plan.ID == 0 {
		return nil, err
	}
	return a.plans.Get(userID, plan.ID)
}
