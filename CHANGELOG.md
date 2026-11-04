# Changelog

Newest first. The git history has the full detail.

## 2026-11-04: back to a simple timer and tracker

**Removed**
- Google Calendar, the Claude assistant, the scheduler and the planning screens, to keep the app focused on timers and tracking.
- The calendar, home and plan pages, task due dates and priorities, and the planning settings.
- `AGENTS.md`, `ARCHITECTURE.md` and the diagrams that described the old design.

**Restored**
- The pixel-art Brew and Progress pages.

**Changed**
- Every page now spans the full width of the screen.
- Light and dark mode stay, with dark as the default and one button to switch.
- The code is organized into folders by feature, with comments on how it works.

**Kept**
- Password and Google sign-in, session and CSRF protection, rate limits, security scans, and the live demo.

**Upgrading:** existing tasks and sessions carry over. Tables left from the removed features stay in an old database, unused.

## Earlier

- **2026-11-04:** Tried a calendar-first redesign, light and dark mode, and a liquid glass look. The redesign and the glass were later removed.
- **2026-11-03:** Hardened accounts and sessions, added Google sign-in and secret scanning, and pinned dependencies.
- **2026-10:** Added calendar-aware planning with Claude, since removed.
- **2026-09:** Added server-run timers, tasks and progress tracking.
- **2026-01:** First version.
