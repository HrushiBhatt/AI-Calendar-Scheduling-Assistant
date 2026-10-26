package api

import (
	"testing"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

type insightRate struct {
	Count, Of int
	Rate      *float64
}

func TestInsightsMeasureThePlanningLoop(t *testing.T) {
	e := setup(t, "")
	ada, task := e.plannerUser(t, "ada@example.com")
	plan := e.propose(t, ada, task)
	ada.call("POST", "/api/plans/"+itoa(plan.ID)+"/accept", obj{"block_ids": []uint{plan.Blocks[0].ID, plan.Blocks[1].ID}}, nil)

	// Two finished sessions from planned blocks (one ran to zero), three ad hoc (all did).
	id0, id1 := plan.Blocks[0].ID, plan.Blocks[1].ID
	e.db.Create(&store.Session{UserID: ada.id, Mode: "Animedoro", State: store.StateDone, Completed: true, ScheduledID: &id0, Day: "2026-10-26"})
	e.db.Create(&store.Session{UserID: ada.id, Mode: "Animedoro", State: store.StateDone, Completed: false, ScheduledID: &id1, Day: "2026-10-26"})
	for range 3 {
		e.db.Create(&store.Session{UserID: ada.id, Mode: "Pomodoro", State: store.StateDone, Completed: true, Day: "2026-10-26"})
	}
	now := time.Now()
	e.db.Model(&store.ScheduledSession{}).Where("id = ?", id1).Update("conflicted_at", now)
	e.db.Create(&store.AssistantTurn{UserID: ada.id, ToolCalls: []store.ToolCall{{Name: "plan_focus_blocks", Error: "window: bad"}, {Name: "plan_focus_blocks"}},
		Failure: "narration_invented_time: 4pm"})

	var got struct {
		Acceptance       insightRate
		PartialAccept    insightRate `json:"partial_accept"`
		Conflicts        insightRate
		ToolCallValidity insightRate `json:"tool_call_validity"`
		Completion       struct {
			Planned insightRate
			AdHoc   insightRate `json:"ad_hoc"`
		}
		Assistant        struct{ Failures map[string]int }
		SchedulerLatency struct{ Samples int } `json:"scheduler_latency"`
	}
	if code := ada.call("GET", "/api/insights", nil, &got); code != 200 {
		t.Fatalf("insights: %d", code)
	}
	switch {
	case got.Acceptance.Count != 2 || got.Acceptance.Of != 3:
		t.Errorf("acceptance = %+v, want 2 of 3", got.Acceptance)
	case got.PartialAccept.Count != 1 || got.PartialAccept.Of != 1:
		t.Errorf("partial accept = %+v", got.PartialAccept)
	case got.Completion.Planned.Count != 1 || got.Completion.Planned.Of != 2 || got.Completion.AdHoc.Count != 3 || got.Completion.AdHoc.Of != 3:
		t.Errorf("completion = %+v", got.Completion)
	case got.Conflicts.Count != 1 || got.Conflicts.Of != 2:
		t.Errorf("conflicts = %+v", got.Conflicts)
	case got.ToolCallValidity.Count != 1 || got.ToolCallValidity.Of != 2:
		t.Errorf("tool calls = %+v", got.ToolCallValidity)
	case got.Assistant.Failures["narration_invented_time"] != 1:
		t.Errorf("failures = %v", got.Assistant.Failures)
	case got.SchedulerLatency.Samples == 0:
		t.Error("no scheduler latency recorded")
	}
}
