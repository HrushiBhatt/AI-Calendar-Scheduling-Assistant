package assistant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// Tool names.
const (
	toolPlan     = "plan_focus_blocks"
	toolTasks    = "list_tasks"
	toolSchedule = "get_schedule"
	toolProfile  = "get_focus_profile"
)

// titleLimit is how much of a meeting title the model sees, when the user shares titles.
const titleLimit = 60

func tool(name, description string, properties map[string]any, required ...string) anthropic.ToolUnionParam {
	return anthropic.ToolUnionParam{OfTool: &anthropic.ToolParam{
		Name:        name,
		Description: anthropic.String(description),
		InputSchema: anthropic.ToolInputSchemaParam{Properties: properties, Required: required},
	}}
}

// tools is the model's whole contract. plan_focus_blocks is the only one with side
// effects, and all it can do is ask; the scheduler decides everything else.
var tools = []anthropic.ToolUnionParam{
	tool(toolPlan, "Ask the scheduler for focus blocks. Its arguments are the structured form of the user's request; the scheduler picks every time, around the user's calendar, and returns the plan.",
		map[string]any{
			"window":          map[string]any{"type": "string", "enum": plans.Windows},
			"start_date":      map[string]any{"type": "string", "description": "YYYY-MM-DD, required when window is custom"},
			"end_date":        map[string]any{"type": "string", "description": "YYYY-MM-DD, last day of a custom window (inclusive)"},
			"task_ids":        map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "description": "IDs from list_tasks"},
			"new_tasks":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "titles the user named that do not exist yet"},
			"total_blocks":    map[string]any{"type": "integer", "minimum": 1, "maximum": plans.MaxTotalBlocks},
			"blocks_per_task": map[string]any{"type": "integer", "minimum": 1, "maximum": plans.MaxTotalBlocks},
			"mode_hint":       map[string]any{"type": "string", "description": "a rhythm's name, or 'deep' or 'short'"},
			"allow_evening":   map[string]any{"type": "boolean"},
			"allow_weekend":   map[string]any{"type": "boolean"},
			"avoid_before":    map[string]any{"type": "string", "description": "HH:MM in the user's zone"},
			"avoid_after":     map[string]any{"type": "string", "description": "HH:MM in the user's zone"},
		}, "window"),
	tool(toolTasks, "List the user's open tasks with IDs, blocks left on each estimate, due dates, priority and energy.", map[string]any{}),
	tool(toolSchedule, "Read the user's busy times and already-planned focus blocks between two days (YYYY-MM-DD, inclusive; default the next 7 days).",
		map[string]any{
			"start": map[string]any{"type": "string", "description": "YYYY-MM-DD"},
			"end":   map[string]any{"type": "string", "description": "YYYY-MM-DD"},
		}),
	tool(toolProfile, "Read how often the user finishes focus blocks by hour of day, and their strongest hours.", map[string]any{}),
}

// errTool is a tool failure the model can read and recover from.
type errTool struct{ msg string }

func (e errTool) Error() string { return e.msg }

// run executes one tool call and returns what the model sees.
func (t *turn) run(ctx context.Context, name string, input json.RawMessage) (string, error) {
	switch name {
	case toolPlan:
		return t.plan(ctx, input)
	case toolTasks:
		return t.listTasks()
	case toolSchedule:
		return t.schedule(input)
	case toolProfile:
		return t.profile()
	}
	return "", errTool{fmt.Sprintf("there is no tool called %q", name)}
}

func (t *turn) plan(ctx context.Context, input json.RawMessage) (string, error) {
	var args plans.Args
	dec := json.NewDecoder(bytes.NewReader(input))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&args); err != nil {
		return "", errTool{"the arguments don't match the schema: " + err.Error()}
	}
	args.Fill = false // the quick action's flag, not the model's
	prep, err := t.a.plans.Prepare(t.user.ID, &args, nil)
	var argErr *plans.ArgError
	if errors.As(err, &argErr) {
		return "", errTool{fmt.Sprintf("invalid arguments: %s %s. Fix them and call %s again.", argErr.Field, argErr.Msg, toolPlan)}
	}
	if err != nil {
		return "", err
	}
	view, err := t.a.plans.Propose(ctx, t.user.ID, plans.Proposal{Args: args, Source: store.SourceAssistant, Text: t.text, Prepared: prep})
	if err != nil {
		return "", err
	}
	t.planView = view

	type block struct {
		Day   string `json:"day"`
		Start string `json:"start"`
		End   string `json:"end"`
		Task  string `json:"task"`
		Mode  string `json:"mode"`
		Why   string `json:"why"`
	}
	type unplaced struct {
		Task   string `json:"task"`
		Wanted int    `json:"wanted"`
		Placed int    `json:"placed"`
		Reason string `json:"reason"`
	}
	out := struct {
		PlanID   uint       `json:"plan_id"`
		Blocks   []block    `json:"blocks"`
		Unplaced []unplaced `json:"unplaced"`
		Notes    []string   `json:"notes"`
	}{PlanID: view.ID, Blocks: []block{}, Unplaced: []unplaced{}, Notes: view.Notes}
	for _, b := range view.Blocks {
		start := b.StartsAt.In(t.loc)
		task := b.Intention
		if task == "" {
			task = "(untasked focus time)"
		}
		out.Blocks = append(out.Blocks, block{Day: start.Format("Mon 2 Jan"), Start: start.Format("15:04"),
			End: start.Add(time.Duration(b.FocusMin) * time.Minute).Format("15:04"), Task: task,
			Mode: fmt.Sprintf("%s %d/%d", b.Mode, b.FocusMin, b.RestMin), Why: b.Explain})
		t.allow(start, start.Add(time.Duration(b.FocusMin)*time.Minute), b.EndsAt())
	}
	for _, u := range view.Unplaced {
		out.Unplaced = append(out.Unplaced, unplaced{Task: u.Task, Wanted: u.Wanted, Placed: u.Placed, Reason: u.Reason})
	}
	return marshal(out)
}

func (t *turn) listTasks() (string, error) {
	in, err := plans.BuildInput(t.a.db, t.user, t.loc, plans.Args{Window: "today"}, t.now, t.modes, nil)
	if err != nil {
		return "", err
	}
	type task struct {
		ID         uint   `json:"id"`
		Title      string `json:"title"`
		BlocksLeft int    `json:"blocks_left"`
		Due        string `json:"due,omitempty"`
		Priority   int    `json:"priority,omitempty"`
		Energy     string `json:"energy,omitempty"`
	}
	out := struct {
		Tasks []task `json:"tasks"`
	}{Tasks: []task{}}
	for _, it := range in.Tasks {
		if len(out.Tasks) == 50 {
			break
		}
		tk := task{ID: it.ID, Title: it.Title, BlocksLeft: it.Remaining, Priority: it.Priority, Energy: it.Energy}
		if it.DueAt != nil {
			tk.Due = it.DueAt.In(t.loc).Format("2006-01-02")
		}
		out.Tasks = append(out.Tasks, tk)
	}
	return marshal(out)
}

func (t *turn) schedule(input json.RawMessage) (string, error) {
	var args struct{ Start, End string }
	if len(bytes.TrimSpace(input)) > 0 {
		if err := json.Unmarshal(input, &args); err != nil {
			return "", errTool{"start and end must be YYYY-MM-DD strings"}
		}
	}
	local := t.now.In(t.loc)
	from := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, t.loc)
	to := from.AddDate(0, 0, 7)
	var err error
	if args.Start != "" {
		if from, err = time.ParseInLocation("2006-01-02", args.Start, t.loc); err != nil {
			return "", errTool{"start must be YYYY-MM-DD"}
		}
		to = from.AddDate(0, 0, 7)
	}
	if args.End != "" {
		end, err := time.ParseInLocation("2006-01-02", args.End, t.loc)
		if err != nil {
			return "", errTool{"end must be YYYY-MM-DD"}
		}
		to = end.AddDate(0, 0, 1)
	}
	if !to.After(from) || to.Sub(from) > 15*24*time.Hour {
		return "", errTool{"ask for between 1 and 14 days"}
	}
	var events []store.CalendarEvent
	if err := t.a.db.Where("user_id = ? AND starts_at < ? AND ends_at > ? AND busy = ? AND owned_by_us = ?", t.user.ID, to, from, true, false).
		Order("starts_at, id").Find(&events).Error; err != nil {
		return "", err
	}
	var blocks []store.ScheduledSession
	if err := t.a.db.Where("user_id = ? AND status IN ? AND starts_at < ? AND starts_at >= ?", t.user.ID,
		[]string{store.BlockAccepted, store.BlockStarted}, to, from).Order("starts_at").Find(&blocks).Error; err != nil {
		return "", err
	}
	type item struct {
		Start string `json:"start"`
		End   string `json:"end,omitempty"`
		What  string `json:"what"`
	}
	type day struct {
		Day   string `json:"day"`
		Items []item `json:"items"`
	}
	var days []day
	add := func(when time.Time, it item) {
		key := when.In(t.loc).Format("Mon 2006-01-02")
		if len(days) == 0 || days[len(days)-1].Day != key {
			days = append(days, day{Day: key, Items: []item{}})
		}
		days[len(days)-1].Items = append(days[len(days)-1].Items, it)
	}
	type entry struct {
		at time.Time
		it item
	}
	var all []entry
	for _, e := range events {
		title := "Busy"
		if t.user.Settings.ShareEventTitles && strings.TrimSpace(e.Title) != "" {
			title = truncateRunes(e.Title, titleLimit)
		}
		if e.AllDay {
			all = append(all, entry{e.StartsAt, item{Start: "all day", What: title + " (doesn't block time)"}})
			continue
		}
		s, en := e.StartsAt.In(t.loc), e.EndsAt.In(t.loc)
		all = append(all, entry{e.StartsAt, item{Start: s.Format("15:04"), End: en.Format("15:04"), What: title}})
		t.allow(s, en)
	}
	for _, b := range blocks {
		s := b.StartsAt.In(t.loc)
		e := s.Add(time.Duration(b.FocusMin) * time.Minute)
		all = append(all, entry{b.StartsAt, item{Start: s.Format("15:04"), End: e.Format("15:04"), What: "focus block already planned"}})
		t.allow(s, e)
	}
	slices.SortStableFunc(all, func(a, b entry) int { return a.at.Compare(b.at) })
	for _, e := range all {
		add(e.at, e.it)
	}
	if days == nil {
		days = []day{}
	}
	return marshal(struct {
		Zone string `json:"zone"`
		Days []day  `json:"days"`
	}{t.loc.String(), days})
}

func (t *turn) profile() (string, error) {
	p, err := plans.Profile(t.a.db, t.user.ID, t.loc, t.now)
	if err != nil {
		return "", err
	}
	type hour struct {
		Hour           string  `json:"hour"`
		Sessions       int     `json:"sessions"`
		CompletionRate float64 `json:"completion_rate"`
	}
	out := struct {
		Sessions int    `json:"finished_sessions"`
		ByHour   []hour `json:"by_hour"`
		Note     string `json:"note,omitempty"`
	}{Sessions: p.Sessions(), ByHour: []hour{}}
	for h, s := range p.Hours {
		if s.Sessions > 0 {
			out.ByHour = append(out.ByHour, hour{fmt.Sprintf("%02d:00", h), s.Sessions, float64(int(100*float64(s.Completed)/float64(s.Sessions))) / 100})
		}
	}
	if out.Sessions < 10 {
		out.Note = "too little history to say which hours are strongest"
	}
	return marshal(out)
}

func marshal(v any) (string, error) {
	b, err := json.Marshal(v)
	return string(b), err
}

func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}
