// Command server runs the Brew Focus API and, in production, serves the built Angular app.
//
//	go run ./cmd/server                                        # API only, for `ng serve`
//	go run ./cmd/server -static ../frontend/dist/brew-focus/browser
//
// Environment: JWT_SECRET signs login cookies (required in production),
// SECURE_COOKIES=true when served over HTTPS. Calendar, assistant and push settings are
// read in config.go; each feature is optional and the app runs with none of them set.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata" // every user's IANA zone resolves, whatever the container ships

	"golang.org/x/sync/errgroup"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/api"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/calendar"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/demo"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/plans"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/scheduler"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/store"
)

func main() {
	addr := flag.String("addr", envOr("ADDR", ":5001"), "listen address (macOS reserves :5000 for AirPlay)")
	dbPath := flag.String("db", envOr("DB_PATH", "brewfocus.db"), "SQLite database file")
	static := flag.String("static", os.Getenv("STATIC_DIR"), "directory of the built frontend to serve (optional)")
	flag.Parse()

	if err := run(*addr, *dbPath, *static); err != nil {
		log.Fatal(err)
	}
}

func run(addr, dbPath, static string) error {
	secret := []byte(os.Getenv("JWT_SECRET"))
	if len(secret) == 0 {
		secret = make([]byte, 32)
		_, _ = rand.Read(secret)
		log.Print("JWT_SECRET not set: using a random key, so everyone is logged out when the server restarts")
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return err
	}
	if err := cfg.checkSealedAccounts(db); err != nil {
		return err
	}

	// One context for everything: Ctrl+C/SIGTERM, or any component failing, stops them all.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	g, ctx := errgroup.WithContext(ctx)

	hub := events.NewHub()
	g.Go(func() error { hub.Run(ctx); return nil })

	timers := engine.New(ctx, db, hub)
	if err := timers.Restore(); err != nil {
		return err
	}

	cal := calendar.NewService(db, hub, cfg.calendarOptions())
	if os.Getenv("DEMO") == "true" {
		if err := demo.Seed(ctx, db, cal, demoCalendar, time.Now()); err != nil {
			return err
		}
		log.Printf("demo: sign in as %s / %s", demo.Email, demo.Password)
	}
	g.Go(func() error { return cal.Run(ctx) })        // debounced syncs, or polling without PUBLIC_URL
	g.Go(func() error { return cal.RunRenewer(ctx) }) // push channels expire after about a week

	planSvc := plans.New(db, hub)
	// After a sync changes a calendar, check accepted blocks against it.
	cal.AfterSync = func(ctx context.Context, userID uint) {
		if err := planSvc.Reconcile(ctx, userID); err != nil {
			log.Printf("plans: reconciling user %d: %v", userID, err)
		}
	}
	writer := cal.NewWriter() // copies accepted blocks to a "Brew Focus" calendar when write-back is on
	planSvc.Calendar = writer
	g.Go(func() error { return writer.Run(ctx) })
	dispatcher := scheduler.New(db, hub, timers)
	planSvc.OnChange = dispatcher.Wake // a block accepted one minute out still gets its warning
	g.Go(func() error { dispatcher.Run(ctx.Done()); return nil })

	srv := &http.Server{
		Addr: addr,
		Handler: api.NewRouter(api.Deps{
			DB: db, Hub: hub, Engine: timers, Calendar: cal, Plans: planSvc, Dispatcher: dispatcher,
			Assistant: cfg.newAssistant(db, planSvc),
			Auth:      auth.NewManager(secret, os.Getenv("SECURE_COOKIES") == "true"),
		}, static),
		ReadHeaderTimeout: 5 * time.Second,
	}
	g.Go(func() error {
		host := addr
		if strings.HasPrefix(addr, ":") {
			host = "localhost" + addr
		}
		log.Printf("Brew Focus listening on http://%s", host)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	})
	g.Go(func() error {
		<-ctx.Done()
		// The hub has closed every event stream by now, so in-flight requests drain quickly.
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := srv.Shutdown(shutdown)
		timers.Wait()
		log.Print("stopped cleanly")
		return err
	})
	return g.Wait()
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
