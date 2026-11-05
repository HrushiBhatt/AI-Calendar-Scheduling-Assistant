// Command server runs the Brew Focus API and, in production, serves the built Angular app.
//
//	go run ./cmd/server                                        # API only, for `ng serve`
//	go run ./cmd/server -static ../frontend/dist/brew-focus/browser
//
// Design decisions:
//
//   - One process serves the API and the app. There's nothing else to run or connect, and the
//     browser sees one origin, so no cross-origin setup is needed.
//   - errgroup and a shared context tie the parts together: Ctrl+C or SIGTERM, or any part
//     failing, stops them all in order, so a deploy never cuts a request or a timer off.
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

	"github.com/HrushiBhatt/BrewFocus/backend/internal/api"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/auth"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/engine"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/events"
	"github.com/HrushiBhatt/BrewFocus/backend/internal/store"
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
	proxies, err := parseProxies(os.Getenv("TRUSTED_PROXIES"))
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

	srv := &http.Server{
		Addr: addr,
		Handler: api.NewRouter(api.Deps{
			DB: db, Hub: hub, Engine: timers,
			Auth:           auth.NewManager(secret, secure, db),
			TrustedProxies: proxies,
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
