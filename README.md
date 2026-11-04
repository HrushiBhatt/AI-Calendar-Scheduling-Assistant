<p align="center"><img src="docs/assets/hero.svg" alt="Brew Focus: a pixel-art mug drains as the timer counts down, then refills on a break" width="100%"/></p>

<p align="center"><b><a href="https://hrushibhatt.github.io/BrewFocus/">Open the app</a></b></p>

![A focus block from start to finish: pick a task, set an intention, the mug drains, write a reflection, the mug refills on the break, and the session appears on the Progress page](docs/assets/demo.gif)

<img src="docs/assets/stats.svg" alt="Zero servers, accounts, cookies and outside requests, and 42 tests" width="100%"/>

## Everything runs in the browser

<img src="docs/assets/architecture.svg" alt="GitHub Pages delivers static files once. In the browser, screens talk to the Brew service, which talks to the Store, which saves to localStorage. Other tabs follow over a BroadcastChannel, and a Web Lock lets one tab finish each block. There is no server, account or tracking." width="100%"/>

| Choice | Why |
|---|---|
| No server | GitHub Pages only serves static files, and a server without sign-in would show every visitor the same data |
| No accounts | Data on your own device needs no password to protect it |
| One JSON document in `localStorage` | Reads are instant, so screens have no loading states |
| `BroadcastChannel` between tabs | Pausing in one tab pauses them all |
| Web Lock on the deadline | Every tab sets an alarm, and exactly one logs the block |

**The trade-off:** your data stays on one device and browser, with no sync between them.

## A deadline, not a counter

<img src="docs/assets/timer.svg" alt="Illustration: a counter falls behind when a tab is in the background or closed, while a saved deadline stays right" width="100%"/>

Browsers throttle timers in background tabs, and a closed tab runs nothing, so a counter loses time. The app saves when a block ends and works out the rest. A block that ran out while the tab was closed is credited on your return.

## One flow for every block

<img src="docs/assets/flow.svg" alt="The cycle: intention, optional breathing, focus while the mug drains, a one-line reflection, then a break while it refills" width="100%"/>

An intention gives a block a purpose, and a reflection makes it count for more than minutes. One service, `Brew`, runs the whole cycle with Angular signals, so every screen shows the same state.

## Secure by having less

<img src="docs/assets/security.svg" alt="A strict page policy lets in only this site's own files, and blocks injected scripts, outside scripts and data leaving. With no server or accounts, there's nothing to break into." width="100%"/>

| Choice | Why |
|---|---|
| Policy in a `<meta>` tag | Pages can't send security headers |
| Fonts and code self-hosted | The policy can then refuse every other host |
| Theme script in its own file | The policy allows no inline scripts |
| Everything typed is shown as text | A task named `<img onerror=…>` can't run |
| The store checks and repairs what it reads | A damaged save can't break the page |

Browser tests check all of this against the built site.

## Pixel art, drawn in code

<img src="docs/assets/screen-brew.png" alt="The Brew page: tasks on the left, the mug timer in the middle, modes and ambience on the right" width="100%"/>

<img src="docs/assets/screen-progress.png" alt="The Progress page: totals and streaks, a year heatmap, a café that fills as you finish brews, and a journal" width="100%"/>

| Choice | Why |
|---|---|
| Mug and sprites drawn as SVG squares | Crisp at any size, with no image files to download |
| Ambience synthesized with Web Audio | Rain and lo-fi with no audio files |
| Color tokens for both themes | Light mode changes only tokens; the mug keeps its colors |
| Full-width grid with flexible columns | Uses the whole screen, then stacks on a phone |

<img src="docs/assets/screen-light.png" alt="The Brew page in light mode" width="100%"/>

## Small on purpose

<img src="docs/assets/chart-code.svg" alt="Lines of code: about 27,800 with calendar and Claude, about 11,300 with a Go server, and about 5,000 now" width="100%"/>

<img src="docs/assets/chart-size.svg" alt="What a visitor downloads, compressed: about 98 kB on first load, at most 81 kB of fonts, 7.7 kB for the Brew page and 3.9 kB for the Progress page when opened" width="100%"/>

Each page loads when it's opened, so the timer never downloads the heatmap.

## Every push deploys

<img src="docs/assets/deploy.svg" alt="Every push to main: scan, unit tests, build, browser tests, then publish to GitHub Pages" width="100%"/>

A failure at any step leaves the live site as it was. The build takes its path from the repo's name, so a rename is fixed by the next push.

## The code

```
frontend/src/app/
  core/
    data/       the store: rules, saving, the timer's deadline, events
    state/      Brew (the focus flow), the timer display, helpers
    sound/      synthesized ambience and chimes
    theme/      light and dark
  features/     brew, tasks, progress, focus-flow, settings
  shared/       dialog frame, pipes, pixel art
frontend/e2e/   browser tests, against the site as Pages serves it
docs/assets/    generate.py draws these diagrams
```

```bash
make install
make web    # http://localhost:4200
make test   # unit tests
make e2e    # browser tests
```

[Changelog](CHANGELOG.md)
