package main

import (
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"gorm.io/gorm"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/assistant"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

// config is the optional-feature configuration. Every feature degrades on its own: no
// Google keys means no calendar (the planner works off an empty busy set), no Anthropic
// key means the form path, no PUBLIC_URL means polling instead of push.
type config struct {
	googleID, googleSecret, googleRedirect string
	calendarProvider                       string // "fake" connects to an in-memory calendar (end-to-end tests)
	publicURL                              string
	anthropicKey                           string
	assistantProvider                      string // "stub" uses the phrase-matching stand-in (end-to-end tests)
	assistant                              assistant.Options
}

func loadConfig() (*config, error) {
	c := &config{
		googleID:          os.Getenv("GOOGLE_CLIENT_ID"),
		googleSecret:      os.Getenv("GOOGLE_CLIENT_SECRET"),
		googleRedirect:    os.Getenv("GOOGLE_REDIRECT_URL"),
		calendarProvider:  os.Getenv("CALENDAR_PROVIDER"),
		publicURL:         strings.TrimRight(os.Getenv("PUBLIC_URL"), "/"),
		anthropicKey:      os.Getenv("ANTHROPIC_API_KEY"),
		assistantProvider: os.Getenv("ASSISTANT_PROVIDER"),
		assistant:         assistant.Options{Model: os.Getenv("ASSISTANT_MODEL"), Effort: os.Getenv("ASSISTANT_EFFORT")},
	}
	if raw := os.Getenv("ASSISTANT_DAILY_TOKENS"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			return nil, errors.New("ASSISTANT_DAILY_TOKENS must be a positive whole number")
		}
		c.assistant.DailyTokens = n
	}
	if c.assistantProvider != "" && c.assistantProvider != "stub" {
		return nil, fmt.Errorf("ASSISTANT_PROVIDER must be empty or \"stub\", not %q", c.assistantProvider)
	}
	set := 0
	for _, v := range []string{c.googleID, c.googleSecret, c.googleRedirect} {
		if v != "" {
			set++
		}
	}
	if set != 0 && set != 3 {
		return nil, errors.New("set all of GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URL, or none of them")
	}
	if err := store.SetSealKey(os.Getenv("CALENDAR_ENC_KEY")); err != nil {
		return nil, err
	}
	if c.google() && !store.HasSealKey() {
		return nil, errors.New("CALENDAR_ENC_KEY is required when Google Calendar is configured (openssl rand -hex 32)")
	}
	if c.calendarProvider != "" && c.calendarProvider != "fake" {
		return nil, fmt.Errorf("CALENDAR_PROVIDER must be empty or \"fake\", not %q", c.calendarProvider)
	}
	if c.calendarProvider == "fake" && !store.HasSealKey() {
		return nil, errors.New("CALENDAR_ENC_KEY is required with CALENDAR_PROVIDER=fake too: its tokens are sealed like real ones")
	}
	if c.publicURL != "" {
		u, err := url.Parse(c.publicURL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return nil, errors.New("PUBLIC_URL must be an https:// URL that Google can reach (or unset, to poll)")
		}
	}
	switch {
	case c.google():
		log.Print("calendar: Google Calendar enabled")
	case c.calendarProvider == "fake":
		log.Print("calendar: CALENDAR_PROVIDER=fake, connecting to an in-memory calendar")
	default:
		log.Print("calendar: no Google keys, so connecting a calendar is off (the demo account still works)")
	}
	if c.publicURL == "" {
		log.Printf("calendar: PUBLIC_URL not set, so calendars are polled every %v instead of pushed", calendar.PollEvery)
	}
	switch {
	case c.anthropicKey != "":
		model := c.assistant.Model
		if model == "" {
			model = assistant.DefaultModel
		}
		log.Printf("assistant: enabled with %s", model)
	case c.assistantProvider == "stub":
		log.Print("assistant: ASSISTANT_PROVIDER=stub, using the phrase-matching stand-in (not a model)")
	default:
		log.Print("assistant: no ANTHROPIC_API_KEY, so plain-language requests fall back to the planning form")
	}
	return c, nil
}

// newAssistant builds the assistant, or returns nil when there is none to build.
func (c *config) newAssistant(db *gorm.DB, planSvc *plans.Service) *assistant.Assistant {
	switch {
	case c.anthropicKey != "":
		// One retry, then the degraded path; a slow request gives up rather than hanging.
		client := anthropic.NewClient(option.WithAPIKey(c.anthropicKey), option.WithMaxRetries(1), option.WithRequestTimeout(20*time.Second))
		return assistant.New(&client.Messages, db, planSvc, c.assistant)
	case c.assistantProvider == "stub":
		return assistant.New(assistant.Stub{}, db, planSvc, c.assistant)
	}
	return nil
}

func (c *config) google() bool { return c.googleID != "" }

// checkSealedAccounts refuses to start without the key once tokens are stored: running on
// would fail every sync with a decryption error instead of saying what is wrong.
func (c *config) checkSealedAccounts(db *gorm.DB) error {
	if store.HasSealKey() {
		return nil
	}
	var n int64
	if err := db.Model(&store.CalendarAccount{}).Where("length(refresh_token) > 0").Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return fmt.Errorf("CALENDAR_ENC_KEY is not set, but %d connected calendar account(s) have tokens encrypted with it", n)
	}
	return nil
}

// Demo is the provider behind the seeded demo account: an in-memory calendar, no OAuth.
var demoCalendar = calendar.NewFake("demo", "demo@brewfocus.dev")

func (c *config) calendarOptions() calendar.Options {
	opts := calendar.Options{PublicURL: c.publicURL, Providers: []calendar.Provider{demoCalendar}}
	switch {
	case c.google():
		opts.Providers = append(opts.Providers, calendar.NewGoogle(c.googleID, c.googleSecret, c.googleRedirect))
		opts.ConnectVia = "google"
	case c.calendarProvider == "fake":
		opts.Providers = append(opts.Providers, calendar.NewFake("fake", "you@example.com"))
		opts.ConnectVia = "fake"
	}
	return opts
}
