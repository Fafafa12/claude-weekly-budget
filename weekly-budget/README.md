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

## Commands

| Command | What it does |
| --- | --- |
| `/budget` | Opens the details: used, allowed by tonight, today's balance, when the week resets, your plan, the mode and the snooze state. It has snooze buttons. |
| `/budget snooze 30m`, `1h`, `today` or `off` | Snoozes warnings for that long (any number of minutes or hours works), until the end of today, or ends the snooze. |
| `/budget-config` | Opens the settings: the plan, the mode, the heads-up, the status line style, the snooze durations and the VS Code panel. |

## Warnings and modes

You choose one mode in `/budget-config`:

- **Warn** (the default). One notification the first time you go over, then nothing more that day.
- **Re-warn.** A notification on every message you send while you are over.
- **Block.** Your next message is held back, and so is each one after it while you are over. The text goes back into the prompt box so you lose nothing. A task that is already running finishes, and tool calls are never blocked.

There is also an early **heads-up** for when little of today is left. By default it fires when 25% of today's share is left. You can pick 10%, 25% or 50%, or turn it off.

To get past a warning or a block, snooze. A snooze silences warnings and lets messages through in block mode. `/budget` and `/budget-config` are never blocked.

To keep it quiet, the heads-up and the over warning each fire at most once per local day, across all your sessions. Re-warn is the one exception, because you asked for repetition.

Block goes by the latest reading from any of your sessions in the current week, so the first message of a new chat is held back too. It lets messages through when there is no reading for this week yet, or if the plugin itself fails.

## Terminal and VS Code

|  | Terminal | VS Code |
| --- | --- | --- |
| Always on | A status line under the prompt. | A small pane above the chat box. |
| What it shows | A traffic-light glyph (🟢 on track, 🟡 heads-up, 🔴 over) and the numbers. Three styles: numbers, bar (the default, with a mark for what is allowed by tonight) and minimal. | The summary as the pane's title, with one bar for the week. Each day is as wide as its share of the plan, today is highlighted, and a marker shows what is allowed by tonight. |
| Details and settings | `/budget` and `/budget-config` open panes. Nothing opens by itself. | The same commands, with real dropdowns and fields. |
| Making it smaller | Pick the minimal style. | Close the pane with its X, and it stays closed for that chat. Or turn it off in `/budget-config`. |

Claude Code draws the status line itself: it puts "⚠ weekly-budget:" in front and decides the colour, which is why the glyph carries the state. In VS Code the plugin shows the pane and no status line.

The figures come from the usage Claude Code reports after each response. Before your first response in a new session, the plugin uses the latest reading from another of your sessions in the same week, marked with its time once it is over 15 minutes old. If there is none, it says "no reading yet". Usage on claude.ai or the mobile app shows up after your next response in Claude Code.

## Requirements

- A Claude Pro, Max or Ultra subscription. Without a weekly limit (for example with an API key) there is no reading, and the plugin does nothing.
- Mods turned on. They are on by default from Claude Code CLI 2.1.287 and VS Code extension 2.1.299, so you need at least those versions.

## When it does nothing

The plugin does not run, or draws nothing, in these cases:

- `claude --safe-mode` and `claude --bare`
- `disableAllHooks` in your settings
- an administrator's `allowManagedModsOnly` policy
- `claude -p` (print mode): hooks run, but nothing is drawn

## Install

In a Claude Code session:

```
/plugin install weekly-budget --marketplace <github-owner>/<repo>
```

`<github-owner>/<repo>` is a placeholder. It will be filled in when the repository is published. Until then, use a local clone: `claude --plugin-dir ./weekly-budget`.

The plugin keeps its settings, your snooze and the last reading in Claude Code's plugin store on your machine. It makes no network requests of its own and reads no credentials.

## License

MIT.
