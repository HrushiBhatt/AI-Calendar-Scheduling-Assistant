<p align="center"><img src="docs/assets/hero.svg" alt="Brew Focus: a pixel-art mug drains as the timer counts down, then refills on a break" width="100%"/></p>

A pomodoro timer and productivity tracker with a Go backend. Timers run on the server, so a session keeps going when you close the tab and stays in sync across every device you're signed in on.

**[Try it in your browser](https://hrushibhatt.github.io/BrewFocus/)**, or run the full app with Docker:

```bash
cp .env.example .env                 # then set JWT_SECRET: openssl rand -hex 32
docker compose up --build            # http://localhost:5001
```

![A focus block from start to finish: pick a task, set an intention, the mug drains, write a reflection, the mug refills on the break, and the session appears on the Progress page](docs/assets/demo.gif)

<img src="docs/assets/stats.svg" alt="One process to run, 5.6 KB per running timer, a 27 MB static binary, 50 Go tests and 54 frontend tests" width="100%"/>

## Why Go

A timer app looks simple, but it has a hard requirement: many timers running at once, each of which can be paused from any device at the exact moment it expires. That's a concurrency problem, and concurrency is what Go was built for.

<img src="docs/assets/architecture.svg" alt="Angular talks to one Go process over HTTP with a JWT cookie. Gin routes to auth and the timer engine, which use SQLite through GORM. The event hub sends live updates back. The GitHub Pages build uses the same screens with an in-browser store." width="100%"/>

| Go feature or tool | What it does here | Why it fits |
|---|---|---|
| **Goroutines** | One for every running timer | Cheap enough to give each timer its own, so its logic reads top to bottom |
| **Channels and `select`** | Carry pause, resume and finish commands to each timer | A pause and an expiring deadline are handled one at a time, so they can't race |
| **`context` and `errgroup`** | Stop everything together on shutdown | A restart never cuts a request off or loses a timer |
| **`net/http` with Gin** | Routes, middleware and JSON validation | Each request already runs on its own goroutine, and Gin adds only what's missing |
| **GORM with pure-Go SQLite** | Tables and queries | No database server to run, and bound parameters rule out SQL injection |
| **`golang-jwt` and `x/crypto/bcrypt`** | Sessions and password hashing | Well-reviewed libraries, so the sensitive parts aren't hand-written |
| **Static binaries** | One file with no dependencies | The Docker image needs almost nothing else inside it |
| **`go test -race`** | Runs on every push | Catches data races as a test failure instead of a production mystery |
| **`govulncheck`, `gosec`, `go vet`** | Run in CI | Vulnerability and code scanning come from the Go ecosystem itself |

## A goroutine per timer

<img src="docs/assets/goroutines.svg" alt="Request handlers send commands over channels to one goroutine per timer. Each timer publishes to one event hub goroutine, which sends live updates to every open tab and device." width="100%"/>

Each timer owns its state, and only its own goroutine touches it, so that state needs no locks. Its `select` waits on three things: a command, its deadline, or shutdown. See [`internal/engine`](backend/internal/engine/engine.go).

Updates reach the browser over Server-Sent Events rather than WebSockets. Clients only listen, since commands go over normal HTTP, and browsers reconnect to SSE on their own.

<img src="docs/assets/chart-memory.svg" alt="Memory for running timers on an Apple M2: 1 MB for 100, 5.7 MB for 1,000, and 55.1 MB for 10,000" width="100%"/>

Measured with `BenchmarkRunningTimers`, each timer's in-memory database row included.

## JWT sign-in

<img src="docs/assets/jwt.svg" alt="Sign-in checks the password with bcrypt, then sets a signed JWT in an HttpOnly cookie and saves a session row. Every request checks the signature and that the row still exists, so signing out takes effect at once." width="100%"/>

| Choice | Why |
|---|---|
| JWT in an HttpOnly cookie, not `localStorage` | An injected script can't read it, so it can't steal it |
| A session row behind each JWT | A JWT alone can't be taken back before it expires. Deleting the row makes logging out instant |
| HS256 with one secret | Only one service verifies tokens, so public-key signing would add keys to manage for nothing |
| The algorithm is pinned when verifying | A forged token can't choose its own, such as `none` |
| The server won't start without a strong key in production | A guessable key would let anyone forge a session |

<img src="docs/assets/screen-login.png" alt="The sign-in page: the mug and name on the left, the log in and sign up form on the right" width="100%"/>

## Docker

<img src="docs/assets/docker.svg" alt="A multi-stage Docker build: Node builds the Angular app and Go builds a static binary. Only those two results go into the final image, which has no shell and runs as a non-root user." width="100%"/>

The multi-stage build uses Node and the Go compiler but ships neither. With no shell or package manager in the image, there's little for an attacker to use. Compose keeps the database in a named volume, and runs the container read-only with no extra privileges.

## Two ways to run, one set of screens

GitHub Pages only serves static files, so it can't run Go. The [Pages build](https://hrushibhatt.github.io/BrewFocus/) swaps the server for an in-browser store that answers the same `/api` calls and saves to `localStorage`.

| | Go server | GitHub Pages |
|---|---|---|
| **Sign-in** | JWT | None needed |
| **Data** | SQLite on the server | This browser only |
| **Timers** | Run on the server | Saved deadline, in the browser |
| **Sync** | Every device | Tabs in one browser |
| **Runs on** | Docker, or any server | Static hosting |

The screens can't tell which one they're talking to, so there's only one UI to maintain.

## A deadline, not a counter

<img src="docs/assets/timer.svg" alt="Illustration: a counter falls behind when a tab is in the background or closed, while a saved deadline stays right" width="100%"/>

Timers save when they end rather than counting down. A background tab, a closed laptop or a server restart can't lose time, and a block that ran out during a restart is credited when the server comes back.

## One flow for every block

<img src="docs/assets/flow.svg" alt="The cycle: intention, optional breathing, focus while the mug drains, a one-line reflection, then a break while it refills" width="100%"/>

An intention gives a block a purpose, and a reflection makes it count for more than minutes.

<img src="docs/assets/screen-progress.png" alt="The Progress page: totals and streaks, a year heatmap, a café that fills as you finish brews, and a journal" width="100%"/>

## Security

<img src="docs/assets/security.svg" alt="A strict page policy lets in only this site's own files. On the server, passwords are hashed with bcrypt, the JWT is in an HttpOnly cookie, changes need a CSRF token, sign-ins are rate limited and every query is scoped to its user." width="100%"/>

Tests cover each of these, including forged JWTs and one user reaching for another's data.

## Kept simple on purpose

<img src="docs/assets/chart-code.svg" alt="Lines of code: about 27,800 with calendar and Claude, and about 9,900 now" width="100%"/>

This app once had Google Calendar and an AI planner. They were removed because a timer doesn't need them, and the backend is now only what a timer and tracker require.

<img src="docs/assets/chart-size.svg" alt="What a visitor downloads, compressed: about 103 kB on first load, at most 81 kB of fonts, 6.5 kB for the Brew page and 4.2 kB for the Progress page when opened" width="100%"/>

## Every push is tested

<img src="docs/assets/deploy.svg" alt="Every push to main: scan for secrets and vulnerabilities, tests under the race detector, browser tests, then publish the Pages build" width="100%"/>

A failed check leaves the live site as it was. The Docker image is built and scanned alongside, on its own, so a newly published vulnerability in a base image can't take the site offline. The full app isn't hosted anywhere public yet: that image can run on any host that runs containers.

## The code

```
backend/
  cmd/server/          startup, configuration, graceful shutdown
  internal/
    api/               HTTP routes, one file per resource
      middleware/      security headers, size limits, rate limits
    auth/              JWT sessions, bcrypt, CSRF
    engine/            the timers: one goroutine each
    events/            live updates to every open tab
    store/             database models and SQLite setup
frontend/src/app/
  core/
    api/               API client, data shapes, live event stream
    auth/              the signed-in user and route guards
    browser/           the in-browser store, for the Pages build only
    state/             Brew (the focus flow), the timer display
    sound/, theme/     synthesized ambience, light and dark
  features/            brew, tasks, progress, focus-flow, settings, login
  shared/              dialog frame, pipes, pixel art
frontend/e2e/          browser tests against the Go server
frontend/e2e-pages/    browser tests against the Pages build
```

Each Go package starts with a comment explaining its design decisions.

| Command | What it does |
|---|---|
| `make install` | Download dependencies |
| `make api` and `make web` | Run the API on :5001 and the app on :4200 |
| `make serve` | Build everything and serve it from one Go process on :5001 |
| `make docker` | Run the app with Docker Compose |
| `make test` | Go tests under the race detector, then frontend unit tests |
| `make e2e` | Browser tests against the real Go server |
| `make audit` | Vulnerability, code and secret scans |
| `make pages` | Run the browser-only build |

[Changelog](CHANGELOG.md)
