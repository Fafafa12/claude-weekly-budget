# Changelog

Every version of weekly-budget, newest first. Each one is also a [release on GitHub](https://github.com/Fafafa12/claude-weekly-budget/releases), tagged `vX.Y.Z`.

To update an installed copy, run `claude plugin marketplace update weekly-budget`, then `claude plugin update weekly-budget@weekly-budget`, and restart your Claude apps.

## 0.7.3 · 2026-11-09

### Added
- **The details say why they show this week**, in a dim line under the account: "Week: this chat's own" once the chat has a figure of its own, or, before that, "Week: the one the terminal last saw" (or VS Code, or the desktop app) or "Week: the latest any chat saw", each marked "(this chat has no figure of its own yet)". Those two may be another account's week, so a screenshot now shows why a chat on one account shows another's numbers.

## 0.7.2 · 2026-11-09

### Changed
- **The details use the settings' words.** They say "Mode: Warn once", "Every message" or "Block", and "Leftover: Fixed" or "Adaptive", as the settings do, instead of the internal names ("warn", "re-warn", "fixed", "adaptive").

## 0.7.1 · 2026-11-09

### Fixed
- **The figure catches up after each reply.** The weekly figure a reply brings comes with its response's headers, which are sent before that response is counted, so the VS Code panel, the desktop strip and the status line stayed one reply behind until `/budget` fetched the exact figure. Now, 10 seconds after each of your turns ends, the account's exact figure is fetched from Anthropic (at most every 30 seconds per account; subagents' turns and turns that cost nothing don't count).

## 0.7.0 · 2026-11-06

### Added
- **Where your pace leads**, in the details, under the numbers. *Pace today* turns your speed over the last 2 hours into the time today's share runs out ("3% an hour → today's share runs out around 20:00"), or says it lasts the day. *Pace week* carries the week's average per day to the reset ("13.4% a day → lasts until the reset, ending near 94%"), or says when it would reach the limit. The outcome is coloured: amber when it runs out, green when it lasts. Nothing new warns.
- **A new README**, with a tour of every app (terminal, VS Code, the desktop app, the settings and a phone), a worked example week, what each version brought, and where the plugin is stuck for now. The pictures are drawn from the plugin's own code by `scripts/screens.ts`, on a made-up week.

## 0.6.1 · 2026-11-06

### Fixed
- **The desktop app names its account.** Its chats start before its window has connected, so they never asked Anthropic who they were. The window connecting now counts as someone being there.
- **One week per reset.** Anthropic's usage address and replies report the same reset a moment apart (19:59:59.7 and 20:00:00), which made two weeks with two sets of settings, so the account's name came and went. Both now name the week by its reset to the nearest minute.

## 0.6.0 · 2026-11-06

### Added
- **Accounts by name.** Each chat asks Anthropic who it is signed in as, and the settings, the details and `/budget`'s reply name it ("Settings for Acme (you@acme.dev)"). Claude Code attaches the login itself, through a sealed handle: the plugin never sees the token.
- **Each chat fetches its own account's week** from Anthropic, so a fresh figure no longer depends on the terminal's login. Claude Code's `/usage` stays as the fallback.

## 0.5.0 · 2026-11-06

### Added
- **Each account has its own settings.** The settings say whose they are, by when that account's week resets. An account seen for the first time starts with a copy of the settings last used on the same app.

### Changed
- The status line setting is labelled "Status line (terminal)", since it changes nothing in VS Code or the desktop app.

## 0.4.0 · 2026-11-06

### Added
- **`/budget` replies with the numbers** ("24% of 39% · 15% left today · resets Tue 20:00"). A phone driving a session through Remote Control shows replies but no panels, so this is the budget on a phone.

## 0.3.0 · 2026-11-06

### Added
- **A fresh figure without waiting for a reply:** when a chat starts, when you run `/budget`, and when the shown figure is over 15 minutes old. At most once every 10 minutes across all your chats, or every 30 seconds for `/budget`.

### Fixed
- **Each account's week is kept apart.** With a personal account in one app and a work account in another, each shows its own week.

## 0.2.2 · 2026-11-06

### Added
- A **⚙ settings button** on the desktop strip. In the desktop app, `/budget` now only brings the strip back, and opens no panel.

## 0.2.1 · 2026-11-06

### Added
- A **✕ close button** on the desktop strip, which hides it for that chat. `/budget` brings it back.

## 0.2.0 · 2026-11-06

### Added
- **The Claude desktop app:** the budget is a thin strip above the message box, with the coloured summary, the week's bar and a link to the details.

## 0.1.0 · 2026-11-05

The first release.

### Added
- **The plan:** pin a day, the weekend or the weekdays to a share of the week; the other days share the rest evenly. The allowance adds up through the week, and the week is Claude's own (reset to reset), cut at local midnights.
- **Leftover: Fixed or Adaptive.** What a day doesn't use (or uses past its share) lands on the next day, or is spread over the unpinned days still ahead.
- **The terminal status line**, in three styles: numbers, a bar with a mark for what's allowed by tonight, or minimal.
- **Warnings:** warn once, re-warn on every message, or block the next message, with a heads-up when little of today is left, and snooze (`/budget snooze 1h`, buttons in the details). Only your own messages are ever held back.
- **`/budget`** for the details and **`/budget-config`** for the settings, as rows of choices (keyboard-driven in the terminal).
- **The VS Code panel** above the chat: the coloured summary, the week as a bar with each day as wide as its share, and the details, compact behind "▸ Details" or always shown.
- Last-known figures marked "as of 14:00" everywhere, and `WEEKLY_BUDGET_TZ_OFFSET_MIN` to override the time zone.
- Packaged for the plugin marketplace: `/plugin install weekly-budget --marketplace Fafafa12/claude-weekly-budget`.
