// Package calendar reads busy intervals from external calendars and, optionally, writes
// accepted focus blocks back to one. Google is the one implementation; the Provider
// interface is what an Outlook or CalDAV provider would implement, and what the tests fake.
package calendar

import (
	"context"
	"errors"
	"strings"
	"time"
)

// Provider is one external calendar service.
type Provider interface {
	Name() string
	// AuthURL and Exchange carry a PKCE verifier: the code is useless without it.
	AuthURL(state, verifier string) string
	Exchange(ctx context.Context, code, verifier string) (*Credentials, error)
	// Sync returns changes since the cursor. An empty cursor means a full pull of the window.
	Sync(ctx context.Context, cred *Credentials, cursor string, window Window) (Changes, error)
	// Watch registers a push channel; the provider echoes token on every notification.
	Watch(ctx context.Context, cred *Credentials, callbackURL, token string) (Channel, error)
	StopWatch(ctx context.Context, cred *Credentials, ch Channel) error
	// Revoke withdraws our access to the account entirely.
	Revoke(ctx context.Context, cred *Credentials) error
	// EnsureCalendar creates a calendar of our own for write-back and returns its ID.
	EnsureCalendar(ctx context.Context, cred *Credentials, name, timeZone string) (string, error)
	CreateEvent(ctx context.Context, cred *Credentials, calID string, e Event) (string, error)
	UpdateEvent(ctx context.Context, cred *Credentials, calID, eventID string, e Event) error
	DeleteEvent(ctx context.Context, cred *Credentials, calID, eventID string) error
}

// Credentials are one account's OAuth tokens. A provider may refresh them during a
// call; it then updates the fields in place and sets Refreshed, and the caller saves them.
type Credentials struct {
	Account      string // the account's email, from the exchange
	AccessToken  string
	RefreshToken string
	Expiry       time.Time
	Refreshed    bool
}

// Window is a span of time to pull events for.
type Window struct {
	Start, End time.Time
}

// Event is what we keep of a provider's event: only what scheduling needs.
type Event struct {
	ID        string
	Title     string
	Start     time.Time
	End       time.Time
	AllDay    bool
	Busy      bool // not transparent and not declined
	OwnedByUs bool // created by our write-back
	// Description is used only when writing an event back; it is never read from a provider.
	Description string
}

// Changes is the result of one sync.
type Changes struct {
	Upserted   []Event
	DeletedIDs []string
	NextCursor string
	FullResync bool // the cursor expired (Google's 410 Gone): clear and re-pull
}

// Channel is a registered push-notification channel.
type Channel struct {
	ID         string
	ResourceID string
	Expiry     time.Time
}

// ErrNotFound means the calendar or event no longer exists on the provider's side.
var ErrNotFound = errors.New("calendar: not found")

// MaxTitle is the longest event title stored.
const MaxTitle = 200

// truncate shortens s to at most n runes.
func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// scrub removes token material from an error message. Wrapped oauth2 and HTTP errors can
// echo request details, and these messages end up in logs and in SyncError.
func scrub(err error, cred *Credentials) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if cred != nil {
		for _, secret := range []string{cred.AccessToken, cred.RefreshToken} {
			if len(secret) >= 8 {
				msg = strings.ReplaceAll(msg, secret, "[redacted]")
			}
		}
	}
	for _, marker := range []string{"access_token=", "refresh_token=", "token=", "code="} {
		msg = redactAfter(msg, marker)
	}
	return scrubbed{msg: msg, cause: err}
}

// redactAfter replaces the value following each occurrence of marker (up to a delimiter).
func redactAfter(msg, marker string) string {
	var b strings.Builder
	for {
		i := strings.Index(msg, marker)
		if i < 0 {
			b.WriteString(msg)
			return b.String()
		}
		j := i + len(marker)
		k := j
		for k < len(msg) && !strings.ContainsRune("&\" \n,;", rune(msg[k])) {
			k++
		}
		b.WriteString(msg[:j])
		if k > j {
			b.WriteString("[redacted]")
		}
		msg = msg[k:]
	}
}

// scrubbed keeps errors.Is working for sentinel errors without printing the original text.
type scrubbed struct {
	msg   string
	cause error
}

func (s scrubbed) Error() string { return s.msg }
func (s scrubbed) Is(target error) bool {
	return errors.Is(s.cause, target)
}
