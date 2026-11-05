# weekly-budget

Your Claude subscription has a weekly usage limit. This plugin lets you plan how to spend it. You say how the week should be shared out across the days, and it shows where you stand against that plan, warns you when you run ahead of it, and can hold your next message back until you decide to carry on.

It works in the terminal and in the VS Code extension.

## How the plan works

- **The week is Claude's own week**, from one limit reset to the next, not Monday to Sunday. Days are cut at midnight in your local time zone.
- **You pin days or groups of days to a share of the week.** For example, the weekend (Saturday and Sunday together) gets 10%. Single days and Monday to Friday can be pinned too.
- **The days you don't pin share the rest evenly.** With no pins, every day gets one seventh. Pinned shares can't add up to more than 100%. If they add up to exactly 100%, any unpinned days get nothing.
- **The allowance adds up through the week.** What you have not used carries forward, and overspending eats into the days after. "Allowed by tonight" is the sum of the shares up to the end of today.
- **The days where the week starts and ends** are split by the hours that fall inside the week, so the shares still add up to 100%.

It shows how much of the week you have used, how much the plan allows by tonight, and what is left (or over) for today.

Advanced: `WEEKLY_BUDGET_TZ_OFFSET_MIN` in the environment overrides the time zone with a fixed offset, in minutes east of UTC (a whole number from -840 to 840, so `180` is UTC+3). It is normally unset.

## Commands

| Command | What it does |
| --- | --- |
| `/budget` | In the terminal, opens the details: used, allowed by tonight, today's balance, when the week resets, your plan, the mode and the snooze state, with snooze buttons. In VS Code, opens the budget panel (see below), even if you closed it. |
| `/budget snooze 30m`, `1h`, `today` or `off` | Snoozes warnings for that long (any number of minutes or hours works), until the end of today, or ends the snooze. |
| `/budget-config` | Opens the settings: the plan, the mode, the heads-up, the status line style, the snooze durations and the VS Code panel's view. |

## Warnings and modes

You choose one mode in `/budget-config`:

- **Warn** (the default). One notification the first time you go over, then nothing more that day.
- **Re-warn.** A notification on every message you send while you are over.
- **Block.** Your next message is held back, and so is each one after it while you are over. The text goes back into the prompt box so you lose nothing. A task that is already running finishes, and tool calls are never blocked.

Re-warn and block act only on messages you send yourself. A message you type while Claude is working passes, but one you queue to run next (`ctrl+x enter` by default) is held back like any other next message. Automated and agent messages pass through untouched: background task notifications, scheduled and `/loop` prompts, messages from other sessions or plugins, and `claude -p` and Agent SDK runs.

There is also an early **heads-up** for when little of today is left. By default it fires when 25% of today's share is left. You can pick 10%, 25% or 50%, or turn it off.

At the weekly limit itself it shows 🔴 "Weekly limit reached", with no notification and no block, because Claude stops on its own.

To get past a warning or a block, snooze. A snooze silences warnings and lets messages through in block mode. `/budget` and `/budget-config` are never blocked.

To keep it quiet, the heads-up and the over warning each fire at most once per local day, across all your sessions. Re-warn is the one exception, because you asked for repetition.

Block goes by the highest reading from any of your sessions in the current week, so the first message of a new chat is held back too. It lets messages through when there is no reading for this week yet, or if the plugin itself fails.

## Terminal and VS Code

|  | Terminal | VS Code |
| --- | --- | --- |
| Always on | A status line under the prompt. | One panel above the chat box. It opens by itself when a chat starts. |
| What it shows | A traffic-light glyph (🟢 on track, 🟡 heads-up, 🔴 over) and the numbers. Three styles: numbers, bar (the default, with a mark for what is allowed by tonight) and minimal. | The summary as the panel's title, with one bar for the week. Each day is as wide as its share of the plan, today is highlighted, and a marker shows what is allowed by tonight. Under the bar, the details. |
| Details and settings | `/budget` and `/budget-config` open panes. Nothing opens by itself. | `/budget` opens the panel, and `/budget-config` the settings, with real dropdowns and fields. |
| Making it smaller | Pick the minimal style. | Keep the compact view, or close the panel with its X, and it stays closed for that chat until you run `/budget`. |

Claude Code draws the status line itself: it puts "⚠ weekly-budget:" in front and decides the colour, which is why the glyph carries the state. In VS Code the plugin shows the panel and no status line.

**The VS Code panel has two views**, which you choose with **Compact panel (VS Code)** in `/budget-config`:

- **On (the default): the compact view.** The bar, with a "▸ Details" row under it. Click the row and the details open below the bar, and it reads "▾ Details". Click it again to fold them away.
- **Off: the full view.** The bar with the details always shown, and no toggle.

The details are used, allowed by tonight, today's balance, when the week resets, your plan, the mode, and the snooze state with its buttons. Changing the view never closes the panel, and keeps what you opened with the toggle. The terminal is unchanged: `/budget` opens the details pane, and no panel opens by itself.

The figures come from the usage Claude Code reports after each response. Before your first response in a new session, the plugin uses the highest reading another of your sessions reported in the same week. If there is none, it says "no reading yet". A reading over 15 minutes old is shown as last known everywhere: the status line and the VS Code panel's title end with "as of 14:00" ("as of Tue 14:00" when it is from an earlier day), and the details say "Last known, as of 14:00". A re-warn notification or a block reason built on such a reading ends with the same mark. Usage on claude.ai or the mobile app shows up after your next response in Claude Code.

## Requirements

- A Claude Pro, Max or Ultra subscription. Without a weekly limit (for example with an API key) there is no reading: the plugin only shows "no reading yet", and never warns or blocks.
- Mods turned on. They are on by default from Claude Code CLI 2.1.287 and VS Code extension 2.1.299, so you need at least those versions.

## When it does nothing

The plugin does not run, or draws nothing, in these cases:

- `claude --safe-mode` and `claude --bare`
- `disableAllHooks` in your settings
- an administrator's `allowManagedModsOnly` policy
- `claude -p` (print mode) and Agent SDK runs: hooks run, but nothing is drawn and no message is held back

## Install

In a Claude Code session:

```
/plugin install weekly-budget --marketplace <github-owner>/<repo>
```

`<github-owner>/<repo>` is a placeholder. It will be filled in when the repository is published. Until then, use a local clone: `claude --plugin-dir ./weekly-budget`.

The plugin keeps its settings, your snooze and the last reading in Claude Code's plugin store on your machine. It makes no network requests of its own and reads no credentials.

## Development

From the repository root, `claude plugin test weekly-budget` runs the tests and `tsc -p weekly-budget` checks the types. The type check needs `weekly-budget/.claude-plugin/types/`, which is gitignored: a Claude session writes it when it loads the plugin. On a fresh clone, open a Claude session that loads the plugin once, for example `claude --plugin-dir ./weekly-budget`.

## License

MIT.
