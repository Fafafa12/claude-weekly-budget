# Design decisions

Why weekly-budget behaves the way it does. Each rule here was a deliberate choice; change one only knowing what it was protecting.

## What it's for

See, at any moment, how the week is going against **your own plan** for spreading the weekly limit across the days, in every Claude app you use, and be warned when you run ahead of it.

**What would make it a failure, even if it worked:**

1. **Warnings that pop up too often.** The reason anyone would uninstall it. Every warning rule below leans quiet.
2. **Interrupting a running task.** Block only ever holds back the *next* message.
3. **Reopening a panel the person closed.** Only their own `/budget` brings it back.
4. **Showing a stale number as if it were live.** Old figures are always marked.

**Left out on purpose:** the 5-hour window, the per-model weekly counters, history beyond the current week, and API-key users (who have no weekly limit: the plugin simply shows nothing to budget).

## The budget model

- **The week is Claude's window**, `[reset − 7 days, reset)`, not Monday to Sunday: that's the limit that actually resets. Nothing assumes 7 days pass; a reset that moves early is simply a new week.
- **Days are local calendar days**, since that's how people plan. The week's first and last part-days are the same weekday and share its share by hours, so the week always totals 100%, also across daylight-saving changes.
- **Shares are per weekday** (Mon…Sun), pinned singly or in groups; the rest split evenly. It's the smallest model that covers "the weekend gets only 10%".
- **"Allowed by tonight" counts today's whole share from the moment the day begins.** The alternative, pro-rating today by the hour, would make "left today" shrink while you sleep.
- **"Over" is decided at the figure's precision:** under −0.05%, half the 0.1 display unit, so float noise never reads as over.
- **Leftover is a choice.** *Fixed* is the plain cumulative sum (what a day doesn't use lands on the next). *Adaptive* re-shares what's left of the week over the unpinned days ahead, in proportion to their plan. Adaptive's today's share is set from what had been used **when the day began** (one record per week, written by the first reading of the day, shared by all sessions), so it doesn't shrink while you work.

## Display

- **One budget, drawn the way each app allows.** The terminal has a status line and panes without `Svg`; VS Code has panels but no band above the prompt; the desktop app has the band. So: status line, panel, strip.
- **The state is in words and theme colours, not coloured dots.** "On track", "Running low", "Over today", "Weekly limit reached"; theme keys (`success`, `warning`, `error`, `claude`) follow Claude's theme on each surface.
- **The terminal status line carries the state without colour**: Claude Code colours plugin status lines itself and prefixes "⚠ weekly-budget:", so the text bar uses ▓ for usage past the mark.
- **The bar is the plan itself**: each day's segment as wide as its share, not as its hours, with the marker always at the end of today's segment. A 0% day has no segment; a segment too narrow for its name is unlabelled.
- **The bar is pure shapes, stretched to any width.** VS Code tells a plugin its width only in text cells, so the SVG is drawn on a 1000-wide grid with `preserveAspectRatio="none"` and non-scaling strokes, and the weekday labels are separate text boxes underneath.
- **Colours are Claude's, softened**: Claude orange `#D97757` for today and the marker, warm grey `#B1ADA1` for the track, sage `#8CB88A`, sand `#E0B562` and coral `#E08A7A` for the states, rust `#C4553F` past the marker. They must read on light and dark themes, since the SVG can't follow the theme.
- **VS Code's panel is compact by default**, with the details behind a quiet "▸ Details"; closing it is respected for the rest of the chat.
- **The desktop strip has ✕ per chat**, and `/budget` there only brings the strip back, opening nothing else.
- **`/budget` always replies in words**, because a phone driving a session through Remote Control shows replies but no panels.
- **Last-known figures are marked** " · as of 14:00" (or " · as of Tue 14:00" from an earlier day) everywhere, after 15 minutes without a fresh one.

## Warnings

- **Each warning fires at most once per local day, across all sessions**, recorded per week. Re-warn ("Every message") is the one exception, because the person asked for repetition, and it repeats only the over warning.
- **The heads-up and the first over warning need a fresh figure.** Re-warn and block may go by an older one, since within a week usage only goes up: a last-known "over" is a safe lower bound.
- **Block decides on the highest figure any session has for the current week**, so a brand-new chat, which has none of its own, is still held back. It **fails open**: no figure for this week, or any error, lets the message through.
- **Only a message a person is behind is gated.** Agent and automation prompts (task notifications, `/loop`, scheduled, other sessions and plugins) always pass. `sdk` and unclassified prompts are gated only when an app is attached, so a plain `claude -p` run always passes while VS Code is still held back.
- **A message typed while Claude works is never held back**: it joins the running task, which must finish. A message *queued to run next* is the next message, and is gated like any other.
- **`/budget` and `/budget-config` are never blocked**, so there's always a way out. **Snooze always wins**, and lets messages through in block mode.
- **At the weekly limit, no warnings**: Claude stops on its own.
- **Toasts, not OS notifications**: they reach every app and are quieter.

## Figures and accounts

- **Fresh figures without waiting for a reply**: a chat that just opened, or a figure gone stale, shouldn't need a message to update. In order: Anthropic's usage address with the chat's own login, then Claude Code's `/usage`, then waiting.
- **Only sessions a person drives fetch.** A script shouldn't trigger network calls or subprocesses. The desktop app's sessions start looking like scripts (SDK-driven, no surface), so the first app window to attach marks them as driven.
- **Throttled across sessions**: once every 10 minutes per account, every 30 seconds for `/budget`, recorded in the store so ten open chats don't fetch ten times.
- **Weeks are keyed by their reset time, rounded to the minute.** No session can see which account another is on, but each account's week resets at its own time. Rounding matters: replies say 20:00:00 where Anthropic says 19:59:59.7 for the same week.
- **Settings belong to an account's slot**: its reset time modulo a week, the same every week. If Claude moves an account's reset, its settings follow, once a chat on it has said who it is.
- **Account names come from Anthropic, through a sealed handle.** The plugin never holds a token or reads a credential; Claude Code attaches the login, and only for Anthropic's own servers. The answers stay on the machine.
- **The `/usage` fallback only moves a week the plugin already knows**, matched by the reset it names, since it runs with the terminal's login, which may be a different account from the chat's.

## The pace forecast

- **Today's pace is the last 2 hours**, from the figure the window began with: short enough to reflect what you're doing now, long enough to smooth whole-percent steps. With less read, at least half an hour.
- **The week's pace is the plain average per day so far**, after the first 12 hours. It's simple and explainable, at the cost of not knowing the plan's light days.
- **Neither warns.** The anti-goal on noise wins: it's in the details, for reading.

## Prior art

Nothing combined per-day shares, an accumulating allowance, warn/re-warn/block/snooze and every Claude app, but these showed the way: [claude-quota-budget](https://github.com/mikhin/claude-quota-budget) (days from the reset, blocking that fails open), [claude-week](https://github.com/georgetchelidze/claude-week) (a mod reading the rate limits), [claude-statusline](https://github.com/JamesCarron/claude-statusline) (counted days and accrual), [claude-pace](https://github.com/ElishaPervez/claude-pace) (days anchored to the reset) and [claude-usage-guard](https://github.com/eliahuhorwitz/claude-usage-guard) (override until reset).
