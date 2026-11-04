# Architecture

This document explains how Brew Focus is built and why: the goals behind it, the decisions that follow from them, what they cost, and what comes next. The [README](README.md) shows what the app does. The [changelog](CHANGELOG.md) records what changed and when.

## The idea behind the design

Brew Focus began as a browser-only Pomodoro timer. Its calendar-aware planner is built around one question: **how do you add an AI feature to a product without making the product unreliable?**

The answer the design commits to is to keep the model away from anything that has to be correct. The model understands language. Ordinary, tested code makes every decision.

## Goals, in priority order

1. **Correct over clever.** A focus block must never land on a meeting. That has to be provable with tests, not a hope about a prompt.
2. **The server is the source of truth.** A timer can't depend on a browser tab staying open.
3. **Works without its dependencies.** No API key, no Google keys, or a provider outage must leave a working app.
4. **Explainable.** Every automated decision carries its reason.
5. **The user stays in charge.** Automation proposes. Nothing on a schedule changes without the user.
6. **Safe with other people's data.** The app holds OAuth tokens for real calendars and personal reflections.

## System overview

One Go process serves the API and the built Angular app, and owns all background work.

| Component | Package | Responsibility |
|---|---|---|
| HTTP API | `internal/api` | Routes, validation, security middleware |
| Timer engine | `internal/engine` | One goroutine per running timer, persisted on every change |
| Event hub | `internal/events` | Pushes live updates to each user's open tabs over SSE |
| Planner | `internal/planner` | Pure function from calendar, tasks, preferences and now to blocks and reasons |
| Plans service | `internal/plans` | Builds planner input, stores proposals, handles accept, move and reconcile |
| Dispatcher | `internal/scheduler` | One goroutine that warns about and starts due blocks |
| Calendar service | `internal/calendar` | Provider interface, sync, push, write-back |
| Assistant | `internal/assistant` | Claude tool loop, narration guard, budget, eval set |
| Auth | `internal/auth` | bcrypt, sessions, OAuth sign-in, CSRF |
| Store | `internal/store` | GORM models, sealed tokens, SQLite setup |

An `errgroup` runs everything under one context, so SIGTERM drains it all and any component failing stops the process instead of leaving it half alive.

## Key decisions

### The server owns the timer

**Decision.** Timers run on the server. Browsers only display them.
**Why.** Browser timers stop when a tab closes or a laptop sleeps, and two devices disagree.
**Cost.** The app can't work offline, and it needs a real backend. This is the main reason a static host can't run it.

### One goroutine per timer, not locks

**Decision.** Each running timer is an actor: a goroutine that owns its state and reads commands from a channel.
**Why.** With a single owner, races become impossible by construction rather than something to check for. Pause, finish and deadline can't interleave.
**Cost.** Reading a timer means asking its goroutine, and all of this state lives in one process.

### Server-Sent Events, not WebSockets

**Decision.** Live updates use SSE.
**Why.** Updates only flow from server to browser, since every action is already a normal HTTP request with normal auth and CSRF. `EventSource` reconnects by itself and sends the session cookie automatically.
**Slow clients.** A client that falls behind is disconnected rather than allowed to block everyone else. It reconnects and receives a fresh snapshot.

### SQLite and one process

**Decision.** SQLite in WAL mode, with a single shared connection.
**Why.** There's nothing to operate, it's fast at this scale, and it fits the single-process design.
**Cost.** One instance only. Timers and the hub live in memory, so scaling out would mean Postgres and a lease-based dispatcher. Rate limits are also held in memory for the same reason.

### A pure, deterministic scheduler

**Decision.** `planner.Plan` is a pure function: exhaustive enumeration, then greedy selection.
**Why.** A workday has about 32 starts on a 15-minute grid, times a handful of rhythms. Checking all of them is fast (about 82 µs for a busy week) and every result can be explained. A solver would be slower and much harder to explain.
**How determinism is kept.** No map is iterated while scoring, scores compare after rounding to a millionth, and each product is converted to `float64` explicitly, so CPUs that fuse multiply-add can't reorder a tie.

The steps:

1. **Free time.** Merge busy events, widen them by the buffer, and cut each local day's workday down by them, by lunch if protected, and by the past. Days are built with `time.Date` in the user's zone, never by adding 24 hours, so daylight-saving days are 23 or 25 hours long.
2. **Candidates.** Every grid start in every free interval, for every allowed rhythm, while focus plus rest still fits.
3. **Hard constraints.** Discard anything that overlaps a meeting, lunch or another block, starts within 5 minutes, breaks a daily cap, or ends after the task is due.
4. **Score.** A weighted sum, with the weights as named constants in `score.go`.
5. **Select.** Take tasks by due date, then priority, then ID. Each takes its best surviving candidate. A task that doesn't fit is reported with a reason.

A new user has no history, so each hour starts at a flat prior that blends toward the user's own completion rate as `w = n / (n + 20)`, a Beta prior worth 20 sessions per hour.

### The model never picks a time

**Decision.** The assistant turns a request into one validated `plan_focus_blocks` call and narrates the result. It has no way to place a block.
**Why.** This gives testability, a working feature during outages, and a real answer to "why 2 pm?". It also bounds prompt injection: a meeting titled with instructions can at worst cause a misread request, and the scheduler's hard constraints still apply.
**Guards.** Arguments are validated in Go. The loop allows three tool rounds plus narration. Narration naming a time no tool returned is dropped and logged. Meeting titles are redacted to "Busy" unless the user opts in. Each user has a daily token budget, and identical requests reuse the stored plan.

### Nothing moves by itself

**Decision.** When a meeting lands on an accepted block, the block is flagged and a replacement is proposed. Nothing else changes.
**Why.** A schedule that rearranges itself can't be trusted.

### Missed blocks are skipped, not started late

**Decision.** A block that came due while the server was down is skipped. A timer that was already running is restored.
**Why.** A running timer has already begun and its time is real focus. A block starting three hours late would land on top of whatever the user is doing now. The asymmetry is intended.

### One dispatcher, not one goroutine per block

**Decision.** A single goroutine wakes at each block's warning and start, and at least every 30 seconds.
**Why.** A plan can hold blocks days away. That state belongs in the database, not in thousands of sleeping goroutines.

### The public site is a browser-only demo

**Decision.** GitHub Pages serves a demo of the app with an in-browser backend (`frontend/src/app/core/local`) and sample data. GitHub Actions rebuilds and publishes it on every push to `main`, after its browser tests pass. The full app stays the Go server.
**Why.** The project needs a link people can open, and a free static host can give it one today, with no account or running costs. Pages can't run a server, so the demo answers `/api` in the browser.
**Keeping it honest.** The scheduler isn't rewritten: `backend/cmd/plannerwasm` compiles the real Go planner to WebAssembly, and a test runs every golden fixture through that entry point. It costs about 1.5 MB gzipped, so it loads only on the first planning request. Timers, plans and stats are a TypeScript copy of the server's rules, so those can drift, and the demo says plainly what it stands in for.
**Safety.** There are no accounts, so the demo never asks for a password. It sends nothing anywhere, and it carries the same Content-Security-Policy as a meta tag, because Pages can't send response headers. The in-browser backend is only bundled in this build: the normal build doesn't contain it.
**History.** An earlier Pages build was reverted (commits `606a645`, `13b0c26`), because it replaced the scheduler with TypeScript and predated the planner. Renaming the repo later left that stale build blank, since it had the old repo path hardcoded. The path now comes from the repo's name at build time.

### A home page, three tabs, and a screen for each command

**Decision.** The app opens on a simple home page with one door each to Calendar, Focus and Progress. Those three are a floating tab bar. One bar under it asks for a plan from any screen but Focus, and sending it opens a dedicated plan screen, where proposed blocks appear on the same grid as meetings beside the decision to make.
**Why.** The project grew from a timer into a scheduler, so it needs a neutral place to start. Reviewing a plan on the grid shows what it does to your day, which a list can't. Giving a command its own screen makes clear that something happened, and nothing is scheduled until it's accepted. Focus has no bar so the timer stays free of distractions.
**Cost.** The timer is a click further away, though a running one is always visible as a small ring in the top bar.

### Liquid glass over one photograph

**Decision.** A fixed photograph sits behind everything, under a thin veil that differs by theme. All content is on translucent cards with `backdrop-filter`. The page content takes a `view-transition-name` only while a transition is playing.
**Why.** A named element becomes a backdrop root, so nothing inside it can blur what's behind it. Naming the content permanently turned every card into plain tinted glass, with sharp mountains showing through the text. During a transition the same limit applies, so cards go more opaque for the move and ease back afterwards, which hides the blur returning.
**Keeping it readable.** Contrast depends on what's behind the glass, so it was checked against the photograph's real extremes after downsampling to match the blur. A different photograph needs that check again.
**Cost.** The image adds 1.7 MB on large screens and about 680 KB on small ones. `backdrop-filter` also costs some GPU work, so inner elements use flat tints rather than more blur.

### Week columns share a clock, a single day shows real hours

**Decision.** A week lays items out by wall-clock time, so columns line up with one set of hour labels. A single day lays them out by elapsed time, so the autumn change shows 1 AM twice.
**Why.** A week needs one axis for seven days, and only a few hours a year differ. The day view is where someone would look at those hours, so it stays exact. Moving a block across days keeps its wall-clock time, so a clock change between them can't shift it. The month view asks for up to six weeks, so the schedule route allows 43 days: a six-week range across the autumn change is an hour longer than 42.

### Motion is CSS, and the mug stays pixel art

**Decision.** Animation uses CSS and the browser's View Transitions, with no animation library. It sticks to `transform` and `opacity` where it can, and `prefers-reduced-motion` turns it off. The interface uses Outfit, and pixel art is kept for the mug, the clock, the wordmark and the café.
**Why.** A library would add weight and a dependency for effects the browser does well, and it could need changes to the Content-Security-Policy. Keeping one pixel centerpiece keeps the app's character without making a dense calendar hard to read.

### The theme belongs to the device

**Decision.** Light, dark or the system's choice, saved in the browser rather than on the account. `public/theme-init.js` applies it before the first paint, and `core/theme.ts` takes over once the app loads. Every color is a token defined for both themes, on `:root` and `:root[data-theme='light']` in `styles.css`.
**Why.** A phone can follow its own setting while a laptop stays dark, which an account-wide setting couldn't do. Setting the theme before the first paint stops a light page flashing dark, and it has to be a separate file because the Content-Security-Policy allows no inline scripts.
**Cost.** The choice doesn't follow you to a new device, and the storage key and colors live in two files that must stay in step. A browser test loads the page with the app blocked to prove the early script works alone.

### A feature without keys stays visible

**Decision.** Without keys, the Google buttons show disabled and the calendar offers the options form. Each says what's missing. The server reports whether it has a model through `assistant_available` on the user.
**Why.** These buttons used to disappear, so a missing or misplaced `.env` looked like the features didn't exist, with nothing on screen to explain it.
**Cost.** A server run without keys tells its visitors so. That's acceptable, because a real deployment has its keys.

### Google sign-in and Google Calendar are separate consents

**Decision.** Sign-in asks only for `openid`, `email` and `profile`. Connecting a calendar is a second consent, offered on the calendar page.
**Why.** Someone can use the app without giving it their calendar, and Google's guidelines ask apps to request scopes when a feature needs them. The cost is a second consent screen for people who want both.

## Security architecture

The design assumes any single layer can fail, so requests pass through independent ones. Order in code: logging, panic recovery, security headers, body limit, then for `/api`: cross-origin check, rate limit, CSRF, session, and finally a user-scoped query.

### Accounts and sessions

- **Passwords.** bcrypt at cost 12 (281 ms per hash on an Apple M2, against 64 ms at the old cost of 10). Older hashes upgrade at the next sign-in, the only moment the password is at hand. Concurrent hashing is bounded by CPU count, so a burst of sign-ins queues instead of stalling timers.
- **Password rules.** 12 characters and a zxcvbn score of 3 with no composition rules, following NIST SP 800-63B. The limit is 72 bytes, not characters, because bcrypt counts bytes. Existing passwords aren't re-checked at sign-in.
- **Sessions.** A signed JWT in an `HttpOnly` cookie names a row in `login_sessions`. The signature rejects forgeries without touching the database, and the row makes sessions revocable. A database leak alone can't forge a session, and a cookie alone can't outlive its row. Lifetime is 14 days.
- **Ending a session.** Sign-out, a password change and "sign out everywhere" delete rows. Event streams re-check their session at each keepalive (25 seconds), so a revoked one stops receiving a user's events.
- **Timing.** An unknown email runs bcrypt against a dummy hash, so response time doesn't reveal which accounts exist.

### OAuth 2.0

- **Flow.** Authorization code with PKCE (S256), for both sign-in and calendar connect.
- **State.** Random, single use, 10 minutes, in a signed cookie tied to the browser, which stops login CSRF. Each flow has its own cookie path and MAC label, so a calendar state can't be replayed to sign in.
- **Verifier and nonce.** Derived with HMAC from the state and the server's key. They're never stored or sent to the browser.
- **ID token.** go-oidc verifies signature, issuer, audience and expiry. The code then checks the nonce and requires a verified email.
- **What's kept.** Sign-in stores only the identity and discards Google's access token, so signing in grants the app no access to the user's Google account. It asks only for `openid email profile`.
- **Account linking.** Accounts link on Google's `sub`, never on email. Nothing verifies the email behind a password account, so anyone could register a victim's address first and wait for them to arrive through Google. A collision is refused, and the owner signs in with their password and adds Google from Settings, which proves both.

### Browser

- A Content-Security-Policy of `default-src 'none'` with `script-src 'self'` allows no inline scripts and no third-party hosts. Inline styles stay allowed because Angular writes component styles into the page.
- Fonts are self-hosted. This protects privacy, since Google's font servers would otherwise learn about every visit, and it lets the policy stay strict.
- Angular's critical-CSS inlining is off because it adds an inline `onload` handler the policy forbids.
- Other headers: `nosniff`, `frame-ancestors 'none'` with `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, cross-origin isolation headers, `Cache-Control: no-store` on the API, and HSTS over HTTPS.
- The session cookie uses the `__Host-` prefix over HTTPS, so a sibling subdomain can't plant or overwrite it.
- CSRF has two independent checks: a double-submit token (Angular's built-in support) and Go's `http.CrossOriginProtection`.

### Data at rest and in logs

- Calendar tokens are sealed with AES-256-GCM by a GORM serializer, so encryption is part of the model rather than something a handler can forget. The column name is bound in as additional data, so a ciphertext copied to another column won't open.
- The database file is created and tightened to mode `0600`.
- The calendar stores only title, start, end and busy: no attendees, descriptions, locations or links.
- Logs carry no query strings (OAuth codes), no SQL values (emails, hashes, sealed tokens) and no request headers on a panic (session cookies).

### Availability and configuration

- Body size is capped at 256 KiB, and a client has 15 seconds to send it. Header size and idle time are bounded too. There's no overall server read or write timeout, because event streams stay open for hours.
- Rate limits: 600 requests a minute per address overall, 20 a minute on auth routes, 10 per 10 minutes per account on sign-in, 5 per 10 minutes on password changes, and limits on planning and manual sync.
- Release mode refuses to start without a `JWT_SECRET` of at least 32 bytes. OAuth redirect URLs must be HTTPS outside localhost. `TRUSTED_PROXIES` tells the rate limiter who may report a client's address.

### Supply chain

- **In CI:** gitleaks over all history, CodeQL, govulncheck, gosec, `npm audit` on what ships to browsers, and Trivy on the built image.
- **Pinning:** actions by commit and base images by digest, because tags can be moved. Dependabot proposes updates. The Trivy version and hash in `ci.yml` are updated by hand.
- **Trivy's install.** CI downloads Trivy from its GitHub release and checks a pinned hash instead of using the official action, because that action's installer depends on `get.trivy.dev`, which stopped resolving on 2026-11-03.

### Accepted risks

| Risk | Why it's accepted for now |
|---|---|
| Registration reveals whether an email has an account | Hiding it properly needs email verification. Rate limits slow enumeration |
| `style-src 'unsafe-inline'` | Angular needs it, and scripts have no such exception. A nonce-based policy would break static style attributes in templates |
| `zxcvbn` port last released in 2019 | It's a pure algorithm with no network access, input is capped at 72 bytes, and it's the best-known strength estimator with a Go port |
| Rate limits are in memory | Right for one process, and they reset on restart |
| The live demo's policy is a meta tag | Pages can't send response headers, and a meta tag can't set `frame-ancestors`. The demo holds only sample data and whatever a visitor types into their own browser |

## Calendar integration

- **Scopes.** `calendar.readonly` to read and `calendar.app.created` to write back, which limits writes to a calendar this app creates.
- **Sync.** The first sync pulls a week back and 60 days ahead, then follows Google's sync token, with a full pull weekly so an old event drifting into the window still arrives. A `410 Gone` clears the account's events and pulls again.
- **Push.** Notifications are verified against a random per-channel token and debounced per account over 5 seconds. Channels renew a day before they expire. Without `PUBLIC_URL`, accounts are polled every 5 minutes, so local development needs no tunnel.
- **Write-back.** Optional. Accepted blocks are copied to a "Brew Focus" calendar, moved when moved and removed when dropped. Those events are marked so a sync never treats them as busy.

## HTTP API

Everything except `/api/health`, the sign-in routes and the Google webhook requires a session. Every state-changing request needs the CSRF header, which Angular sends on its own.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/auth/register`, `/login`, `/logout` | Password accounts and sessions |
| `POST` | `/api/auth/logout-all` | End every session on every device |
| `GET` | `/api/auth/providers` | Which sign-in buttons to show |
| `GET` | `/api/auth/google/start`, `/callback` | Sign in with Google |
| `GET` / `DELETE` | `/api/auth/google/link`, `/api/auth/google` | Add or remove Google on an existing account |
| `GET` / `PUT` | `/api/me`, `/api/me/settings` | Profile and synced settings |
| `PUT` | `/api/me/password` | Set or change a password |
| `GET` / `POST` / `DELETE` | `/api/presets[/:id]` | Custom timing modes |
| `GET` / `POST` / `PATCH` / `DELETE` | `/api/tasks[/:id]` | Tasks with estimate, due date, priority and energy |
| `GET` / `POST` | `/api/timer`, `/api/timer/:action` | The server-run timer |
| `GET` | `/api/events` | SSE stream of live updates |
| `GET` / `PATCH` / `DELETE` | `/api/sessions[/:id]` | Journal and reflections |
| `GET` | `/api/stats`, `/api/insights` | Streaks and heatmap; planning metrics |
| `GET` | `/api/calendar/connect`, `/callback` | Calendar OAuth start and finish |
| `GET` / `DELETE` | `/api/calendar/accounts[/:id]` | Connected accounts; disconnecting revokes access and deletes events |
| `POST` | `/api/calendar/sync` | Sync now (once a minute) |
| `POST` | `/api/calendar/push` | Google's webhook (no session; verified by channel token) |
| `GET` | `/api/schedule?from&to` | Meetings and accepted blocks for local days |
| `POST` | `/api/assistant/plan` | `{text}`, `{ask}` or `{quick}` to a proposed plan |
| `GET` | `/api/plans/live`, `/api/plans/:id` | Open proposals; one plan |
| `POST` | `/api/plans/:id/accept`, `/reject` | Accept all or some; reject |
| `PATCH` / `DELETE` / `POST` | `/api/scheduled/:id`, `/start` | Move a block (409 with the reason if it breaks a limit), drop it, start it now |

## Testing strategy

- **Scheduler.** 17 golden fixtures, each with a semantic check so a golden file can't quietly enshrine a wrong answer, plus a property test over 400 random calendars in five zones checking no overlaps, caps held, and the same plan for a shuffled input.
- **Calendar.** A fake provider covers sync, push, renewal and write-back. The Google provider runs against a local stand-in for the Calendar API.
- **Assistant.** A scripted fake model covers the tool loop, retries, the round cap, the budget, dropped narration and degradation. `make eval` runs 30 requests against the real model and costs money, so CI doesn't run it. The [latest results](backend/internal/assistant/testdata/eval-results.md) are checked in.
- **Security.** Tests attack the app: replaying a stolen cookie after sign-out, forged ID tokens signed with the wrong key, wrong audience and issuer, login CSRF, email-collision account takeover, and cross-site requests. Google sign-in runs against a local OpenID provider using real RSA signatures, so the actual verification code runs. Each of these protections was also removed on purpose to confirm its test fails. Run the same exercise on any new protection.
- **Browser.** Playwright drives a real browser through the planning loop, and checks that the policy blocks an injected script, the page loads nothing from a third party, and a copied cookie stops working after sign-out.
- **Live demo.** A second Playwright suite serves the static build the way Pages does, under the repo's path with `404.html` as the fallback. It checks that the page loads, deep links work, the WebAssembly scheduler plans around the sample meetings, and nothing calls a server. Publishing waits on it, so a broken build can't replace the live site.

## Known gaps and roadmap

**Not yet verified against the real thing**

- Google sign-in and Calendar have run end to end only against local stand-ins. Google has accepted the sign-in and calendar requests and the client secret from a real OAuth client, but nobody has yet completed a consent screen and a calendar sync with a real account.
- The assistant has one eval run against the real model. It measures the requests the model produces, not how often its note is shown. The first real requests found a note being dropped for repeating the user's own limit, so watch `narration_invented_time` in `assistant_turns`.

**Next, in order**

1. **Host the full app.** The live demo is on GitHub Pages, but sign-in, Google Calendar, the assistant and server-run timers need a container host with a persistent disk. Set `JWT_SECRET`, `SECURE_COOKIES` and `TRUSTED_PROXIES`.
2. **Finish verifying Google** with a real account, above.
3. **Send email.** Email unlocks address verification and password reset. Today a forgotten password can't be recovered unless Google is linked.
4. **Two-factor authentication** with TOTP, for password accounts.
5. **Account deletion and data export,** so users can remove everything the app holds.
6. **Encryption key rotation** for calendar tokens, and encrypted backups.
7. **A device list,** so a user can see and end individual sessions instead of all of them.
