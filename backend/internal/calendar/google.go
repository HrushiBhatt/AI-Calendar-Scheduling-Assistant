package calendar

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
	gcal "google.golang.org/api/calendar/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"
)

// ownedKey marks events we create, in their private extended properties, so a sync can
// tell our focus blocks from the user's meetings even if one lands on a synced calendar.
const ownedKey = "brewfocus"

// Google reads the user's primary calendar and writes to a calendar of our own.
// Scopes: calendar.readonly for ingestion and calendar.app.created for write-back, which
// limits writes to calendars and events this app created.
type Google struct {
	config *oauth2.Config
	// endpoint overrides the API base URL in tests.
	endpoint  string
	revokeURL string
	http      *http.Client // for the revoke call; nil means http.DefaultClient
}

// NewGoogle configures the provider from the OAuth client in the Google Cloud console.
func NewGoogle(clientID, clientSecret, redirectURL string) *Google {
	return &Google{
		config: &oauth2.Config{
			ClientID: clientID, ClientSecret: clientSecret, RedirectURL: redirectURL,
			Endpoint: google.Endpoint,
			Scopes:   []string{gcal.CalendarReadonlyScope, gcal.CalendarAppCreatedScope},
		},
		revokeURL: "https://oauth2.googleapis.com/revoke",
	}
}

func (g *Google) Name() string { return "google" }

// AuthURL asks for offline access with a forced consent screen: without both, Google
// issues no refresh token on a second connection and sync stops when the hour is up.
func (g *Google) AuthURL(state, verifier string) string {
	return g.config.AuthCodeURL(state, oauth2.AccessTypeOffline, oauth2.ApprovalForce, oauth2.S256ChallengeOption(verifier))
}

func (g *Google) Exchange(ctx context.Context, code, verifier string) (*Credentials, error) {
	tok, err := g.config.Exchange(ctx, code, oauth2.VerifierOption(verifier))
	if err != nil {
		return nil, scrub(fmt.Errorf("google: exchanging the code: %w", tokenError(err)), nil)
	}
	if tok.RefreshToken == "" {
		return nil, errors.New("google: no refresh token was issued; remove Brew Focus from your Google account's third-party access and connect again")
	}
	cred := &Credentials{AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, Expiry: tok.Expiry}
	svc, err := g.service(ctx, cred)
	if err != nil {
		return nil, err
	}
	primary, err := svc.Calendars.Get("primary").Context(ctx).Do()
	if err != nil {
		return nil, scrub(fmt.Errorf("google: reading the primary calendar: %w", err), cred)
	}
	cred.Account = primary.Id // the primary calendar's ID is the account's email
	return cred, nil
}

func (g *Google) Sync(ctx context.Context, cred *Credentials, cursor string, window Window) (Changes, error) {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return Changes{}, err
	}
	var out Changes
	page := ""
	for {
		call := svc.Events.List("primary").Context(ctx).SingleEvents(true).MaxResults(2500)
		if cursor == "" {
			call = call.TimeMin(window.Start.Format(time.RFC3339)).TimeMax(window.End.Format(time.RFC3339)).ShowDeleted(false)
		} else {
			call = call.SyncToken(cursor) // incremental: deletions arrive as status "cancelled"
		}
		if page != "" {
			call = call.PageToken(page)
		}
		res, err := call.Do()
		if err != nil {
			var gerr *googleapi.Error
			if errors.As(err, &gerr) && gerr.Code == http.StatusGone {
				// The sync token expired. Returning no changes here would silently freeze
				// the calendar, so tell the caller to clear its copy and pull again.
				return Changes{FullResync: true}, nil
			}
			return Changes{}, scrub(fmt.Errorf("google: listing events: %w", err), cred)
		}
		zone, _ := time.LoadLocation(res.TimeZone) // all-day dates are in the calendar's zone
		if zone == nil {
			zone = time.UTC
		}
		for _, item := range res.Items {
			e, keep, deleted := fromGoogle(item, zone)
			switch {
			case deleted:
				out.DeletedIDs = append(out.DeletedIDs, item.Id)
			case keep:
				out.Upserted = append(out.Upserted, e)
			}
		}
		if res.NextPageToken == "" {
			out.NextCursor = res.NextSyncToken
			return out, nil
		}
		page = res.NextPageToken
	}
}

// fromGoogle converts one event. keep is false for events that never block time and carry
// no planning context (working-location markers); deleted is true for cancellations.
func fromGoogle(item *gcal.Event, zone *time.Location) (e Event, keep, deleted bool) {
	if item.Status == "cancelled" {
		return Event{}, false, true
	}
	if item.EventType == "workingLocation" || item.Start == nil || item.End == nil {
		return Event{}, false, false
	}
	e = Event{ID: item.Id, Title: truncate(item.Summary, MaxTitle)}
	if item.Start.DateTime != "" {
		start, err1 := time.Parse(time.RFC3339, item.Start.DateTime)
		end, err2 := time.Parse(time.RFC3339, item.End.DateTime)
		if err1 != nil || err2 != nil {
			return Event{}, false, false
		}
		e.Start, e.End = start.UTC(), end.UTC()
	} else {
		start, err1 := time.ParseInLocation("2006-01-02", item.Start.Date, zone)
		end, err2 := time.ParseInLocation("2006-01-02", item.End.Date, zone)
		if err1 != nil || err2 != nil {
			return Event{}, false, false
		}
		e.Start, e.End, e.AllDay = start.UTC(), end.UTC(), true
	}
	declined := false
	for _, a := range item.Attendees {
		if a.Self && a.ResponseStatus == "declined" {
			declined = true
		}
	}
	e.Busy = item.Transparency != "transparent" && !declined
	e.OwnedByUs = item.ExtendedProperties != nil && item.ExtendedProperties.Private[ownedKey] == "1"
	return e, true, false
}

func (g *Google) Watch(ctx context.Context, cred *Credentials, callbackURL, token string) (Channel, error) {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return Channel{}, err
	}
	id := randomID()
	ch, err := svc.Events.Watch("primary", &gcal.Channel{Id: id, Type: "web_hook", Address: callbackURL, Token: token}).Context(ctx).Do()
	if err != nil {
		return Channel{}, scrub(fmt.Errorf("google: registering push notifications: %w", err), cred)
	}
	return Channel{ID: ch.Id, ResourceID: ch.ResourceId, Expiry: time.UnixMilli(ch.Expiration).UTC()}, nil
}

func (g *Google) StopWatch(ctx context.Context, cred *Credentials, ch Channel) error {
	if ch.ID == "" {
		return nil
	}
	svc, err := g.service(ctx, cred)
	if err != nil {
		return err
	}
	err = svc.Channels.Stop(&gcal.Channel{Id: ch.ID, ResourceId: ch.ResourceID}).Context(ctx).Do()
	if isGone(err) {
		return nil
	}
	return scrub(err, cred)
}

// Revoke withdraws the grant. Revoking the refresh token revokes the access token too.
func (g *Google) Revoke(ctx context.Context, cred *Credentials) error {
	token := cred.RefreshToken
	if token == "" {
		token = cred.AccessToken
	}
	form := url.Values{"token": {token}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.revokeURL, strings.NewReader(form.Encode()))
	if err != nil {
		return scrub(err, cred)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := g.http
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return scrub(fmt.Errorf("google: revoking access: %w", err), cred)
	}
	defer res.Body.Close()
	// 400 means the token is already invalid, which is the outcome we wanted.
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusBadRequest {
		return fmt.Errorf("google: revoking access: status %d", res.StatusCode)
	}
	return nil
}

func (g *Google) EnsureCalendar(ctx context.Context, cred *Credentials, name, timeZone string) (string, error) {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return "", err
	}
	cal, err := svc.Calendars.Insert(&gcal.Calendar{Summary: name, TimeZone: timeZone,
		Description: "Focus blocks scheduled by Brew Focus."}).Context(ctx).Do()
	if err != nil {
		return "", scrub(fmt.Errorf("google: creating the %s calendar: %w", name, err), cred)
	}
	return cal.Id, nil
}

func (g *Google) CreateEvent(ctx context.Context, cred *Credentials, calID string, e Event) (string, error) {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return "", err
	}
	created, err := svc.Events.Insert(calID, toGoogle(e)).Context(ctx).Do()
	if isGone(err) {
		return "", ErrNotFound // the user deleted our calendar
	}
	if err != nil {
		return "", scrub(fmt.Errorf("google: creating an event: %w", err), cred)
	}
	return created.Id, nil
}

func (g *Google) UpdateEvent(ctx context.Context, cred *Credentials, calID, eventID string, e Event) error {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return err
	}
	_, err = svc.Events.Patch(calID, eventID, toGoogle(e)).Context(ctx).Do()
	if isGone(err) {
		return ErrNotFound
	}
	return scrub(err, cred)
}

func (g *Google) DeleteEvent(ctx context.Context, cred *Credentials, calID, eventID string) error {
	svc, err := g.service(ctx, cred)
	if err != nil {
		return err
	}
	err = svc.Events.Delete(calID, eventID).Context(ctx).Do()
	if isGone(err) {
		return nil // already gone
	}
	return scrub(err, cred)
}

func toGoogle(e Event) *gcal.Event {
	return &gcal.Event{
		Summary:            e.Title,
		Description:        e.Description,
		Start:              &gcal.EventDateTime{DateTime: e.Start.UTC().Format(time.RFC3339)},
		End:                &gcal.EventDateTime{DateTime: e.End.UTC().Format(time.RFC3339)},
		Transparency:       "opaque",
		ExtendedProperties: &gcal.EventExtendedProperties{Private: map[string]string{ownedKey: "1"}},
		Reminders:          &gcal.EventReminders{UseDefault: false, ForceSendFields: []string{"UseDefault"}},
	}
}

// service builds an API client whose token source refreshes the access token as needed
// and records the new one on cred, so the caller can persist it.
func (g *Google) service(ctx context.Context, cred *Credentials) (*gcal.Service, error) {
	base := &oauth2.Token{AccessToken: cred.AccessToken, RefreshToken: cred.RefreshToken, Expiry: cred.Expiry, TokenType: "Bearer"}
	src := &recordingSource{src: g.config.TokenSource(ctx, base), cred: cred}
	opts := []option.ClientOption{option.WithHTTPClient(oauth2.NewClient(ctx, src))}
	if g.endpoint != "" {
		opts = append(opts, option.WithEndpoint(g.endpoint))
	}
	svc, err := gcal.NewService(ctx, opts...)
	return svc, scrub(err, cred)
}

// recordingSource copies a refreshed token back onto the credentials.
type recordingSource struct {
	mu   sync.Mutex
	src  oauth2.TokenSource
	cred *Credentials
}

func (r *recordingSource) Token() (*oauth2.Token, error) {
	tok, err := r.src.Token()
	if err != nil {
		return nil, scrub(fmt.Errorf("google: refreshing access: %w", tokenError(err)), r.cred)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if tok.AccessToken != r.cred.AccessToken {
		r.cred.AccessToken, r.cred.Expiry, r.cred.Refreshed = tok.AccessToken, tok.Expiry, true
		if tok.RefreshToken != "" {
			r.cred.RefreshToken = tok.RefreshToken
		}
	}
	return tok, nil
}

// tokenError reduces an oauth2 error to its error code: the raw response body is not
// something to keep in logs.
func tokenError(err error) error {
	var re *oauth2.RetrieveError
	if errors.As(err, &re) {
		status := 0
		if re.Response != nil {
			status = re.Response.StatusCode
		}
		if re.ErrorCode != "" {
			return fmt.Errorf("%s (status %d)", re.ErrorCode, status)
		}
		return fmt.Errorf("status %d", status)
	}
	return err
}

func isGone(err error) bool {
	var gerr *googleapi.Error
	return errors.As(err, &gerr) && (gerr.Code == http.StatusNotFound || gerr.Code == http.StatusGone)
}
