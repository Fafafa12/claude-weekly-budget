# Architecture

weekly-budget is a Claude Code plugin made of one **mod**: a TypeScript hooks module that Claude Code loads in every session. It has no server, no build step and no runtime dependencies.

## The files

```
.claude-plugin/marketplace.json    the marketplace: one plugin, source ./weekly-budget
weekly-budget/
  .claude-plugin/plugin.json       name, version, licence, icon, type contract
  hooks/hooks.json                 { "modules": ["./register.tsx"] }
  hooks/register.tsx               the hooks: which event calls what
  hooks/controller.ts              everything that touches the engine: state, store, decisions
  hooks/lib/                       pure logic, no engine calls
    plan.ts                        the week cut into days, shares, "allowed by tonight", the state
    config.ts                      settings: defaults, validation, shares per weekday, which account's
    forecast.ts                    the pace: samples, today's and the week's forecast, their wording
    format.ts                      the words: status line, summary, /budget's reply, countdowns
    svg.ts                         the bar, drawn as SVG, and its day segments
    warnings.ts                    which toast or block a reading calls for; snooze parsing
    store.ts                       the store's keys, their shapes, migrations, which week to show
    account.ts                     Anthropic's account and usage answers, parsed
    probe.ts                       the /usage fallback: its command, parsing, throttling, matching
    tz.ts                          local days: the machine's zone or a fixed offset
  hooks/ui/                        drawing, per surface
    compact.tsx                    VS Code's panel
    strip.tsx                      the desktop app's strip above the message box
    details.tsx, details-body.tsx  the details, shared by the pane and the panel
    settings.tsx                   the settings pane
    shared.tsx                     the bar, the summary, the state colours
  types/index.d.ts                 the type contract: the plugin's $.state values
  tests/                           the suite, one file per lib or ui module, plus the controller
scripts/screens.ts                 draws the README's pictures from lib/
```

The split matters: `lib/` is plain functions over plain values, tested directly; `controller.ts` is the only place that reads or writes state and the store; `ui/` only draws what the controller hands it.

## The events

| Event | What happens |
| --- | --- |
| `session.start` | Registers `/budget` and `/budget-config`; records whether a person drives the session and where it draws; starts a 60-second tick; refreshes the displays; opens VS Code's panel; fetches a fresh figure. |
| `session.attach` | A client (an app window, a phone) attached. The first one names the surface of a session that started with none, and makes it one someone drives, which fetches a fresh figure then (this is how the desktop app's chats get going). Then refreshes and opens VS Code's panel if needed. |
| `session.measure` | Claude Code reports usage after a response: the weekly figure is accepted (see below) and the displays refreshed. |
| `prompt.submit` | Decides whether the message is gated: a block drops it with a reason, a re-warn shows a toast. If the hook fails, the message goes through. |
| `ui.render` | Draws VS Code's panel (`Pane`, `compact`), the desktop strip (`AbovePrompt`), the details pane (`details`) and the settings (`settings`). |
| `command.run` | `/budget` (show, reply with the numbers, or snooze) and `/budget-config` (open the settings). |
| the tick | Every minute: refresh the displays, and fetch a fresh figure when the one shown is over 15 minutes old. |

## From a figure to a display

```
 reply's usage ──┐
 Anthropic ──────┼─► acceptReading ──► store: weeks[reset] ──► loadView ──► status line
 /usage ─────────┘     (day start,           reading            pickWeek      VS Code panel
                        samples,             dayStart           pickConfig    desktop strip
                        account link,        ledger             computeBudget details, settings
                        toasts)              samples            pace          /budget reply
```

- **`acceptReading`** keeps a figure in its week's record: the better figure (higher, then later), what today began with (for Adaptive), a sample when the figure rose (for the pace), the account's link to its week, and the heads-up or over toast if one is due.
- **`loadView`** reads everything once, at one `now`: picks the week to show (this chat's own, else the one its app last saw, else the latest), that account's settings and name, the budget, and the pace. Every display and decision comes from it.
- **`refresh`** pushes it out: the status line (terminal only) and a redraw of every open pane and the strip.

## Where the figures come from

1. **`session.measure`**, after each response: `rateLimits`' `seven_day` entry.
2. **Anthropic's usage address**, through `$.session.authorize()`'s sealed handle and `$.http.fetch`: the chat's own account, exact. Throttled to once every 10 minutes per account (30 seconds for `/budget`), across sessions, by `probeAt` in the store.
3. **`claude -p … /usage`** through `$.process.run`, when Anthropic doesn't answer: the terminal's login, matched to a known week by the reset it names. The probe sets `WEEKLY_BUDGET_PROBE` in its own environment so the Claude Code it starts doesn't probe in turn.

Only sessions a person drives fetch: a `-p` script or SDK run with nothing attached never does. Every figure is keyed by its reset time rounded to the minute, since sources report one reset a moment apart.

## The store

`$.store`, one JSON file per plugin install, shared by all sessions on the machine. Writes re-read first, since other sessions write too; a rare duplicate toast is acceptable.

| Key | What it holds |
| --- | --- |
| `weeks` | One record per running week (per account): `reading`, `dayStart`, `ledger` (which warnings fired today), `samples` (the figure's rises over the last 2 hours). Weeks that are over are dropped. |
| `configs` | Settings per account, keyed by the account's slot: its reset time modulo 7 days, the same every week. |
| `config` | The settings before there were accounts; used until an account has its own. |
| `accounts` | Per account id: email, name, organization, type, and the slot it was last seen in. |
| `surfaceWeeks` | The week each app (terminal, VS Code, desktop) last had a reading from. |
| `snooze` | `{ until }`, for all accounts. |
| `probeAt` | When each account (or `cli`, the `/usage` fallback) last fetched a figure. |
| `lastReading`, `dayStart`, `ledger` | An older version's single week, read as one week until `weeks` is written. |

## The session state

`$.state` atoms, declared in `controller.ts` and typed in `types/index.d.ts`, last for one session:

| Atom | What it holds |
| --- | --- |
| `reading` | This session's own latest figure, which tells its account's week. |
| `account` | Who this chat is signed in as, once Anthropic said. |
| `interactive`, `surface` | Whether a person drives the session, and where it draws. |
| `compactOpened`, `compactRows`, `detailsExpanded` | VS Code's panel: opened this session (so a closed one is never reopened), its height, its details open or folded. |
| `stripHidden` | The desktop strip was closed with ✕ in this chat. |
| `settingsError`, `pinDraftDays` | The settings pane: a refused value's message, and the days the Pin row has chosen. |

## Engine rules the code works within

- **`$` may only be passed to top-level functions**: the validator refuses anything else, which is why the controller is a flat list of functions.
- **`read` and `update` work only on atoms declared in the same file**, so every atom lives in `controller.ts`.
- **Imports are static**: no dynamic `import()`.
- **A `Box` width is a number or a whole percentage** (`/^\d{1,3}%$/`). The test kit doesn't check this; VS Code does, and draws nothing when it fails. The bar's day labels round their widths to whole percents for this.
- **The terminal has no `Svg`**, though the test kit's element table lists it: drawing code checks `e.surface === 'terminal'` and falls back to a text bar.
- **VS Code has no `AbovePrompt` band**, so it gets a panel; the desktop app gets the strip.
- **The desktop app is an SDK host**: its sessions start with `surface: null` and `isInteractive: false`, and its window arrives through `session.attach`.
- **The store is per install source**: the same plugin loaded from two places (an install and a `--plugin-dir` or project link) gets two stores, with two sets of settings.
