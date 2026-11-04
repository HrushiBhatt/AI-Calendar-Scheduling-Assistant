package calendar

import (
	"context"
	"crypto/subtle"
	"log"
	"sync"
	"time"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

const (
	// PollEvery is how often accounts sync when there is no public URL for push notifications.
	PollEvery = 5 * time.Minute
	// RenewWithin renews a push channel this close to its expiry. Google channels last about a week.
	RenewWithin = 24 * time.Hour
	renewEvery  = time.Hour
)

// PushPath is the webhook route Google notifies.
const PushPath = "/api/calendar/push"

// queue coalesces sync requests per account. The first request for an account schedules
// a sync one window later; requests arriving inside that window join it. A meeting being
// dragged around fires several notifications, and they become one sync.
type queue struct {
	window  time.Duration
	mu      sync.Mutex
	pending map[uint]bool
	ready   chan uint
	done    chan struct{}
	once    sync.Once
}

func newQueue(window time.Duration) *queue {
	return &queue{window: window, pending: map[uint]bool{}, ready: make(chan uint, 64), done: make(chan struct{})}
}

func (q *queue) add(accountID uint) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.pending[accountID] {
		return
	}
	q.pending[accountID] = true
	time.AfterFunc(q.window, func() {
		q.mu.Lock()
		delete(q.pending, accountID)
		q.mu.Unlock()
		select {
		case q.ready <- accountID:
		case <-q.done:
		}
	})
}

func (q *queue) stop() { q.once.Do(func() { close(q.done) }) }

// Enqueue asks for a debounced sync of one account.
func (s *Service) Enqueue(accountID uint) { s.queue.add(accountID) }

// Run drains the sync queue until ctx is cancelled. Without a public URL there are no
// push notifications, so it also polls every account every PollEvery, which keeps the
// feature developable on a laptop without a tunnel.
func (s *Service) Run(ctx context.Context) error {
	defer s.queue.stop()
	var poll <-chan time.Time
	if s.publicURL == "" {
		t := time.NewTicker(PollEvery)
		defer t.Stop()
		poll = t.C
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case id := <-s.queue.ready:
			if err := s.Sync(ctx, id); err != nil && ctx.Err() == nil {
				log.Printf("calendar: queued sync of account %d: %v", id, err)
			}
		case <-poll:
			var ids []uint
			if err := s.db.Model(&store.CalendarAccount{}).Order("id").Pluck("id", &ids).Error; err != nil {
				log.Printf("calendar: polling: %v", err)
				continue
			}
			for _, id := range ids {
				if ctx.Err() != nil {
					return nil
				}
				if err := s.Sync(ctx, id); err != nil {
					log.Printf("calendar: polled sync of account %d: %v", id, err)
				}
			}
		}
	}
}

// Notify handles one push notification. The webhook is unauthenticated (Google has no
// session), so a notification counts only if its channel ID is one we registered and its
// token matches the random one stored with it. It never syncs inline: it enqueues, and
// the handler returns at once. It reports whether the notification was accepted.
func (s *Service) Notify(channelID, token, resourceState string) bool {
	if channelID == "" || token == "" {
		return false
	}
	var acct store.CalendarAccount
	if err := s.db.Where("channel_id = ?", channelID).Limit(1).Find(&acct).Error; err != nil || acct.ID == 0 {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(token), []byte(acct.ChannelToken)) != 1 {
		return false
	}
	if resourceState == "sync" {
		return true // the handshake Google sends when a channel opens; nothing changed yet
	}
	s.Enqueue(acct.ID)
	return true
}

// Watch registers (or re-registers) the account's push channel and stops the old one.
// Without a public URL it does nothing: Run polls instead.
func (s *Service) Watch(ctx context.Context, accountID uint) error {
	if s.publicURL == "" {
		return nil
	}
	defer s.lock(accountID)()
	var acct store.CalendarAccount
	if err := s.db.First(&acct, accountID).Error; err != nil {
		return err
	}
	p, ok := s.providers[acct.Provider]
	if !ok {
		return nil
	}
	cred := credentialsOf(acct)
	token := randomID() + randomID()
	ch, err := p.Watch(ctx, cred, s.publicURL+PushPath, token)
	if err != nil {
		return scrub(err, cred)
	}
	if acct.ChannelID != "" {
		if err := p.StopWatch(ctx, cred, Channel{ID: acct.ChannelID, ResourceID: acct.ChannelResource}); err != nil {
			log.Printf("calendar: stopping the old channel of account %d: %v", acct.ID, scrub(err, cred))
		}
	}
	acct.ChannelID, acct.ChannelToken, acct.ChannelResource, acct.ChannelExpiry = ch.ID, token, ch.ResourceID, ch.Expiry
	if cred.Refreshed {
		acct.AccessToken, acct.RefreshToken, acct.Expiry = []byte(cred.AccessToken), []byte(cred.RefreshToken), cred.Expiry
	}
	return s.db.Save(&acct).Error
}

// RunRenewer renews push channels that are within RenewWithin of expiring, checking
// hourly and once at startup, until ctx is cancelled.
func (s *Service) RunRenewer(ctx context.Context) error {
	if s.publicURL == "" {
		<-ctx.Done()
		return nil
	}
	t := time.NewTicker(renewEvery)
	defer t.Stop()
	for {
		s.RenewChannels(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// RenewChannels re-registers every channel close to expiry, plus any account that has
// none (its first registration failed).
func (s *Service) RenewChannels(ctx context.Context) {
	var ids []uint
	cutoff := s.now().Add(RenewWithin)
	err := s.db.Model(&store.CalendarAccount{}).Where("channel_id = '' OR channel_expiry < ?", cutoff).Order("id").Pluck("id", &ids).Error
	if err != nil {
		log.Printf("calendar: finding channels to renew: %v", err)
		return
	}
	for _, id := range ids {
		if err := s.Watch(ctx, id); err != nil {
			log.Printf("calendar: renewing the channel of account %d: %v", id, err)
		}
	}
}
