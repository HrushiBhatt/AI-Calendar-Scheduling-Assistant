package calendar

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Fake is an in-memory Provider. Tests script its change list; the seeded demo account
// and the end-to-end test use it so neither needs Google. It is safe for concurrent use.
type Fake struct {
	name    string
	account string // the account Exchange signs in as

	mu      sync.Mutex
	cals    map[string]*fakeCal         // the "remote" primary calendars, by account
	written map[string]map[string]Event // write-back: calendar ID -> event ID -> event
	expired map[string]bool             // the account's next incremental sync gets a 410
	watches int
	stopped []string
	revoked []string
	syncs   int
	SyncErr error // when set, Sync fails with it
	nextCal int
}

type fakeCal struct {
	events  map[string]Event
	log     []fakeChange
	version int
}

type fakeChange struct {
	version int
	id      string
}

// NewFake returns a provider called name whose OAuth flow signs in as account.
func NewFake(name, account string) *Fake {
	return &Fake{name: name, account: account, cals: map[string]*fakeCal{}, written: map[string]map[string]Event{}, expired: map[string]bool{}}
}

func (f *Fake) Name() string { return f.name }

// AuthURL points straight back at our own callback: there is no consent screen to visit.
func (f *Fake) AuthURL(state string) string {
	return "/api/calendar/callback?code=fake-code&state=" + url.QueryEscape(state)
}

func (f *Fake) Exchange(_ context.Context, code string) (*Credentials, error) {
	if code != "fake-code" {
		return nil, errors.New("fake: unknown authorization code")
	}
	return &Credentials{Account: f.account, AccessToken: "fake-access-" + randomID(), RefreshToken: "fake-refresh-" + randomID(),
		Expiry: time.Now().Add(time.Hour)}, nil
}

func (f *Fake) cal(account string) *fakeCal {
	c := f.cals[account]
	if c == nil {
		c = &fakeCal{events: map[string]Event{}}
		f.cals[account] = c
	}
	return c
}

// Put adds or changes an event on account's remote calendar.
func (f *Fake) Put(account string, e Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cal(account)
	c.version++
	c.events[e.ID] = e
	c.log = append(c.log, fakeChange{c.version, e.ID})
}

// Remove deletes an event from account's remote calendar.
func (f *Fake) Remove(account, id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.cal(account)
	c.version++
	delete(c.events, id)
	c.log = append(c.log, fakeChange{c.version, id})
}

// Reset replaces account's remote calendar, invalidating every cursor issued for it.
func (f *Fake) Reset(account string, events []Event) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := &fakeCal{events: map[string]Event{}, version: f.cal(account).version + 1000}
	for _, e := range events {
		c.events[e.ID] = e
	}
	f.cals[account] = c
}

// ExpireCursor makes account's next incremental sync fail the way Google's 410 Gone does.
func (f *Fake) ExpireCursor(account string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.expired[account] = true
}

func (f *Fake) Sync(_ context.Context, cred *Credentials, cursor string, window Window) (Changes, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.syncs++
	if f.SyncErr != nil {
		return Changes{}, f.SyncErr
	}
	c := f.cal(cred.Account)
	next := strconv.Itoa(c.version)
	if cursor == "" {
		var out Changes
		for _, e := range c.events {
			if e.Start.Before(window.End) && e.End.After(window.Start) {
				out.Upserted = append(out.Upserted, e)
			}
		}
		slices.SortFunc(out.Upserted, func(a, b Event) int { return strings.Compare(a.ID, b.ID) })
		out.NextCursor = next
		return out, nil
	}
	since, err := strconv.Atoi(cursor)
	if err != nil || since > c.version || since < c.version-len(c.log) || f.expired[cred.Account] {
		f.expired[cred.Account] = false
		return Changes{FullResync: true}, nil
	}
	var out Changes
	seen := map[string]bool{}
	for i := len(c.log) - 1; i >= 0; i-- { // newest first, so each event reports its final state
		ch := c.log[i]
		if ch.version <= since || seen[ch.id] {
			continue
		}
		seen[ch.id] = true
		if e, ok := c.events[ch.id]; ok {
			out.Upserted = append(out.Upserted, e)
		} else {
			out.DeletedIDs = append(out.DeletedIDs, ch.id)
		}
	}
	out.NextCursor = next
	return out, nil
}

func (f *Fake) Watch(_ context.Context, _ *Credentials, _, _ string) (Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.watches++
	return Channel{ID: "fake-channel-" + randomID(), ResourceID: "fake-resource", Expiry: time.Now().Add(7 * 24 * time.Hour).UTC()}, nil
}

func (f *Fake) StopWatch(_ context.Context, _ *Credentials, ch Channel) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped = append(f.stopped, ch.ID)
	return nil
}

func (f *Fake) Revoke(_ context.Context, cred *Credentials) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.revoked = append(f.revoked, cred.Account)
	return nil
}

func (f *Fake) EnsureCalendar(_ context.Context, _ *Credentials, _, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextCal++
	id := fmt.Sprintf("fake-cal-%d", f.nextCal)
	f.written[id] = map[string]Event{}
	return id, nil
}

func (f *Fake) CreateEvent(_ context.Context, _ *Credentials, calID string, e Event) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cal, ok := f.written[calID]
	if !ok {
		return "", ErrNotFound
	}
	e.ID = "fake-event-" + randomID()
	e.OwnedByUs = true
	cal[e.ID] = e
	return e.ID, nil
}

func (f *Fake) UpdateEvent(_ context.Context, _ *Credentials, calID, eventID string, e Event) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cal, ok := f.written[calID]
	if !ok {
		return ErrNotFound
	}
	if _, ok := cal[eventID]; !ok {
		return ErrNotFound
	}
	e.ID, e.OwnedByUs = eventID, true
	cal[eventID] = e
	return nil
}

func (f *Fake) DeleteEvent(_ context.Context, _ *Credentials, calID, eventID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.written[calID], eventID)
	return nil
}

// DropCalendar deletes a calendar we wrote to, as a user deleting it in Google would.
func (f *Fake) DropCalendar(calID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.written, calID)
}

// Written returns the events written back to calendar calID, sorted by start.
func (f *Fake) Written(calID string) []Event {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Event
	for _, e := range f.written[calID] {
		out = append(out, e)
	}
	slices.SortFunc(out, func(a, b Event) int { return a.Start.Compare(b.Start) })
	return out
}

// Stats reports how often the fake was called, for tests.
func (f *Fake) Stats() (syncs, watches int, stopped, revoked []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.syncs, f.watches, slices.Clone(f.stopped), slices.Clone(f.revoked)
}

func randomID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
