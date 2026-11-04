# Changelog

Every notable change to Brew Focus, and why it was made. Newest first. Dates are when the work landed; there are no version tags yet.

## Unreleased: security hardening and documentation

Branch `feature/security-and-docs`.

### Security: accounts and sessions

- **Added: sign-in with Google, using OAuth 2.0 with PKCE and verified OpenID Connect ID tokens.** *Why:* it spares people another password to create and protect, and Google's own protections, such as its two-factor sign-in, then cover the account. It's optional and appears only when configured.
- **Changed: sessions now live on the server.** The cookie names a database row. *Why:* signing out only cleared the browser's cookie, so a stolen copy kept working for 30 days. Now sign-out really ends it, including any open event stream. Lifetime also dropped from 30 days to 14.
- **Added: change password, and sign out everywhere.** *Why:* there was no way to change a password, so a compromised account couldn't be recovered. A password change also ends every other session. The shared demo account is exempt, so one visitor can't lock out or sign out the others.
- **Changed: bcrypt cost raised from 10 to 12, with old hashes upgraded at the next sign-in.** *Why:* it makes each guess about four times slower (64 ms to 281 ms on an Apple M2), and existing users need do nothing.
- **Changed: new passwords need 12 characters and a zxcvbn strength check.** *Why:* length and resistance to guessing matter more than symbol rules, as NIST SP 800-63B advises. Existing passwords keep working.
- **Changed: accounts link on Google's permanent ID, never on email.** *Why:* nothing verifies the email behind a password account, so an attacker could register a victim's address first and share the account when the victim arrived through Google. The owner adds Google from Settings instead.
- **Added: PKCE on the calendar connection.** *Why:* a stolen authorization code is now useless on its own.

### Security: fixes from an audit

- **Fixed: OAuth authorization codes were written to the request log** through query strings. *Why it mattered:* logs are often less protected than the data they describe.
- **Fixed: GORM logged SQL values on errors and slow queries.** *Why it mattered:* those values can be emails, password hashes, sealed tokens or session IDs. A browser test run exposed this one.
- **Fixed: Gin's recovery handler printed session cookies on a panic** in debug mode, the default for `make api` and `make demo`. Release mode didn't print them.
- **Fixed: a long password with accents or emoji caused a 500 at sign-up.** *Why:* the length check counted characters, but bcrypt counts bytes.
- **Fixed: rate limits saw only the proxy's address behind a reverse proxy,** so all visitors would share one sign-in limit. Added `TRUSTED_PROXIES`.
- **Added: browser security headers,** including a strict Content-Security-Policy. *Why:* they contain the damage if anything ever injects markup into the page.
- **Changed: fonts are self-hosted.** *Why:* Google's font servers learned about every visit, and removing them lets the policy stay strict.
- **Added: a second cross-site check,** Go's cross-origin protection, in front of the CSRF token.
- **Added: limits on request size and read time,** and a general per-address rate limit. *Why:* a large or slow request could otherwise exhaust memory or hold connections open.
- **Changed: release mode refuses to start without a strong `JWT_SECRET`,** and OAuth redirect URLs must be HTTPS outside localhost. *Why:* a weak key would let anyone forge a session for any user, so failing at startup is the safe behavior.
- **Changed: the database file is readable by its owner alone.** *Why:* it was world readable, and it holds password hashes and sealed tokens.

**Effect on users:** everyone is signed out once, because old cookies name no session.

### Security: the repository and its dependencies

- **Added: gitleaks in CI, over all history.** *Why:* a leaked key bypasses every other protection. The current history is clean: 18 commits scanned, no leaks.
- **Added: CodeQL, `npm audit` and Dependabot.** *Why:* to find code flaws and vulnerable packages continuously, not only when someone remembers to look.
- **Changed: CI actions are pinned to commits and base images to digests.** *Why:* tags can be moved to malicious code, and that has happened to popular actions.
- **Changed: `.gitignore` and `.dockerignore` now cover Google credential downloads, private keys and database backups,** not only `.env`. *Why:* a Google OAuth client downloads as a JSON file that the old rules would have let through.
- **Updated: `golang.org/x/net`, `go-jose` and the Angular packages.** *Why:* each had a known advisory. Trivy flagged `go-jose`, which the new sign-in dependency brought in, before it reached `main`.

### CI

- **Fixed: the image scan failed on every run.** *Why:* the official Trivy action's installer downloads from `get.trivy.dev`, which stopped resolving on 2026-11-03, so the scanner never ran. CI now downloads Trivy directly from its GitHub release and checks a pinned hash.

### Documentation

- **Rewrote the README** around what the app does and how, with animated diagrams, charts, real screenshots and a recorded walkthrough. *Why:* the old one was accurate but read like a design document, so that depth moved to `ARCHITECTURE.md`.
- **Added `ARCHITECTURE.md`, `AGENTS.md` and this changelog.** *Why:* to record the reasoning behind decisions, to give AI agents the project's scope and rules up front, and to keep a history that explains why, not only what.

## 2026-10-26: the calendar-aware planner

Merged to `main` on 2026-11-03 as pull request #1. *Why:* to turn a timer into something that decides when focus happens, and to test how to add AI without depending on it for anything that must be correct.

- **Phase 1, foundation:** planning preferences, time zones, and task due dates, priority and energy. *Why:* the scheduler's hard constraints are the user's preferences, not constants.
- **Phase 2, calendar read path:** Google sign-in for calendars, sync, sealed tokens and the day timeline. *Why:* planning needs real busy times. Only what scheduling needs is stored.
- **Phase 3, deterministic scheduler and planning form:** the pure planner, golden fixtures and property tests. *Why:* the core had to be correct and testable before any model was involved.
- **Phase 4, accept and dispatch:** partial accept, the dispatcher and the 60-second countdown. *Why:* a plan only matters if it actually starts.
- **Phase 5, the assistant:** the Claude tool loop, validation, budget and eval set. *Why:* plain language lowers the effort of planning, and it arrived last on purpose, on top of a planner that already worked.
- **Phase 6, reconciliation:** conflicts and replacement proposals. *Why:* calendars change after a plan is accepted.
- **Phase 7, hardening and polish:** write-back, CSRF, rate limits, insights, the browser test, and CI security scans. *Why:* the feature holds tokens for real calendars and sends text to a third party.

Also fixed along the way: SQLite compared stored times as text, so a query bound in another zone compared wrong near midnight. All times now convert to UTC in one place, the database driver wrapper.

## 2026-09-30: Go and Angular

- **Rewrote the app in Go and Angular** (`423c253`), with CI, a Dockerfile and server-run timers built around goroutine actors and Server-Sent Events. *Why:* the Flask version's timer ran in the browser, so it depended on the tab staying open. The rewrite moved it to the server, where one goroutine owns each timer, and ships everything as one container.
- **Tried a GitHub Pages build, then reverted it** (`606a645`, `13b0c26`). It needed an in-browser TypeScript copy of the API. *Why reverted:* Pages only serves static files, and the copy gave up the server-run design. The revert kept one unrelated fix: adding a preset or task no longer duplicates it when a live update arrives first.
- **Earlier the same day: moved from a static site to a Flask API with a React frontend** (`9c5a1aa`), with a brief React deployment to Pages (`9ed53bf`). *Why:* accounts and server-side data need a backend. This was the first step away from a browser-only app.

## 2026-01-15: first version

- **A pixel-art Pomodoro timer in plain HTML, CSS and JavaScript** (`23f1b10`), with an animated coffee mug, preset timers, custom times and session tracking. README edits followed through February.
