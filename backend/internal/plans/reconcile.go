package plans

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// Reconcile runs after a calendar sync changes something. An accepted block that a
// meeting now overlaps is marked conflicted, and the planner proposes a replacement for
// that day with the block's task still requested. Nothing the user accepted moves on its
// own: the replacement is a proposal, announced as plan.conflict, and the user decides.
// A conflicted block whose meeting has moved away again goes back to accepted.
func (s *Service) Reconcile(ctx context.Context, userID uint) error {
	now := s.Now()
	var blocks []store.ScheduledSession
	if err := s.DB.Where("user_id = ? AND status IN ? AND starts_at > ?", userID,
		[]string{store.BlockAccepted, store.BlockConflicted}, now).Order("starts_at, id").Find(&blocks).Error; err != nil {
		return err
	}
	if len(blocks) == 0 {
		return nil
	}
	user, loc, err := s.userLoc(s.DB, userID)
	if err != nil {
		return err
	}
	var meetings []store.CalendarEvent
	last := blocks[len(blocks)-1].EndsAt()
	if err := s.DB.Where("user_id = ? AND busy = ? AND all_day = ? AND owned_by_us = ? AND starts_at < ? AND ends_at > ?",
		userID, true, false, false, last, blocks[0].StartsAt).Order("starts_at").Find(&meetings).Error; err != nil {
		return err
	}
	overlap := func(b store.ScheduledSession) *store.CalendarEvent {
		for i := range meetings {
			if meetings[i].StartsAt.Before(b.EndsAt()) && b.StartsAt.Before(meetings[i].EndsAt) {
				return &meetings[i]
			}
		}
		return nil
	}

	var newly, cleared []store.ScheduledSession
	err = s.DB.Transaction(func(tx *gorm.DB) error {
		for _, b := range blocks {
			m := overlap(b)
			switch {
			case m != nil && b.Status == store.BlockAccepted:
				title := m.Title
				if title == "" {
					title = "a meeting"
				}
				note := truncate(fmt.Sprintf("%s (%s–%s) now overlaps this block", title,
					m.StartsAt.In(loc).Format("15:04"), m.EndsAt.In(loc).Format("15:04")), 160)
				updates := map[string]any{"status": store.BlockConflicted, "note": note}
				if b.ConflictedAt == nil {
					updates["conflicted_at"] = now.UTC()
				}
				if err := tx.Model(&b).Updates(updates).Error; err != nil {
					return err
				}
				newly = append(newly, b)
			case m == nil && b.Status == store.BlockConflicted:
				if err := tx.Model(&b).Updates(map[string]any{"status": store.BlockAccepted, "note": "the conflicting meeting moved away"}).Error; err != nil {
					return err
				}
				cleared = append(cleared, b)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(cleared) > 0 {
		if err := s.dropResolvedReplans(userID); err != nil {
			return err
		}
		s.Hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "schedule"}})
	}
	if len(newly) == 0 {
		return nil
	}

	// One replacement proposal covering every block now in conflict, so accepting it
	// resolves them all. The window is the days those blocks were on.
	var conflicted []store.ScheduledSession
	if err := s.DB.Where("user_id = ? AND status = ? AND starts_at > ?", userID, store.BlockConflicted, now).Order("starts_at").Find(&conflicted).Error; err != nil {
		return err
	}
	args := Args{Window: "custom", StartDate: conflicted[0].StartsAt.In(loc).Format("2006-01-02"),
		EndDate: conflicted[len(conflicted)-1].StartsAt.In(loc).Format("2006-01-02"), TotalBlocks: len(conflicted)}
	var ids []uint
	modes := map[string]bool{}
	for _, b := range conflicted {
		ids = append(ids, b.ID)
		modes[b.Mode] = true
		if b.TaskID != nil && !slices.Contains(args.TaskIDs, *b.TaskID) {
			args.TaskIDs = append(args.TaskIDs, *b.TaskID)
		}
	}
	if len(modes) == 1 {
		args.ModeHint = conflicted[0].Mode // keep the rhythm the user had accepted
	}
	if len(args.TaskIDs) > 0 {
		args.TotalBlocks = 0
		args.BlocksPerTask = 0
		perTask := map[uint]int{}
		for _, b := range conflicted {
			if b.TaskID != nil {
				perTask[*b.TaskID]++
			}
		}
		for _, n := range perTask {
			args.BlocksPerTask = max(args.BlocksPerTask, n)
		}
	}
	plan, err := s.Propose(ctx, userID, Proposal{Args: args, Source: store.SourceConflict, Replaces: ids})
	if err != nil {
		var argErr *ArgError
		if !errors.As(err, &argErr) {
			return err
		}
		// A task closed since, or a rhythm deleted: plan the day without those constraints.
		log.Printf("plans: replanning conflicts for user %d: %v", user.ID, err)
		plan, err = s.Propose(ctx, userID, Proposal{Args: Args{Window: "custom", StartDate: args.StartDate, EndDate: args.EndDate, TotalBlocks: len(ids)},
			Source: store.SourceConflict, Replaces: ids})
		if err != nil {
			return err
		}
	}
	original := conflicted[0].PlanID
	s.Hub.Publish(userID, events.Event{Type: "plan.conflict", Data: map[string]any{
		"plan_id": original, "block_ids": ids, "replacement_plan_id": plan.ID,
	}})
	s.changed()
	return nil
}

// dropResolvedReplans retires a live conflict re-plan once none of the blocks it would
// replace is still in conflict.
func (s *Service) dropResolvedReplans(userID uint) error {
	var live []store.Plan
	if err := s.DB.Where("user_id = ? AND status = ? AND source = ?", userID, store.PlanProposed, store.SourceConflict).Find(&live).Error; err != nil {
		return err
	}
	for _, p := range live {
		var still int64
		if len(p.Replaces) > 0 {
			if err := s.DB.Model(&store.ScheduledSession{}).Where("id IN ? AND status = ?", p.Replaces, store.BlockConflicted).Count(&still).Error; err != nil {
				return err
			}
		}
		if still == 0 {
			if err := s.DB.Model(&p).Update("status", store.PlanSuperseded).Error; err != nil {
				return err
			}
			if err := s.DB.Model(&store.ScheduledSession{}).Where("plan_id = ? AND status = ?", p.ID, store.BlockProposed).
				Updates(map[string]any{"status": store.BlockRejected, "note": "the conflict resolved itself"}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
