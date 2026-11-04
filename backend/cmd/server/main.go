// Command server runs the Brew Focus API and, in production, serves the built Angular app.
//
//	go run ./cmd/server                                        # API only, for `ng serve`
//	go run ./cmd/server -static ../frontend/dist/brew-focus/browser
//
// Settings come from the environment and are read in config.go. Only JWT_SECRET is needed in
// production; everything else is optional.
package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/api"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/auth"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/demo"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/engine"
	"github.com/HrushiBhatt/Productivity-Manager/backend/internal/events"
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

// run starts every component and blocks until they have all stopped.
func run(addr, dbPath, static string) error {
	secret, err := sessionSecret(os.Getenv("JWT_SECRET"), os.Getenv("GIN_MODE"))
	if err != nil {
		return err
	}
	secure := os.Getenv("SECURE_COOKIES") == "true"
	if !secure && os.Getenv("GIN_MODE") == "release" {
		log.Print("SECURE_COOKIES is not true: fine on localhost, but set it whenever this is served over HTTPS")
	}

	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return err
	}

	// One context for everything: Ctrl+C/SIGTERM, or any component failing, stops them all.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	g, ctx := errgroup.WithContext(ctx)

	// The hub fans events out to every open tab; the engine runs the timers and publishes to it.
	hub := events.NewHub()
	g.Go(func() error { hub.Run(ctx); return nil })

	timers := engine.New(ctx, db, hub)
	if err := timers.Restore(); err != nil { // timers that were running keep going after a restart
		return err
	}

	if os.Getenv("DEMO") == "true" {
		if err := demo.Seed(db, time.Now()); err != nil {
			return err
		}
		log.Printf("demo: sign in as %s / %s", demo.Email, demo.Password)
		if os.Getenv("GIN_MODE") == "release" {
			log.Print("demo: DEMO=true in release mode: anyone can sign in to the demo account with this public password")
		}
	}

	srv := &http.Server{
		Addr: addr,
		Handler: api.NewRouter(api.Deps{
			DB: db, Hub: hub, Engine: timers,
			Auth:           auth.NewManager(secret, secure, db),
			Login:          cfg.newLogin(ctx),
			TrustedProxies: cfg.trustedProxies,
		}, static),
		// No overall read or write timeout: event streams stay open for hours. Headers are
		// bounded here, and bodies by the middleware.
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    64 << 10,
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

// envOr returns an environment variable, or fallback when it's unset.
func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
