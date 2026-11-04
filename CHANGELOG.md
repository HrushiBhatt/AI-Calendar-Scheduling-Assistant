# Changelog

Every notable change to Brew Focus, and why it was made. Newest first. Dates are when the work landed; there are no version tags yet.

## 2026-11-04: a home page, top navigation and liquid glass over a photograph

- **Added: a home page.** A greeting and one door each to Calendar, Focus and Progress, with a single live detail on each. *Why:* the app needed a simple place to start, instead of dropping people straight into a calendar. The calendar moved to `/calendar`.
- **Changed: the tabs are now a floating bar at the top, not a side rail.** It's centered and doesn't span the page, with a thumb that glides to the open tab. The logo goes home, and the theme and settings buttons sit to the right. *Why:* the owner asked for it, and it gives the content the full width.
- **Changed: the Ask Claude bar sits under the tabs, on every screen but Focus.** *Why:* planning should be reachable from anywhere, while the timer stays free of distractions.
- **Added: a plan screen that a command opens.** It shows the request while Claude works, then the plan on the calendar beside the decision. *Why:* a command should feel like it opened something, and a review deserves the whole screen. A plan still waiting shows a link on the calendar.
- **Added: real transitions between screens.** Tabs slide in the direction you went, and a command unfolds its screen from the bar. *Why:* the owner asked for motion between screens, and direction helps people keep their place.
- **Added: a 4K background photograph, with all content on liquid glass above it.** The image lives in `frontend/src/assets/background`. Large and high-density screens get the 3972 px original, phones and small windows get a 1920 px copy, and a tiny blurred copy shows at once on large screens. *Why:* the owner asked for a premium look.
- **Changed: the palette is now cool neutrals with the crema accent.** *Why:* warm brown glass looked muddy over a blue sky, and crema is complementary to it. Both themes use the same photograph.
- **Measured: text contrast against the photograph's real extremes.** The photo was downsampled to match the blur, and its darkest and brightest regions were each composited with the glass. Text stays at 4.5:1 or better in both themes.
- **Changed: everything sits in one centered column, and the calendar's hours scroll inside their glass.** *Why:* a cleaner page, with the bars always in reach.
- **Fixed: the plan screen could briefly say there was nothing to review.** *Why:* it waited for a refetch after the answer arrived. It now shows the plan from the answer itself.

## 2026-11-04: light and dark mode

- **Added: a light theme next to the dark one.** It follows the system by default. A button in the navigation switches directly, and Settings offers System, Light or Dark. *Why:* a dark calendar is hard to read in a bright room, and people have their own preference. On a phone the choice lives in Settings, because the tab bar has no room to spare.
- **Added: the theme is set before the first paint.** `public/theme-init.js` runs ahead of the app. *Why:* otherwise a light page flashes dark on every load. It's a file because the Content-Security-Policy allows no inline scripts.
- **Decided: the theme belongs to the device, not the account.** *Why:* a phone can follow its own setting while a laptop stays dark. It also means no server change, so the live demo works the same way.
- **Added: switching spreads the new theme in a circle from the control you used.** *Why:* it makes a big visual change feel like one deliberate step. `prefers-reduced-motion` skips it.
- **Changed: every color is now a token defined for both themes.** The mug keeps its own colors in either. Text on the app's surfaces was calculated at 4.5:1 contrast or better in both.
- **Changed: the first Settings tab is now General.** *Why:* it holds Appearance as well as the timer options.

## 2026-11-04: a redesign around the calendar

- **Changed: the app now opens on a calendar with day, week and month views.** *Why:* it grew from a timer into a scheduler, so the home screen should start from your time. The timer moved to its own Focus page, and old `/plan` links still work.
- **Added: blocks can be dragged across days, and open their details when clicked, with Start and Remove.** *Why:* a week view invites moving things between days, and the server already allowed both actions. It still re-checks every move.
- **Changed: Claude is one bar docked over the calendar.** *Why:* asking should take one step, and the answer should land where the time is. The form is now an options panel behind it, and `/` jumps to the bar.
- **Changed: much less wording.** *Why:* the interface explained itself in sentences it didn't need. A scheduler's reason now unfolds on hover or focus, and status shows in a block's styling instead of a label.
- **Changed: Settings is a side panel with four short tabs.** *Why:* it was one long scrolling dialog with a hint under every option.
- **Added: motion throughout, in CSS only.** Pages cross-fade, new ranges slide in from the direction you went, proposed blocks shimmer, a running session deepens the background and fades the panels beside it, and finishing throws a burst of beans. *Why:* to make the app feel alive without adding a dependency. `prefers-reduced-motion` turns all of it off.
- **Changed: a new look, in espresso and crema.** The pixel font and borders are gone from the interface, and the pixel mug stays as the timer's centerpiece. *Why:* pixel text is hard to read in a dense calendar.
- **Changed: the running timer follows you as a ring in the navigation.** *Why:* the timer is no longer on the home page.
- **Changed: the schedule route now allows six weeks instead of 31 days.** *Why:* a month grid can show up to 42 days. A test covers a range across the autumn clock change, which runs an hour longer.
- **Fixed: "Under a minute, not logged" never appeared.** *Why:* an event with no data reached the browser as the text `<nil>`, which isn't JSON, so the page threw and lost it. Found while walking through the redesign.
- **Fixed: a failed request could break the calendar or Progress.** *Why:* they read the failed request's value directly, which throws. They now show an empty or error state.
- **Changed: agents no longer push.** *Why:* the owner pushes when they're ready, as they asked.

## 2026-11-04: Google and Claude in the interface, and their first real runs

- **Changed: Google sign-in and calendar connection now always show, with Google's logo.** *Why:* they used to disappear when the server had no keys, so a misplaced key file made them look like they didn't exist. Without keys they now show disabled and say what's missing. The buttons follow Google's branding rules, so they stay white instead of matching the pixel theme.
- **Added: a calendar card on the Plan page, and an offer to connect on the Brew page.** *Why:* connecting was hidden inside Settings, and signing in lands on the timer. The offer can be dismissed, and the demo account's sample calendar doesn't count as connected.
- **Changed: the planner names Claude, and says when Claude isn't set up.** *Why:* the page couldn't tell whether the server had a key, so a missing key only showed up after sending a request. The server now reports it as `assistant_available`. The live demo keeps saying it uses a phrase matcher, because it isn't Claude.
- **Fixed: Claude's note disappeared when it repeated the user's own limit, as in "nothing after 11".** *Why:* the check that drops invented times didn't know those times came from the request. The first real requests found this. Validated limits are now allowed, and other times are still dropped.
- **Added: the server logs when the Claude API fails, with the status code only.** *Why:* the user just sees a fallback plan, so a rejected key or spent credits left the owner no sign of the cause.
- **Fixed: the login page would break if the server couldn't be reached.** *Why:* it read a failed request's value directly. It now says the server can't be reached and keeps the form usable.
- **Measured: the first eval against the real model.** 29 of 30 prompts were fully correct on `claude-haiku-5-5`, at about 5,900 tokens per request and 3.2 s typical latency. The miss was a request for a task that doesn't exist, and nothing was placed for it. It's one run, and the [results](backend/internal/assistant/testdata/eval-results.md) are checked in.
- **Verified: Google accepts a real OAuth client's sign-in and calendar requests and its secret.** *Not verified:* nobody has finished a consent screen or synced a real calendar yet.
- **Changed: the setup docs now warn against keys in `.env.example`, and against Google's Testing mode.** *Why:* the app reads only `.env` and git tracks the example, so keys saved there don't work and could be published. In Testing mode, Google ends calendar access every 7 days.

## 2026-11-04: a working public site

- **Fixed: the site at [hrushibhatt.github.io/AI-Calendar-Scheduling-Assistant/](https://hrushibhatt.github.io/AI-Calendar-Scheduling-Assistant/) was a blank page.** *Why:* it was still a September build with the repo's old name hardcoded, so renaming the repo made every file fail to load, and nothing ever deployed from `main` to replace it.
- **Added: a live demo, deployed by GitHub Actions on every push to `main`.** *Why:* the project needs a link people can open. Pages only serves static files, so the demo answers API requests in the browser, with sample data and no account.
- **Added: the real scheduler compiled to WebAssembly** (`backend/cmd/plannerwasm`). *Why:* a TypeScript copy could drift from the Go code. A test runs every golden fixture through this entry point, so the demo's plans match the full app's.
- **Added: browser tests against the static build, served the way Pages serves it.** Publishing waits on them. *Why:* they caught a build that had no `index.html`, which would have broken the live site.
- **Changed: the site's path now comes from the repo's name at build time.** *Why:* so renaming the repo can't blank the site again.
- **Changed: work now happens directly on `main`.** *Why:* the owner is the only person on the repo.

This reverses the earlier call against GitHub Pages, below. The full app is still the Go server, and it isn't hosted anywhere public yet.

## 2026-11-03: security hardening and documentation

Merged to `main` as pull request #2.

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

- **Fixed: the image scan failed on every run.** *Why:* the official Trivy action's installer downloads from `get.trivy.dev`, which stopped resolving on 2026-11-03, so the scanner never ran. CI now downloads Trivy directly from its GitHub release and checks a pinned hash. The first real scan of the image then passed on `main`.

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
