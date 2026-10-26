package plans

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/planner"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// ConflictError is a block that breaks a hard constraint where the user put it. The API
// returns it as a 409, so the UI can snap the block back and say why.
type ConflictError struct {
	BlockID uint
	Code    string
	Msg     string
}

func (e *ConflictError) Error() string { return e.Msg }

// Accept moves the chosen blocks of a proposal to accepted and the rest to rejected. No
// IDs means all of them. Each chosen block is checked again against the calendar as it
// is now: a meeting may have landed on it since the plan was made. Tasks the user named
// that didn't exist are created now, not when the plan was proposed.
func (s *Service) Accept(userID, planID uint, blockIDs []uint) (*View, error) {
	var accepted, replaced []uint
	createdTasks := false
	err := s.DB.Transaction(func(tx *gorm.DB) error {
		var plan store.Plan
		if err := tx.Where("id = ? AND user_id = ?", planID, userID).First(&plan).Error; err != nil {
			return err
		}
		if plan.Status != store.PlanProposed {
			return ErrNotProposed
		}
		var blocks []store.ScheduledSession
		if err := tx.Where("plan_id = ? AND status = ?", plan.ID, store.BlockProposed).Order("starts_at, id").Find(&blocks).Error; err != nil {
			return err
		}
		chosen := blocks
		if len(blockIDs) > 0 {
			chosen = nil
			for _, id := range blockIDs {
				i := slices.IndexFunc(blocks, func(b store.ScheduledSession) bool { return b.ID == id })
				if i < 0 {
					return argErr("block_ids", "block %d is not an open block of this plan", id)
				}
				if !slices.ContainsFunc(chosen, func(b store.ScheduledSession) bool { return b.ID == id }) {
					chosen = append(chosen, blocks[i])
				}
			}
			slices.SortFunc(chosen, func(a, b store.ScheduledSession) int { return a.StartsAt.Compare(b.StartsAt) })
		}
		if len(chosen) == 0 {
			return argErr("block_ids", "pick at least one block to accept")
		}
		user, loc, err := s.userLoc(tx, userID)
		if err != nil {
			return err
		}
		var ok []store.ScheduledSession
		for _, b := range chosen {
			if err := s.checkSlot(tx, user, loc, plan, b, b.StartsAt, modeOf(b), plan.Replaces, ok); err != nil {
				return err
			}
			ok = append(ok, b)
		}
		for i := range ok {
			b := &ok[i]
			if b.NewTask {
				id, created, err := findOrCreateTask(tx, userID, b.Intention, countTitle(ok, b.Intention))
				if err != nil {
					return err
				}
				createdTasks = createdTasks || created
				b.TaskID, b.NewTask = &id, false
			}
			b.Status = store.BlockAccepted
			if err := tx.Model(b).Updates(map[string]any{"status": b.Status, "task_id": b.TaskID, "new_task": false}).Error; err != nil {
				return err
			}
			accepted = append(accepted, b.ID)
		}
		if err := tx.Model(&store.ScheduledSession{}).Where("plan_id = ? AND status = ?", plan.ID, store.BlockProposed).
			Updates(map[string]any{"status": store.BlockRejected, "note": "not picked"}).Error; err != nil {
			return err
		}
		if len(plan.Replaces) > 0 {
			if err := tx.Model(&store.ScheduledSession{}).Where("id IN ? AND user_id = ? AND status = ?", plan.Replaces, userID, store.BlockConflicted).
				Pluck("id", &replaced).Error; err != nil {
				return err
			}
			if err := tx.Model(&store.ScheduledSession{}).Where("id IN ?", replaced).
				Updates(map[string]any{"status": store.BlockSkipped, "note": fmt.Sprintf("replaced by plan %d after a calendar change", plan.ID)}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&plan).Update("status", store.PlanAccepted).Error
	})
	if err != nil {
		return nil, err
	}
	s.Hub.Publish(userID, events.Event{Type: "plan.accepted", Data: map[string]any{"plan_id": planID, "block_ids": accepted}})
	if createdTasks {
		s.Hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "tasks"}})
	}
	if s.Calendar != nil {
		for _, id := range accepted {
			s.Calendar.Upsert(userID, id)
		}
		for _, id := range replaced {
			s.Calendar.Remove(userID, id)
		}
	}
	s.changed()
	return s.Get(userID, planID)
}

// Reject closes a proposal. Rejecting a conflict re-plan means "keep my blocks": the
// conflicted blocks go back to accepted, where the user left them.
func (s *Service) Reject(userID, planID uint) (*View, error) {
	err := s.DB.Transaction(func(tx *gorm.DB) error {
		var plan store.Plan
		if err := tx.Where("id = ? AND user_id = ?", planID, userID).First(&plan).Error; err != nil {
			return err
		}
		if plan.Status != store.PlanProposed {
			return ErrNotProposed
		}
		if err := tx.Model(&store.ScheduledSession{}).Where("plan_id = ? AND status = ?", plan.ID, store.BlockProposed).
			Updates(map[string]any{"status": store.BlockRejected, "note": "plan rejected"}).Error; err != nil {
			return err
		}
		if len(plan.Replaces) > 0 {
			if err := tx.Model(&store.ScheduledSession{}).Where("id IN ? AND user_id = ? AND status = ?", plan.Replaces, userID, store.BlockConflicted).
				Updates(map[string]any{"status": store.BlockAccepted, "note": "kept despite a calendar change"}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&plan).Update("status", store.PlanRejected).Error
	})
	if err != nil {
		return nil, err
	}
	s.Hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "schedule"}})
	s.changed()
	return s.Get(userID, planID)
}

// Move puts one block at a new start (and optionally a new rhythm), re-validated against
// the hard constraints. The client's new time is a request, never trusted as is.
func (s *Service) Move(userID, blockID uint, startsAt time.Time, modeName string) (*store.ScheduledSession, error) {
	var block store.ScheduledSession
	err := s.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id = ? AND user_id = ?", blockID, userID).First(&block).Error; err != nil {
			return err
		}
		if !slices.Contains([]string{store.BlockProposed, store.BlockAccepted, store.BlockConflicted}, block.Status) {
			return &ConflictError{BlockID: block.ID, Code: "not_movable", Msg: "a block that has started or ended can't be moved"}
		}
		var plan store.Plan
		if err := tx.First(&plan, block.PlanID).Error; err != nil {
			return err
		}
		if block.Status == store.BlockProposed && plan.Status != store.PlanProposed {
			return ErrNotProposed
		}
		user, loc, err := s.userLoc(tx, userID)
		if err != nil {
			return err
		}
		mode := modeOf(block)
		if modeName != "" {
			modes, err := Modes(tx, userID, s.Now())
			if err != nil {
				return err
			}
			i := slices.IndexFunc(modes, func(m planner.Mode) bool { return strings.EqualFold(m.Name, modeName) })
			if i < 0 {
				return argErr("mode", "is not one of your rhythms")
			}
			mode = modes[i]
		}
		// A proposed block must also keep clear of the other blocks in its proposal.
		var siblings []store.ScheduledSession
		if block.Status == store.BlockProposed {
			if err := tx.Where("plan_id = ? AND status = ? AND id <> ?", plan.ID, store.BlockProposed, block.ID).Find(&siblings).Error; err != nil {
				return err
			}
		}
		if err := s.checkSlot(tx, user, loc, plan, block, startsAt.UTC(), mode, nil, siblings); err != nil {
			return err
		}
		updates := map[string]any{"starts_at": startsAt.UTC(), "mode": mode.Name, "focus_min": mode.FocusMin, "rest_min": mode.RestMin}
		if block.Status == store.BlockConflicted {
			updates["status"], updates["note"] = store.BlockAccepted, "moved after a calendar change"
		}
		if err := tx.Model(&block).Updates(updates).Error; err != nil {
			return err
		}
		return tx.First(&block, block.ID).Error
	})
	if err != nil {
		return nil, err
	}
	s.Hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "schedule"}})
	if s.Calendar != nil && block.Status == store.BlockAccepted {
		s.Calendar.Upsert(userID, block.ID)
	}
	s.changed()
	return &block, nil
}

// Drop takes one block out: a proposed block leaves its proposal, an accepted one is
// skipped (and its calendar event, if written back, removed). The row stays, because
// a skipped block is part of the measurement story.
func (s *Service) Drop(userID, blockID uint) error {
	var block store.ScheduledSession
	if err := s.DB.Where("id = ? AND user_id = ?", blockID, userID).First(&block).Error; err != nil {
		return err
	}
	status, note := store.BlockSkipped, "skipped"
	switch block.Status {
	case store.BlockProposed:
		status, note = store.BlockRejected, "removed from the proposal"
	case store.BlockAccepted, store.BlockConflicted:
	default:
		return &ConflictError{BlockID: block.ID, Code: "not_droppable", Msg: "a block that has started or ended can't be dropped"}
	}
	if err := s.DB.Model(&block).Updates(map[string]any{"status": status, "note": note}).Error; err != nil {
		return err
	}
	s.Hub.Publish(userID, events.Event{Type: "changed", Data: map[string]any{"kind": "schedule"}})
	if s.Calendar != nil && block.ExternalEventID != "" {
		s.Calendar.Remove(userID, block.ID)
	}
	s.changed()
	return nil
}

func (s *Service) userLoc(tx *gorm.DB, userID uint) (store.User, *time.Location, error) {
	var user store.User
	if err := tx.First(&user, userID).Error; err != nil {
		return user, nil, err
	}
	loc, err := user.Settings.Location()
	return user, loc, err
}

func modeOf(b store.ScheduledSession) planner.Mode {
	return planner.Mode{Name: b.Mode, FocusMin: b.FocusMin, RestMin: b.RestMin}
}

// checkSlot validates block b at start against the user's calendar and every other live
// block, plus extra (blocks being accepted alongside it), using the planner's own rules.
func (s *Service) checkSlot(tx *gorm.DB, user store.User, loc *time.Location, plan store.Plan, b store.ScheduledSession,
	start time.Time, mode planner.Mode, ignore []uint, extra []store.ScheduledSession) error {
	now := s.Now()
	day := start.In(loc).Format("2006-01-02")
	if day < now.In(loc).Format("2006-01-02") {
		return &ConflictError{BlockID: b.ID, Code: planner.ViolationTooSoon, Msg: "that's in the past"}
	}
	args := Args{Window: "custom", StartDate: day, AllowEvening: plan.AllowEvening, AllowWeekend: plan.AllowWeekend}
	in, err := BuildInput(tx, user, loc, args, now, []planner.Mode{mode}, append(slices.Clone(ignore), b.ID))
	if err != nil {
		return err
	}
	for _, o := range extra {
		var task uint
		if o.TaskID != nil {
			task = *o.TaskID
		}
		in.Booked = append(in.Booked, planner.Booked{Start: o.StartsAt, FocusMin: o.FocusMin, RestMin: o.RestMin, TaskID: task})
	}
	v, err := planner.Check(in, start, mode)
	if err != nil || v.Code == "" {
		return err
	}
	return &ConflictError{BlockID: b.ID, Code: v.Code, Msg: s.describe(tx, user, loc, v)}
}

// describe turns a violation into a sentence for the toast.
func (s *Service) describe(tx *gorm.DB, user store.User, loc *time.Location, v planner.Violation) string {
	hm := func(t time.Time) string { return t.In(loc).Format("15:04") }
	switch v.Code {
	case planner.ViolationTooSoon:
		return "that's too soon: a block needs at least 5 minutes' notice"
	case planner.ViolationOffGrid:
		return "blocks start on the quarter hour"
	case planner.ViolationWeekend:
		return "that's a weekend, and this plan doesn't include weekends"
	case planner.ViolationOutsideDay:
		if !v.At.IsZero() {
			return fmt.Sprintf("that runs outside your day (%s–%s)", hm(v.At), hm(v.End))
		}
		return "that's outside the days this plan covers"
	case planner.ViolationLunch:
		return fmt.Sprintf("that overlaps your protected lunch (%s–%s)", hm(v.At), hm(v.End))
	case planner.ViolationMeeting:
		title := "a meeting"
		var e store.CalendarEvent
		if tx.Where("user_id = ? AND busy = ? AND owned_by_us = ? AND all_day = ? AND starts_at < ? AND ends_at > ?",
			user.ID, true, false, false, v.End, v.At).Order("starts_at").Limit(1).Find(&e).Error == nil && e.Title != "" {
			title = e.Title
		}
		return fmt.Sprintf("that overlaps %s (%s–%s) or its %d-minute buffer", title, hm(v.At), hm(v.End), user.Settings.BufferMin)
	case planner.ViolationTooClose:
		return fmt.Sprintf("that's too close to another focus block (%s–%s)", hm(v.At), hm(v.End))
	case planner.ViolationDayCap:
		return fmt.Sprintf("that day is already at your cap of %d blocks or %d focus minutes", user.Settings.MaxBlocksPerDay, user.Settings.MaxFocusMinPerDay)
	}
	return "that slot breaks one of your planning limits"
}

func countTitle(blocks []store.ScheduledSession, title string) int {
	n := 0
	for _, b := range blocks {
		if b.NewTask && strings.EqualFold(b.Intention, title) {
			n++
		}
	}
	return n
}

// findOrCreateTask returns the user's open task with this title, creating it if needed
// with an estimate of the blocks just accepted for it.
func findOrCreateTask(tx *gorm.DB, userID uint, title string, estimate int) (uint, bool, error) {
	var task store.Task
	if err := tx.Where("user_id = ? AND done = ? AND LOWER(title) = LOWER(?)", userID, false, title).Limit(1).Find(&task).Error; err != nil {
		return 0, false, err
	}
	if task.ID != 0 {
		return task.ID, false, nil
	}
	task = store.Task{UserID: userID, Title: title, Estimate: max(1, min(20, estimate))}
	if err := tx.Create(&task).Error; err != nil {
		return 0, false, err
	}
	return task.ID, true, nil
}

// Backfill writes back every accepted block still ahead, for a user who just turned
// write-back on.
func (s *Service) Backfill(userID uint) error {
	if s.Calendar == nil {
		return nil
	}
	var ids []uint
	if err := s.DB.Model(&store.ScheduledSession{}).Where("user_id = ? AND status = ? AND starts_at > ? AND external_event_id = ''",
		userID, store.BlockAccepted, s.Now()).Order("starts_at").Pluck("id", &ids).Error; err != nil {
		return err
	}
	for _, id := range ids {
		s.Calendar.Upsert(userID, id)
	}
	return nil
}
