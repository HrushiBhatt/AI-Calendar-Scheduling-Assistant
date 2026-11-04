package calendar

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// Sync covers a week back (so "yesterday" still renders) and two months ahead.
const (
	SyncPast        = 7 * 24 * time.Hour
	SyncAhead       = 60 * 24 * time.Hour
	FullResyncEvery = 7 * 24 * time.Hour
)

// ErrNotConfigured means no provider is set up for new connections (no Google keys).
var ErrNotConfigured = errors.New("Google Calendar isn't configured on this server")

// Service owns everything that touches calendar accounts: connecting, syncing,
// disconnecting and, in sync.go, push notifications, polling and channel renewal.
type Service struct {
	db         *gorm.DB
	hub        *events.Hub
	providers  map[string]Provider
	connectVia string
	publicURL  string
	now        func() time.Time
	locks      sync.Map // account ID -> *sync.Mutex: one sync per account at a time

	queue *queue // debounced sync requests, drained by Run

	// AfterSync runs once a sync has changed a user's calendar. The scheduler sets it to
	// reconcile accepted blocks against the new busy times.
	AfterSync func(ctx context.Context, userID uint)
}

// Options configure a Service.
type Options struct {
	Providers  []Provider
	ConnectVia string // the provider new connections use; "" disables connecting
	PublicURL  string // our public base URL for push notifications; "" means poll instead
	Now        func() time.Time
	Debounce   time.Duration // coalescing window for push notifications (default 5s)
}

func NewService(db *gorm.DB, hub *events.Hub, opts Options) *Service {
	s := &Service{db: db, hub: hub, providers: map[string]Provider{}, connectVia: opts.ConnectVia,
		publicURL: strings.TrimRight(opts.PublicURL, "/"), now: opts.Now}
	if s.now == nil {
		s.now = time.Now
	}
	for _, p := range opts.Providers {
		s.providers[p.Name()] = p
	}
	debounce := opts.Debounce
	if debounce == 0 {
		debounce = 5 * time.Second
	}
	s.queue = newQueue(debounce)
	return s
}

// CanConnect reports whether new accounts can be connected, and through which provider.
func (s *Service) CanConnect() (string, bool) {
	_, ok := s.providers[s.connectVia]
	return s.connectVia, ok
}

// AuthURL is where the browser goes to grant access.
func (s *Service) AuthURL(state, verifier string) (string, error) {
	p, ok := s.providers[s.connectVia]
	if !ok {
		return "", ErrNotConfigured
	}
	return p.AuthURL(state, verifier), nil
}

// Connect finishes the OAuth flow: it stores the account's sealed tokens, runs a first
// full sync and registers a push channel. A sync failure leaves the account connected
// with SyncError set, so the user can see what happened and retry.
func (s *Service) Connect(ctx context.Context, userID uint, code, verifier string) (*store.CalendarAccount, error) {
	p, ok := s.providers[s.connectVia]
	if !ok {
		return nil, ErrNotConfigured
	}
	cred, err := p.Exchange(ctx, code, verifier)
	if err != nil {
		return nil, err
	}
	acct, err := s.saveAccount(userID, p.Name(), cred)
	if err != nil {
		return nil, err
	}
	if err := s.Sync(ctx, acct.ID); err != nil {
		log.Printf("calendar: first sync of account %d: %v", acct.ID, err)
	}
	if err := s.Watch(ctx, acct.ID); err != nil {
		log.Printf("calendar: watching account %d: %v", acct.ID, err)
	}
	return acct, s.db.First(acct, acct.ID).Error
}

// ConnectDemo attaches an account from a provider that needs no OAuth (the seeded demo
// account's fake calendar) and syncs it.
func (s *Service) ConnectDemo(ctx context.Context, userID uint, provider string, cred *Credentials) (*store.CalendarAccount, error) {
	if _, ok := s.providers[provider]; !ok {
		return nil, fmt.Errorf("calendar: no %q provider", provider)
	}
	acct, err := s.saveAccount(userID, provider, cred)
	if err != nil {
		return nil, err
	}
	return acct, s.Sync(ctx, acct.ID)
}

// saveAccount creates the account, or refreshes the tokens of one connected before.
func (s *Service) saveAccount(userID uint, provider string, cred *Credentials) (*store.CalendarAccount, error) {
	var acct store.CalendarAccount
	err := s.db.Where("user_id = ? AND provider = ? AND external_id = ?", userID, provider, cred.Account).Limit(1).Find(&acct).Error
	if err != nil {
		return nil, err
	}
	acct.UserID, acct.Provider, acct.ExternalID = userID, provider, cred.Account
	acct.AccessToken, acct.RefreshToken, acct.Expiry = []byte(cred.AccessToken), []byte(cred.RefreshToken), cred.Expiry
	acct.SyncToken, acct.FullSyncAt, acct.SyncError = "", nil, "" // reconnecting starts from a full pull
	return &acct, s.db.Save(&acct).Error
}

// Accounts lists the user's connected accounts.
func (s *Service) Accounts(userID uint) ([]store.CalendarAccount, error) {
	accounts := []store.CalendarAccount{}
	return accounts, s.db.Where("user_id = ?", userID).Order("id").Find(&accounts).Error
}

// SyncUser syncs every account the user has connected, returning the first error.
func (s *Service) SyncUser(ctx context.Context, userID uint) error {
	var ids []uint
	if err := s.db.Model(&store.CalendarAccount{}).Where("user_id = ?", userID).Order("id").Pluck("id", &ids).Error; err != nil {
		return err
	}
	var first error
	for _, id := range ids {
		if err := s.Sync(ctx, id); err != nil && first == nil {
			first = err
		}
	}
	return first
}

func (s *Service) lock(accountID uint) func() {
	m, _ := s.locks.LoadOrStore(accountID, &sync.Mutex{})
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// Sync pulls changes for one account. It uses the stored cursor when there is one, a
// full pull otherwise (first sync, a weekly refresh, or an expired cursor), and writes
// only rows that actually changed, so "changed" in calendar.synced is exact.
func (s *Service) Sync(ctx context.Context, accountID uint) error {
	defer s.lock(accountID)()
	var acct store.CalendarAccount
	if err := s.db.First(&acct, accountID).Error; err != nil {
		return err
	}
	p, ok := s.providers[acct.Provider]
	if !ok {
		return fmt.Errorf("calendar: the %q provider isn't configured on this server", acct.Provider)
	}
	cred := credentialsOf(acct)
	now := s.now().UTC()
	window := Window{Start: now.Add(-SyncPast), End: now.Add(SyncAhead)}

	cursor := acct.SyncToken
	if acct.FullSyncAt == nil || now.Sub(*acct.FullSyncAt) > FullResyncEvery {
		cursor = ""
	}
	changes, err := p.Sync(ctx, cred, cursor, window)
	if err == nil && changes.FullResync {
		// Google answered 410 Gone: the cursor expired. Clear our copy and pull again.
		cursor = ""
		changes, err = p.Sync(ctx, cred, "", window)
		if err == nil && changes.FullResync {
			err = errors.New("the provider rejected a full sync")
		}
	}
	if err != nil {
		s.recordFailure(&acct, cred, err)
		return err
	}

	changed := 0
	err = s.db.Transaction(func(tx *gorm.DB) error {
		var n int
		var err error
		if cursor == "" {
			n, err = replaceAll(tx, acct, changes.Upserted)
		} else {
			n, err = applyChanges(tx, acct, changes)
		}
		if err != nil {
			return err
		}
		changed = n
		// Keep the table bounded: nothing older than the sync window is needed.
		if err := tx.Where("account_id = ? AND ends_at < ?", acct.ID, window.Start).Delete(&store.CalendarEvent{}).Error; err != nil {
			return err
		}
		acct.SyncToken, acct.LastSyncAt, acct.SyncError = changes.NextCursor, &now, ""
		if cursor == "" {
			acct.FullSyncAt = &now
		}
		if cred.Refreshed {
			acct.AccessToken, acct.RefreshToken, acct.Expiry = []byte(cred.AccessToken), []byte(cred.RefreshToken), cred.Expiry
		}
		return tx.Save(&acct).Error
	})
	if err != nil {
		return err
	}
	if changed > 0 {
		s.hub.Publish(acct.UserID, events.Event{Type: "calendar.synced", Data: map[string]any{"account_id": acct.ID, "changed": changed}})
		if s.AfterSync != nil {
			s.AfterSync(ctx, acct.UserID)
		}
	}
	return nil
}

// replaceAll makes the account's rows exactly the pulled set, returning how many differ.
func replaceAll(tx *gorm.DB, acct store.CalendarAccount, pulled []Event) (int, error) {
	var existing []store.CalendarEvent
	if err := tx.Where("account_id = ?", acct.ID).Find(&existing).Error; err != nil {
		return 0, err
	}
	keep := make(map[string]bool, len(pulled))
	for _, e := range pulled {
		keep[e.ID] = true
	}
	changed := 0
	for _, row := range existing {
		if !keep[row.ExternalID] {
			if err := tx.Delete(&row).Error; err != nil {
				return 0, err
			}
			changed++
		}
	}
	n, err := upsert(tx, acct, existing, pulled)
	return changed + n, err
}

// applyChanges applies an incremental change set, returning how many rows changed.
func applyChanges(tx *gorm.DB, acct store.CalendarAccount, ch Changes) (int, error) {
	ids := make([]string, 0, len(ch.Upserted)+len(ch.DeletedIDs))
	for _, e := range ch.Upserted {
		ids = append(ids, e.ID)
	}
	ids = append(ids, ch.DeletedIDs...)
	var existing []store.CalendarEvent
	if len(ids) > 0 {
		// Chunked: SQLite caps the number of bound parameters in one statement.
		for start := 0; start < len(ids); start += 500 {
			var part []store.CalendarEvent
			end := min(start+500, len(ids))
			if err := tx.Where("account_id = ? AND external_id IN ?", acct.ID, ids[start:end]).Find(&part).Error; err != nil {
				return 0, err
			}
			existing = append(existing, part...)
		}
	}
	changed := 0
	if len(ch.DeletedIDs) > 0 {
		res := tx.Where("account_id = ? AND external_id IN ?", acct.ID, ch.DeletedIDs).Delete(&store.CalendarEvent{})
		if res.Error != nil {
			return 0, res.Error
		}
		changed += int(res.RowsAffected)
	}
	n, err := upsert(tx, acct, existing, ch.Upserted)
	return changed + n, err
}

// upsert writes events that are new or differ from their existing row.
func upsert(tx *gorm.DB, acct store.CalendarAccount, existing []store.CalendarEvent, events []Event) (int, error) {
	byID := make(map[string]store.CalendarEvent, len(existing))
	for _, row := range existing {
		byID[row.ExternalID] = row
	}
	changed := 0
	var fresh []store.CalendarEvent
	for _, e := range events {
		row := store.CalendarEvent{
			UserID: acct.UserID, AccountID: acct.ID, ExternalID: e.ID, Title: truncate(e.Title, MaxTitle),
			StartsAt: e.Start.UTC(), EndsAt: e.End.UTC(), AllDay: e.AllDay, Busy: e.Busy, OwnedByUs: e.OwnedByUs,
		}
		old, ok := byID[e.ID]
		switch {
		case !ok:
			fresh = append(fresh, row)
		case old.Title != row.Title || !old.StartsAt.Equal(row.StartsAt) || !old.EndsAt.Equal(row.EndsAt) ||
			old.AllDay != row.AllDay || old.Busy != row.Busy || old.OwnedByUs != row.OwnedByUs:
			row.ID = old.ID
			if err := tx.Save(&row).Error; err != nil {
				return 0, err
			}
		default:
			continue
		}
		changed++
	}
	if len(fresh) > 0 {
		if err := tx.CreateInBatches(fresh, 200).Error; err != nil {
			return 0, err
		}
	}
	return changed, nil
}

// recordFailure saves a short, token-free description of a failed sync for the settings page.
func (s *Service) recordFailure(acct *store.CalendarAccount, cred *Credentials, err error) {
	msg := scrub(err, cred).Error()
	if strings.Contains(msg, "invalid_grant") {
		msg = "Google access was revoked or has expired. Disconnect and connect the calendar again."
	}
	acct.SyncError = truncate(msg, 200)
	if err := s.db.Model(acct).Update("sync_error", acct.SyncError).Error; err != nil {
		log.Printf("calendar: recording a sync failure: %v", err)
	}
	log.Printf("calendar: syncing account %d: %s", acct.ID, acct.SyncError)
}

// Disconnect revokes our access, stops the push channel and deletes the account and
// every event pulled from it. Blocks written back to it stay in the user's Google
// calendar; we just forget the link to them.
func (s *Service) Disconnect(ctx context.Context, userID, accountID uint) error {
	defer s.lock(accountID)()
	var acct store.CalendarAccount
	if err := s.db.Where("id = ? AND user_id = ?", accountID, userID).First(&acct).Error; err != nil {
		return err
	}
	if p, ok := s.providers[acct.Provider]; ok {
		cred := credentialsOf(acct)
		if acct.ChannelID != "" {
			if err := p.StopWatch(ctx, cred, Channel{ID: acct.ChannelID, ResourceID: acct.ChannelResource}); err != nil {
				log.Printf("calendar: stopping the channel of account %d: %v", acct.ID, scrub(err, cred))
			}
		}
		if err := p.Revoke(ctx, cred); err != nil {
			log.Printf("calendar: revoking account %d: %v", acct.ID, scrub(err, cred))
		}
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("account_id = ?", acct.ID).Delete(&store.CalendarEvent{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&store.ScheduledSession{}).Where("calendar_account_id = ?", acct.ID).
			Updates(map[string]any{"calendar_account_id": nil, "external_event_id": ""}).Error; err != nil {
			return err
		}
		return tx.Delete(&acct).Error
	})
	if err == nil {
		s.hub.Publish(userID, events.Event{Type: "calendar.synced", Data: map[string]any{"account_id": acct.ID, "changed": 1}})
		if s.AfterSync != nil {
			s.AfterSync(ctx, userID)
		}
	}
	return err
}

// Events returns the user's stored events overlapping [from, to), leaving out the blocks
// we wrote back ourselves: those are focus time, not meetings.
func Events(db *gorm.DB, userID uint, from, to time.Time) ([]store.CalendarEvent, error) {
	events := []store.CalendarEvent{}
	err := db.Where("user_id = ? AND starts_at < ? AND ends_at > ? AND owned_by_us = ?", userID, to.UTC(), from.UTC(), false).
		Order("starts_at, id").Find(&events).Error
	return events, err
}

func credentialsOf(acct store.CalendarAccount) *Credentials {
	return &Credentials{Account: acct.ExternalID, AccessToken: string(acct.AccessToken), RefreshToken: string(acct.RefreshToken), Expiry: acct.Expiry}
}
