package calendar

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// WriteCalendarName is the calendar accepted blocks are written to. Writing to a calendar
// of our own (scope calendar.app.created) means we can never touch the user's meetings.
const WriteCalendarName = "Brew Focus"

type writeJob struct {
	userID, blockID uint
	remove          bool
}

// Writer copies accepted focus blocks to the user's calendar when they have write-back
// on: created when accepted, updated when moved, deleted when dropped or replaced. It
// works off a queue, so accepting a plan never waits on Google.
type Writer struct {
	svc  *Service
	jobs chan writeJob
}

// NewWriter returns a writer that uses the service's providers and accounts.
func (s *Service) NewWriter() *Writer {
	return &Writer{svc: s, jobs: make(chan writeJob, 256)}
}

// Upsert queues creating or updating the block's event.
func (w *Writer) Upsert(userID, blockID uint) { w.enqueue(writeJob{userID: userID, blockID: blockID}) }

// Remove queues deleting the block's event, if it has one.
func (w *Writer) Remove(userID, blockID uint) {
	w.enqueue(writeJob{userID: userID, blockID: blockID, remove: true})
}

func (w *Writer) enqueue(j writeJob) {
	select {
	case w.jobs <- j:
	default:
		log.Printf("calendar: write-back queue full, dropping block %d", j.blockID)
	}
}

// Run processes the queue until ctx is cancelled.
func (w *Writer) Run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return nil
		case j := <-w.jobs:
			if err := w.Do(ctx, j.userID, j.blockID, j.remove); err != nil {
				log.Printf("calendar: writing back block %d: %v", j.blockID, err)
			}
		}
	}
}

// Do performs one write-back synchronously (Run calls it; tests call it directly).
func (w *Writer) Do(ctx context.Context, userID, blockID uint, remove bool) error {
	db := w.svc.db
	var block store.ScheduledSession
	if err := db.Where("id = ? AND user_id = ?", blockID, userID).First(&block).Error; err != nil {
		return err
	}
	if remove {
		if block.ExternalEventID == "" || block.CalendarAccountID == nil {
			return nil
		}
		return w.withAccount(ctx, *block.CalendarAccountID, func(acct *store.CalendarAccount, p Provider, cred *Credentials) error {
			if err := p.DeleteEvent(ctx, cred, acct.WriteCalID, block.ExternalEventID); err != nil {
				return err
			}
			return db.Model(&block).Updates(map[string]any{"external_event_id": "", "calendar_account_id": nil}).Error
		})
	}

	var user store.User
	if err := db.First(&user, userID).Error; err != nil {
		return err
	}
	if !user.Settings.WriteBack || (block.Status != store.BlockAccepted && block.Status != store.BlockStarted) {
		return nil
	}
	accountID := uint(0)
	if block.CalendarAccountID != nil {
		accountID = *block.CalendarAccountID
	} else {
		var acct store.CalendarAccount
		if err := db.Where("user_id = ?", userID).Order("id").Limit(1).Find(&acct).Error; err != nil {
			return err
		}
		if acct.ID == 0 {
			return nil // no calendar connected: nothing to write to
		}
		accountID = acct.ID
	}
	title := "Focus block"
	if block.Intention != "" {
		title = "Focus: " + block.Intention
	}
	event := Event{
		Title: truncate(title, MaxTitle), Start: block.StartsAt, End: block.StartsAt.Add(time.Duration(block.FocusMin) * time.Minute),
		Description: fmt.Sprintf("%s %d/%d, planned by Brew Focus. %s", block.Mode, block.FocusMin, block.RestMin, block.Explain),
	}
	return w.withAccount(ctx, accountID, func(acct *store.CalendarAccount, p Provider, cred *Credentials) error {
		for attempt := 0; attempt < 2; attempt++ {
			if acct.WriteCalID == "" {
				id, err := p.EnsureCalendar(ctx, cred, WriteCalendarName, user.Settings.TimeZone)
				if err != nil {
					return err
				}
				acct.WriteCalID = id
				if err := db.Model(acct).Update("write_cal_id", id).Error; err != nil {
					return err
				}
			}
			var err error
			if block.ExternalEventID != "" {
				err = p.UpdateEvent(ctx, cred, acct.WriteCalID, block.ExternalEventID, event)
				if errors.Is(err, ErrNotFound) {
					block.ExternalEventID = "" // the user deleted the event; write a fresh one
					continue
				}
			} else {
				var id string
				id, err = p.CreateEvent(ctx, cred, acct.WriteCalID, event)
				if errors.Is(err, ErrNotFound) {
					acct.WriteCalID = "" // the user deleted our calendar; make another
					continue
				}
				if err == nil {
					err = db.Model(&block).Updates(map[string]any{"external_event_id": id, "calendar_account_id": acct.ID}).Error
				}
			}
			return err
		}
		return errors.New("calendar: write-back kept finding its calendar or event gone")
	})
}

// withAccount runs fn under the account's lock with its provider and credentials, and
// saves the tokens if the provider refreshed them.
func (w *Writer) withAccount(ctx context.Context, accountID uint, fn func(*store.CalendarAccount, Provider, *Credentials) error) error {
	defer w.svc.lock(accountID)()
	var acct store.CalendarAccount
	if err := w.svc.db.First(&acct, accountID).Error; err != nil {
		return err
	}
	p, ok := w.svc.providers[acct.Provider]
	if !ok {
		return fmt.Errorf("calendar: the %q provider isn't configured", acct.Provider)
	}
	cred := credentialsOf(acct)
	err := fn(&acct, p, cred)
	if cred.Refreshed {
		if serr := w.svc.db.Model(&acct).Select("access_token", "refresh_token", "expiry").Updates(&store.CalendarAccount{
			AccessToken: []byte(cred.AccessToken), RefreshToken: []byte(cred.RefreshToken), Expiry: cred.Expiry}).Error; serr != nil {
			log.Printf("calendar: saving refreshed tokens for account %d: %v", acct.ID, serr)
		}
	}
	return scrub(err, cred)
}
