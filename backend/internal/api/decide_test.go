package api

import (
	"strings"
	"testing"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// propose asks for three Animedoro blocks on the compiler project today.
func (e *env) propose(t *testing.T, c *client, task store.Task) plans.View {
	t.Helper()
	var res planReply
	ask := obj{"ask": obj{"window": "today", "task_ids": []uint{task.ID}, "blocks_per_task": 3, "mode_hint": "Animedoro"}}
	if code := c.call("POST", "/api/assistant/plan", ask, &res); code != 200 || len(res.Plan.Blocks) != 3 {
		t.Fatalf("propose: %d %+v", code, res.Plan)
	}
	return res.Plan
}

func TestPartialAcceptKeepsTheChosenBlocks(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	plan := e.propose(t, ada, task)
	stream, stop := e.hub.Subscribe(ada.id)
	defer stop()

	first, third := plan.Blocks[0].ID, plan.Blocks[2].ID
	var view plans.View
	if code := ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{third, first}}, &view); code != 200 {
		t.Fatalf("accept: %d", code)
	}
	if view.Status != store.PlanAccepted {
		t.Errorf("plan is %q", view.Status)
	}
	got := map[uint]string{}
	for _, b := range view.Blocks {
		got[b.ID] = b.Status
	}
	if got[first] != store.BlockAccepted || got[third] != store.BlockAccepted || got[plan.Blocks[1].ID] != store.BlockRejected {
		t.Errorf("statuses = %v", got)
	}
	if ev := <-stream; ev.Type != "plan.accepted" {
		t.Errorf("event %q", ev.Type)
	}

	var day struct{ Blocks []store.ScheduledSession }
	ada.call("GET", "/api/schedule?from=2026-10-26", nil, &day)
	if len(day.Blocks) != 2 {
		t.Errorf("the day shows %d accepted blocks, want 2", len(day.Blocks))
	}
	if code := ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", nil, nil); code != 409 {
		t.Errorf("accepting twice: %d, want 409", code)
	}
	if code := e.signup(t, "bob@example.com").call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", nil, nil); code != 404 {
		t.Errorf("another user accepting: %d, want 404", code)
	}
}

func TestAcceptChecksTheCalendarAgain(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	plan := e.propose(t, ada, task)

	// A meeting lands on the first block after it was proposed.
	b := plan.Blocks[0]
	var acct store.CalendarAccount
	e.db.Where("user_id = ?", ada.id).First(&acct)
	e.db.Create(&store.CalendarEvent{UserID: ada.id, AccountID: acct.ID, ExternalID: "surprise", Title: "Surprise review",
		StartsAt: b.StartsAt.Add(15 * time.Minute), EndsAt: b.StartsAt.Add(45 * time.Minute), Busy: true})

	var res obj
	if code := ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", nil, &res); code != 409 || res["code"] != "meeting" ||
		!strings.Contains(res["error"].(string), "Surprise review") {
		t.Fatalf("%d %v", code, res)
	}
	// Leaving that block out works.
	if code := ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{plan.Blocks[1].ID}}, nil); code != 200 {
		t.Fatalf("accepting the rest: %d", code)
	}
	if code := ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{999}}, nil); code != 409 {
		t.Errorf("accepting a closed plan: %d", code)
	}
}

func TestAcceptingCreatesTheNewTasksItNamed(t *testing.T) {
	e := setup(t, "")
	ada, _ := e.plannerUser(t, "ada@example.com")
	var res planReply
	ada.call("POST", "/api/assistant/plan", obj{"ask": obj{"window": "today", "new_tasks": []string{"Read the RFC"}, "blocks_per_task": 2}}, &res)
	var view plans.View
	ada.call("POST", "/api/plans/"+itoa(res.Plan.ID)+"/accept", nil, &view)
	var task store.Task
	if err := e.db.Where("user_id = ? AND title = ?", ada.id, "Read the RFC").First(&task).Error; err != nil {
		t.Fatal("the task wasn't created")
	}
	if task.Estimate != 2 {
		t.Errorf("estimate %d, want 2 (one per accepted block)", task.Estimate)
	}
	for _, b := range view.Blocks {
		if b.TaskID == nil || *b.TaskID != task.ID || b.NewTask {
			t.Errorf("block = %+v", b)
		}
	}
}

func TestMovingABlockIsRevalidated(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	plan := e.propose(t, ada, task)
	ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{plan.Blocks[0].ID}}, nil)
	id := itoa(plan.Blocks[0].ID)

	for name, c := range map[string]struct {
		at   time.Time
		code string
	}{
		"onto the standup": {time.Date(2026, 10, 26, 9, 30, 0, 0, ny), "meeting"},
		"off the grid":     {time.Date(2026, 10, 26, 14, 7, 0, 0, ny), "off_grid"},
		"into lunch":       {time.Date(2026, 10, 26, 11, 45, 0, 0, ny), "lunch"},
		"after hours":      {time.Date(2026, 10, 26, 16, 30, 0, 0, ny), "outside_workday"},
		"too soon":         {time.Date(2026, 10, 26, 7, 30, 0, 0, ny), "too_soon"},
		"onto a weekend":   {time.Date(2026, 10, 31, 10, 0, 0, 0, ny), "weekend"},
	} {
		var res obj
		if code := ada.call("PATCH", "/api/scheduled/"+id, obj{"starts_at": c.at}, &res); code != 409 || res["code"] != c.code {
			t.Errorf("%s: %d %v, want 409 %s", name, code, res, c.code)
		}
	}
	var moved store.ScheduledSession
	to := time.Date(2026, 10, 26, 14, 0, 0, 0, ny)
	if code := ada.call("PATCH", "/api/scheduled/"+id, obj{"starts_at": to}, &moved); code != 200 || !moved.StartsAt.Equal(to) {
		t.Fatalf("a valid move: %d %+v", code, moved)
	}
	if code := ada.call("PATCH", "/api/scheduled/"+id, obj{"starts_at": to, "mode": "Deep Work"}, &moved); code != 200 || moved.FocusMin != 90 {
		t.Fatalf("a resize: %d %+v", code, moved)
	}
	if code := e.signup(t, "bob@example.com").call("PATCH", "/api/scheduled/"+id, obj{"starts_at": to}, nil); code != 404 {
		t.Errorf("another user moving it: %d", code)
	}
}

func TestDropRejectAndStartNow(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	plan := e.propose(t, ada, task)
	ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{plan.Blocks[0].ID, plan.Blocks[1].ID}}, nil)

	if code := ada.call("DELETE", "/api/scheduled/"+itoa(plan.Blocks[1].ID), nil, nil); code != 204 {
		t.Fatalf("drop: %d", code)
	}
	var dropped store.ScheduledSession
	e.db.First(&dropped, plan.Blocks[1].ID)
	if dropped.Status != store.BlockSkipped {
		t.Errorf("dropped block is %q, want skipped (kept for the numbers)", dropped.Status)
	}

	var state engine.State
	if code := ada.call("POST", "/api/scheduled/"+itoa(plan.Blocks[0].ID)+"/start", nil, &state); code != 200 || state.Status != engine.Running {
		t.Fatalf("start now: %d %+v", code, state)
	}
	if code := ada.call("POST", "/api/scheduled/"+itoa(plan.Blocks[0].ID)+"/start", nil, nil); code != 409 {
		t.Errorf("starting twice: %d", code)
	}
	if code := ada.call("DELETE", "/api/scheduled/"+itoa(plan.Blocks[0].ID), nil, nil); code != 409 {
		t.Errorf("dropping a running block: %d", code)
	}

	second := e.propose(t, ada, task)
	var rejected plans.View
	if code := ada.call("POST", "/api/plans/"+itoa(second.ID)+"/reject", nil, &rejected); code != 200 || rejected.Status != store.PlanRejected {
		t.Fatalf("reject: %d %+v", code, rejected.Status)
	}
	for _, b := range rejected.Blocks {
		if b.Status != store.BlockRejected {
			t.Errorf("block %d is %q after rejecting", b.ID, b.Status)
		}
	}
}
