package api

import (
	"testing"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

var ny, _ = time.LoadLocation("America/New_York")

// mondayMorning is a fixed "now" for planning tests: Monday 2026-10-26, 07:30 in New York.
var mondayMorning = time.Date(2026, 10, 26, 7, 30, 0, 0, ny)

// planner sets up a user in New York with a task and a meeting, and pins the clock.
func (e *env) plannerUser(t *testing.T, email string) (*client, store.Task) {
	t.Helper()
	e.plans.Now = func() time.Time { return mondayMorning }
	c := e.signup(t, email)
	settings := store.DefaultSettings
	settings.TimeZone = "America/New_York"
	if code := c.call("PUT", "/api/me/settings", settings, nil); code != 200 {
		t.Fatalf("settings: %d", code)
	}
	var task store.Task
	c.call("POST", "/api/tasks", obj{"title": "Compiler project", "estimate": 4, "energy": "deep"}, &task)
	acct := store.CalendarAccount{UserID: c.id, Provider: "fake", ExternalID: email, AccessToken: []byte("a"), RefreshToken: []byte("r")}
	e.db.Create(&acct)
	e.db.Create(&store.CalendarEvent{UserID: c.id, AccountID: acct.ID, ExternalID: "standup", Title: "Standup",
		StartsAt: time.Date(2026, 10, 26, 9, 30, 0, 0, ny).UTC(), EndsAt: time.Date(2026, 10, 26, 10, 30, 0, 0, ny).UTC(), Busy: true})
	return c, task
}

type planReply struct {
	Plan      plans.View
	Narration string
	Degraded  bool
	Notice    string
}

func TestFormPathPlansAroundMeetings(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	stream, stop := e.hub.Subscribe(ada.id)
	defer stop()

	var res planReply
	code := ada.call("POST", "/api/assistant/plan", obj{"ask": obj{"window": "today", "task_ids": []uint{task.ID}, "blocks_per_task": 3, "mode_hint": "Animedoro"}}, &res)
	if code != 200 || res.Plan.Status != store.PlanProposed || res.Plan.Source != store.SourceForm || res.Degraded {
		t.Fatalf("%d %+v", code, res)
	}
	if len(res.Plan.Blocks) != 3 {
		t.Fatalf("blocks = %+v", res.Plan.Blocks)
	}
	meetingStart, meetingEnd := time.Date(2026, 10, 26, 9, 20, 0, 0, ny), time.Date(2026, 10, 26, 10, 40, 0, 0, ny) // with buffers
	for _, b := range res.Plan.Blocks {
		if b.Status != store.BlockProposed || b.TaskID == nil || *b.TaskID != task.ID || b.Explain == "" || b.Intention != "Compiler project" {
			t.Errorf("block = %+v", b)
		}
		if b.StartsAt.Before(meetingEnd) && meetingStart.Before(b.EndsAt()) {
			t.Errorf("block at %v overlaps the standup", b.StartsAt.In(ny))
		}
	}
	if e := <-stream; e.Type != "plan.proposed" {
		t.Errorf("event %q, want plan.proposed", e.Type)
	}

	var again planReply
	ada.call("GET", "/api/plans/"+itoa(res.Plan.ID), nil, &again.Plan)
	if again.Plan.ID != res.Plan.ID || len(again.Plan.Blocks) != 3 {
		t.Errorf("GET plan = %+v", again.Plan)
	}
	if code := e.signup(t, "bob@example.com").call("GET", "/api/plans/"+itoa(res.Plan.ID), nil, nil); code != 404 {
		t.Errorf("another user read the plan: %d", code)
	}
}

func TestIdenticalRequestsReuseThePlanAndNewOnesSupersedeIt(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	ask := obj{"ask": obj{"window": "today", "task_ids": []uint{task.ID}}}
	var first, second, third planReply
	ada.call("POST", "/api/assistant/plan", ask, &first)
	ada.call("POST", "/api/assistant/plan", ask, &second)
	if first.Plan.ID == 0 || second.Plan.ID != first.Plan.ID {
		t.Fatalf("identical input made a new plan: %d then %d", first.Plan.ID, second.Plan.ID)
	}
	ada.call("POST", "/api/assistant/plan", obj{"ask": obj{"window": "tomorrow", "task_ids": []uint{task.ID}}}, &third)
	if third.Plan.ID == first.Plan.ID {
		t.Fatal("a different request reused the plan")
	}
	var old plans.View
	ada.call("GET", "/api/plans/"+itoa(first.Plan.ID), nil, &old)
	if old.Status != store.PlanSuperseded || old.Blocks[0].Status != store.BlockRejected {
		t.Errorf("the replaced plan is %q with blocks %q", old.Status, old.Blocks[0].Status)
	}
	var live []plans.View
	ada.call("GET", "/api/plans/live", nil, &live)
	if len(live) != 1 || live[0].ID != third.Plan.ID {
		t.Errorf("live = %+v", live)
	}
}

func TestPlanRequestValidation(t *testing.T) {
	e := setup(t, "")
	ada, _ := e.plannerUser(t, "ada@example.com")
	_, bobsTask := e.plannerUser(t, "bob@example.com")
	for name, c := range map[string]struct {
		ask   obj
		field string
	}{
		"unknown window":         {obj{"window": "someday"}, "window"},
		"custom without a start": {obj{"window": "custom"}, "start_date"},
		"a date in the past":     {obj{"window": "custom", "start_date": "2026-10-01", "end_date": "2026-10-02"}, "end_date"},
		"a month long":           {obj{"window": "custom", "start_date": "2026-10-27", "end_date": "2026-11-27"}, "end_date"},
		"400 blocks":             {obj{"window": "today", "total_blocks": 400}, "total_blocks"},
		"someone else's task":    {obj{"window": "today", "task_ids": []uint{bobsTask.ID}}, "task_ids"},
		"a made-up mode":         {obj{"window": "today", "mode_hint": "hyperfocus"}, "mode_hint"},
		"a bad time":             {obj{"window": "today", "avoid_before": "after lunch"}, "avoid_before"},
		"an inverted range":      {obj{"window": "today", "avoid_before": "15:00", "avoid_after": "10:00"}, "avoid_after"},
	} {
		var res obj
		if code := ada.call("POST", "/api/assistant/plan", obj{"ask": c.ask}, &res); code != 400 || res["field"] != c.field {
			t.Errorf("%s: %d %v, want 400 on %s", name, code, res, c.field)
		}
	}
	if code := ada.call("POST", "/api/assistant/plan", obj{}, nil); code != 400 {
		t.Errorf("empty request: %d", code)
	}
}

func TestNewTasksAreProposedButNotCreated(t *testing.T) {
	e := setup(t, "")
	ada, _ := e.plannerUser(t, "ada@example.com")
	var res planReply
	ada.call("POST", "/api/assistant/plan", obj{"ask": obj{"window": "today", "new_tasks": []string{"Read the RFC"}, "blocks_per_task": 2}}, &res)
	if len(res.Plan.Blocks) != 2 || !res.Plan.Blocks[0].NewTask || res.Plan.Blocks[0].TaskID != nil || res.Plan.Blocks[0].Intention != "Read the RFC" {
		t.Fatalf("blocks = %+v", res.Plan.Blocks)
	}
	var n int64
	e.db.Model(&store.Task{}).Where("user_id = ? AND title = ?", ada.id, "Read the RFC").Count(&n)
	if n != 0 {
		t.Error("a proposal created a task")
	}
}

func TestQuickFillAndDegradedText(t *testing.T) {
	e := setup(t, "")
	ada, _ := e.plannerUser(t, "ada@example.com")
	// "Fill my free time" uses open tasks first, then untasked blocks, up to the day cap.
	var quick planReply
	if code := ada.call("POST", "/api/assistant/plan", obj{"quick": "fill_today"}, &quick); code != 200 || quick.Plan.Source != store.SourceQuick {
		t.Fatalf("quick: %d %+v", code, quick)
	}
	if len(quick.Plan.Blocks) != store.DefaultSettings.MaxBlocksPerDay {
		t.Errorf("%d blocks, want the day filled to the cap", len(quick.Plan.Blocks))
	}
	var text planReply
	if code := ada.call("POST", "/api/assistant/plan", obj{"text": "plan my deep work for today"}, &text); code != 200 || !text.Degraded || text.Notice == "" || len(text.Plan.Blocks) == 0 {
		t.Fatalf("text without an assistant: %d %+v", code, text)
	}
	if text.Plan.Request != "plan my deep work for today" {
		t.Errorf("request = %q", text.Plan.Request)
	}
}
