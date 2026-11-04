# AGENTS.md

Context for AI agents working in this repository. Read this before changing anything. Humans should start with the [README](README.md). The reasoning behind each decision is in [ARCHITECTURE.md](ARCHITECTURE.md), and the history is in [CHANGELOG.md](CHANGELOG.md).

## Status report

*Last updated: 2026-11-04. Update this section when the state changes.*

| Area | State |
|---|---|
| Timer, tasks, progress, scheduler, planning flow, dispatch, reconciliation | Built and tested |
| Accounts, sessions, security hardening, supply-chain checks | Built and tested |
| Google sign-in, Google Calendar | Built. End-to-end tests use local stand-ins. Google has accepted a real client's requests and secret, but nobody has finished a consent screen or synced a real calendar yet |
| AI assistant | Built. One eval run against the real model: 29 of 30 prompts fully correct on `claude-haiku-5-5`. `make eval` costs real money, so ask before re-running it |
| Live demo | https://hrushibhatt.github.io/AI-Calendar-Scheduling-Assistant/ is the browser-only demo, published to the `gh-pages` branch by the `pages` job in CI on every push to `main` |
| Hosting the full app | **Not deployed.** The Go server runs nowhere public, and the hosting choice belongs to the owner |

**Open decision for the owner. Don't make it yourself:** where to host the full app.

## Scope

**In scope:** a single-user-at-a-time web app for focus sessions and calendar-aware planning, run as one Go process with SQLite.

**Out of scope unless the owner asks:** other languages or a backend rewrite, multiple server instances, a mobile app, team or shared features. A Python port was started and abandoned.

The live demo is in scope, but it's a demo. It must never collect passwords or send anything off the device.

## Repository map

| Path | What's there |
|---|---|
| `backend/cmd/server` | Startup, configuration checks, background-task wiring |
| `backend/cmd/plannerwasm` | The planner compiled to WebAssembly, for the live demo |
| `backend/internal/planner` | The pure scheduler and its golden fixtures |
| `backend/internal/plans` | Plan lifecycle: input building, proposals, accept, move, reconcile |
| `backend/internal/scheduler` | Dispatcher: due blocks become running timers |
| `backend/internal/engine` | Server-run timers |
| `backend/internal/events` | SSE pub/sub hub |
| `backend/internal/calendar` | Provider interface, Google, fake, sync, push, write-back |
| `backend/internal/assistant` | Claude tool loop, prompt, eval set |
| `backend/internal/auth` | bcrypt, sessions, OAuth sign-in, state, CSRF |
| `backend/internal/store` | GORM models, sealed tokens, SQLite setup |
| `backend/internal/api` | Gin handlers, `hardening.go` middleware |
| `frontend/src/app` | Angular: `core` services, `brew`, `plan`, `progress`, `dialogs`, `login` |
| `frontend/src/app/core/local` | The live demo's in-browser backend and sample data. Only the `pages` build bundles it |
| `frontend/e2e` | Playwright browser tests against the Go server |
| `frontend/e2e-pages` | Playwright browser tests against the static demo, served as Pages serves it |
| `docs/assets` | README images, and `generate.py`, which draws the SVGs |

The Go module path still says `Productivity-Manager`, the repo's old name. That's harmless, so leave it unless asked. The repo is now `AI-Calendar-Scheduling-Assistant`.

## Commands

```bash
make install               # dependencies
make demo                  # API on :5001 with a seeded account (demo@brewfocus.dev / brewfocus)
make web                   # Angular on :4200
make test                  # Go tests under -race, then Angular unit tests
make audit                 # govulncheck, gosec, gitleaks, npm audit
cd frontend && npm run e2e # browser tests; locally they drive the installed Chrome
make pages                 # the live demo on :4200, with no Go server
make pages-build           # the site CI publishes; then: cd frontend && npm run e2e:pages
```

Before calling work done, run `make test` and `make audit`. Also run `npm run e2e` and `npm run e2e:pages` if you touched the frontend, security headers, or a build setting. A new script source, font or image host must be allowed by the Content-Security-Policy, and only the browser test will catch a mistake there.

## Rules that must not break

A change that breaks one of these is wrong even if everything else works.

1. **The model never picks a time.** The assistant produces only a validated request and narration. No path may let model output place a block.
2. **The planner is pure.** `internal/planner` has no I/O, clock, logging, network or model. Same input, same output. Golden files change only with `-update` and a real reason.
3. **One owner for timer state.** Only a timer's own goroutine touches its state. Don't add locks or shared mutation.
4. **Nothing moves by itself.** Automation proposes and the user decides.
5. **The app works with no keys.** Every external integration is optional and degrades on its own.
6. **All arithmetic on local days happens in the user's IANA zone,** and database times are UTC.
7. **The live demo uses the real scheduler.** Don't reimplement the planner in TypeScript: it runs as WebAssembly through `cmd/plannerwasm`. If an API route changes, update `core/local/local-backend.ts` to match, or the live site breaks where the server doesn't.

## Security rules

- **Scope every query to the user.** Any row a user can name by ID must be fetched with `user_id = ?`. Add a cross-account test for new resources.
- **Never log secrets.** No tokens, codes, cookies, hashes, or SQL values. Provider errors must be scrubbed first. Don't turn query-string logging or `ParameterizedQueries` back on, and don't restore `gin.Recovery`.
- **Never link accounts by email.** Link on the provider's subject ID. See ARCHITECTURE.md for the attack this prevents.
- **Passwords go through `auth.ValidatePassword` and bcrypt.** Don't reimplement either, and don't enforce new-password rules at sign-in, where they'd lock out older accounts.
- **State-changing routes stay inside the `/api` group** for CSRF and cross-origin checks. `/api/calendar/push` is the one deliberate exception.
- **Secrets stay out of git.** Use `.env`, never `.env.example`, which git tracks. Don't read or print `.env`: it holds the owner's real keys, so check it by setting name only. CI fails on any secret anywhere in history, so one committed by accident means rotating it, not just deleting it.
- **Pin what you add.** Actions by commit, images by digest, tools by exact version. Trivy's version and hash in `ci.yml` are updated by hand.
- **Don't weaken a check to get CI passing.** Fix the cause, or ask.

## Things that look wrong but are deliberate

| It looks like | Why it's right |
|---|---|
| A block that came due during downtime is skipped, yet running timers are restored | A late block interrupts whatever the user is doing now. A running timer's time is real |
| A matching email is refused at Google sign-in instead of joining the account | It prevents pre-registration account takeover |
| `style-src 'unsafe-inline'` in the policy | Angular writes component styles inline. Scripts have no such exception |
| No server-wide `ReadTimeout` or `WriteTimeout` | Event streams stay open for hours, and a server-wide deadline would cut them off. `readBody` bounds bodies instead |
| The app answers `/api` with no server in the Pages build | That's the live demo: `environment.pages.ts` adds an interceptor that handles those requests in the browser. Pages can't run the Go server |
| `style-src 'unsafe-inline'`, and a `wasm-unsafe-eval` in `index.pages.html` | Angular writes styles inline, and that one keyword lets the demo run the WebAssembly scheduler. Neither allows injected scripts |
| The Google buttons are white and ignore the pixel theme | Google's branding rules set their colors, spacing and logo. Don't restyle them |
| Google sign-in doesn't connect the calendar | They're separate consents, so someone can use the app without giving it their calendar |
| The Google buttons, and a note about Claude, show even without keys | They say what's missing. They used to disappear, which made a misplaced `.env` look like missing features |
| The Trivy action isn't used | Its installer depends on `get.trivy.dev`, which stopped resolving |
| `dummyHash` work on failed logins | Equal timing hides which emails exist |
| Sessions are a JWT *and* a database row | The signature rejects forgeries cheaply, and the row makes them revocable |
| The demo password is in the source and logs | It's a public demo account with no real data. Its password can't be changed, and it can't link Google or sign other visitors out, so one visitor can't lock out the rest |

## Working agreement

- **Work directly on `main`.** The owner is the only person on this repo and asked for no new branches. Check out `main`, pull, commit there and push once it's verified. A push to `main` deploys the live site, so run the checks first.
- **Update `CHANGELOG.md` with every change,** and say why, not only what.
- **Keep this file's status report current,** and ARCHITECTURE.md if a decision changes.
- **Report only measured numbers.** Benchmarks, coverage, test counts and eval results must come from a real run, with the hardware named where it matters. If something wasn't run, say so. "Not measured yet" is an acceptable entry, and an invented number isn't.
- **Say what was and wasn't verified.** Passing against a stand-in isn't the same as working against the real service.
- **Match the surrounding code:** its naming, comment density and idioms. Comments explain why.
- **Refreshing README visuals.** `docs/assets/generate.py` draws the SVGs. If tests or coverage change noticeably, re-measure and update `docs/assets/data/coverage.json` and the numbers table. `demo.gif` and the `screen-*.png` files are captures of the running demo.
