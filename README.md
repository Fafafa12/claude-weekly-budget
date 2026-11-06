# weekly-budget

Your Claude subscription has a weekly usage limit. This plugin lets you plan how to spend it. You say how the week should be shared out across the days, and it shows where you stand against that plan, warns you when you run ahead of it, and can hold your next message back until you decide to carry on.

It works in the terminal, in the VS Code extension and in the Claude desktop app.

## How the plan works

- **The week is Claude's own week**, from one limit reset to the next, not Monday to Sunday. Days are cut at midnight in your local time zone.
- **You pin days or groups of days to a share of the week.** For example, the weekend (Saturday and Sunday together) gets 10%. Single days and Monday to Friday can be pinned too.
- **The days you don't pin share the rest evenly.** With no pins, every day gets one seventh. Pinned shares can't add up to more than 100%. If they add up to exactly 100%, any unpinned days get nothing.
- **The allowance adds up through the week.** "Allowed by tonight" is what the plan allows up to the end of today. What you don't use, or use past your share, is handled by the **Leftover** setting: by default it lands on the next day; set to Adaptive, it is spread over the rest of the week (see [Leftover: Fixed or Adaptive](#leftover-fixed-or-adaptive)).
- **The days where the week starts and ends** are split by the hours that fall inside the week, so the shares still add up to 100%.

It shows how much of the week you have used, how much the plan allows by tonight, and what is left (or over) for today.

Advanced: `WEEKLY_BUDGET_TZ_OFFSET_MIN` in the environment overrides the time zone with a fixed offset, in minutes east of UTC (a whole number from -840 to 840, so `180` is UTC+3). It is normally unset.

## Commands

| Command | What it does |
| --- | --- |
| `/budget` | Replies with where the week stands, in one line: `49% of 67% · 18% left today · resets Tue 20:00` (fetching a fresh figure first). It also opens the details in the terminal, the budget panel in VS Code (even if you closed it), and brings back the strip in the desktop app if you hid it. On your phone, in a session you drive with Remote Control, the reply is what shows: panels only draw on the computer. |
| `/budget snooze 30m`, `1h`, `today` or `off` | Snoozes warnings for that long (any number of minutes or hours works), until the end of today, or ends the snooze. |
| `/budget-config` | Opens the settings: the plan, the leftover, the mode, the heads-up, the snooze durations, the status line style and the VS Code panel's view. See [Settings](#settings). |

## Settings

Run `/budget-config` to change them. **Each account has its own settings**, and the panel says which account it is changing, by its name ("Settings for Experts-cpa (you@company.com)"), or before a chat on it has asked Anthropic, by when its week resets ("…the account whose week resets Tue 20:00"), the same weekday and time every week. A change applies at once, in every open chat on that account. An account seen for the first time starts with a copy of the settings last used on the same app. Snooze is one for all. A value the plan's checks refuse, such as shares adding up to more than 100%, shows in red and changes nothing.

- **In VS Code**, click a choice.
- **In the terminal**, the settings open with the keyboard on them: Tab or the arrow keys move, Enter chooses, Esc goes back to the prompt. To come back to the panel later, press `ctrl+x tab`.

| Setting | Choices | Default | What it does |
| --- | --- | --- | --- |
| **Pin** and **% of the week** | Weekend, Weekdays, or one day; then a percent | no pins | Gives those days that share of the week, split evenly between them. Pinning a day that is already in a group replaces that group. |
| **Remove …** / **Reset plan** | buttons | | Remove one pin, or all of them. |
| **Leftover** | Fixed · Adaptive | Fixed | What happens to what a day doesn't use, or uses past its share. See below. |
| **Mode** | Warn once · Every message · Block | Warn once | How it warns when you are over today's budget. See [Warnings and modes](#warnings-and-modes). |
| **Heads-up (of today left)** | Off · 10% · 25% · 50% | 25% | An early notification when that much of today's share is left. |
| **Snooze options** | minutes, comma-separated | 60 | The snooze buttons in the details. "Snooze today" is always there too. |
| **Status line (terminal)** | Numbers · Bar · Minimal | Bar | The terminal's line under the prompt. No effect in VS Code or the desktop app, which have no such line. |
| **Compact panel (VS Code)** | On · Off | On | The VS Code panel's view: compact (details behind "▸ Details") or full (details always shown). |

The settings are kept in `~/.claude/plugins/store/`, shared by all your sessions. If Claude ever resets an account's week at another time, its settings follow it, as long as a chat on it has asked Anthropic who it is.

### Leftover: Fixed or Adaptive

Say the weekend is pinned at 10%, so each weekday gets 18%, and on Wednesday you use only 10% instead of 18%.

- **Fixed (the default).** Each day keeps its share. What a day leaves unused lands on the next day: on Thursday you are allowed 18% + the 8% left over, so 26% "left today". Going over works the same way: it all comes out of the next day.
- **Adaptive.** Your pinned days keep their share, and what is left of the week is shared again over the **unpinned days still ahead, today included**. Wednesday's 8% is spread over Thursday, Friday, Monday and Tuesday, about +2% each, and the weekend stays at 5% + 5%. Going over is spread the same way: it lowers every unpinned day ahead a little, instead of taking it all from tomorrow.

With Adaptive:

- **Today's share is set when the day begins**, from what you had used by then, so "left today" doesn't shrink while you work. The first reading of a day records that starting point for all your sessions.
- **The bar** shows the days already gone as one stretch, as wide as what you actually used, then today and the days ahead at their new shares. The "allowed by tonight" marker still sits at the end of today.
- **If every day is pinned**, there is nothing to share out, and it works like Fixed.

## Warnings and modes

You choose one mode in `/budget-config`:

- **Warn** (the default). One notification the first time you go over, then nothing more that day.
- **Re-warn.** A notification on every message you send while you are over.
- **Block.** Your next message is held back, and so is each one after it while you are over. The text goes back into the prompt box so you lose nothing. A task that is already running finishes, and tool calls are never blocked.

Re-warn and block act only on messages you send yourself. A message you type while Claude is working passes, but one you queue to run next (`ctrl+x enter` by default) is held back like any other next message. Automated and agent messages pass through untouched: background task notifications, scheduled and `/loop` prompts, messages from other sessions or plugins, and `claude -p` and Agent SDK runs.

There is also an early **heads-up** for when little of today is left. By default it fires when 25% of today's share is left. You can pick 10%, 25% or 50%, or turn it off.

At the weekly limit itself it shows "Weekly limit reached", with no notification and no block, because Claude stops on its own.

To get past a warning or a block, snooze. A snooze silences warnings and lets messages through in block mode. `/budget` and `/budget-config` are never blocked.

To keep it quiet, the heads-up and the over warning each fire at most once per local day, across all your sessions. Re-warn is the one exception, because you asked for repetition.

Block goes by the highest reading from any of your sessions in the current week, so the first message of a new chat is held back too. It lets messages through when there is no reading for this week yet, or if the plugin itself fails.

## Terminal, VS Code and the desktop app

|  | Terminal | VS Code |
| --- | --- | --- |
| Always on | A status line under the prompt. | One panel above the chat box. It opens by itself when a chat starts. |
| What it shows | The numbers in words ("6% left today", "2% over today"), with no coloured dots. Three styles: numbers, bar (the default, with a mark for what is allowed by tonight) and minimal. | A panel titled "Weekly budget". Its first line is the summary, e.g. "34% of 43.3% · 9.3% left today", with what you used and today's balance coloured by the state (green, amber or red, in Claude's theme). Under it, one bar for the week. Each day is as wide as its share of the plan, today is highlighted, and a marker shows what is allowed by tonight. Under the bar, the details. |
| Details and settings | `/budget` and `/budget-config` open panes. Nothing opens by itself. The settings open focused: Tab or the arrows move, Enter chooses, Esc goes back to the prompt (ctrl+x tab comes back). | `/budget` opens the panel, and `/budget-config` the settings, each setting a row of choices you click, the chosen one in Claude orange. |
| Making it smaller | Pick the minimal style. | Keep the compact view, or close the panel with its X, and it stays closed for that chat until you run `/budget`. |

Claude Code draws the status line itself: it puts "⚠ weekly-budget:" in front and decides the colour, which is why the words and the bar's ▓ (past what the plan allows) carry the state. In the panels the state reads as a coloured word: On track, Running low, Over today. In VS Code the plugin shows the panel and no status line.

**In the Claude desktop app** (its Code tab, on macOS, Windows or the Linux beta), the budget is a thin strip just above the message box: the coloured summary line, and the bar under it. At its right end, "▸ Details" opens the full details in the panel beside the conversation, ⚙ opens the settings there, and ✕ hides the strip for that chat (a new chat shows it again). `/budget` brings a hidden strip back, and opens no panel. No panel opens by itself. Install the plugin from the desktop app's plugin settings, or let it load from a project that has it.

**More than one account.** Each account has its own weekly limit, and the plugin keeps each account's week apart, told by when it resets: a chat shows its own account's week, and before its first reply, the week last seen on the same app (the terminal, VS Code or the desktop app). So the desktop app on one account and the terminal on another each show their own.

Claude Code on the web (claude.ai/code) and the regular Claude chat run no plugins, so the budget can't show there; their usage still counts, and appears here after your next response.

**The VS Code panel has two views**, which you choose with **Compact panel (VS Code)** in `/budget-config`:

- **On (the default): the compact view.** The coloured summary line with a quiet "▸ Details" link beside it, then the bar. Click the link and the details open below the bar, and it reads "▾ Details". Click it again to fold them away.
- **Off: the full view.** The summary line and the bar, with the details always shown, and no toggle.

The details are used, allowed by tonight, today's balance, when the week resets, your plan, the mode, and the snooze state with its buttons. Changing the view never closes the panel, and keeps what you opened with the toggle. The terminal is unchanged: `/budget` opens the details pane, and no panel opens by itself.

The figures come from the usage Claude Code reports after each response, and also from Anthropic directly, so that a chat shows a fresh figure before any reply: when a chat starts, when you run `/budget`, and when what is shown has gone over 15 minutes old (at most once every 10 minutes per account across all your chats, or every 30 seconds for `/budget`). Each chat asks about **its own account**, with its own login (see [Your account](#your-account)). If that doesn't answer, the plugin runs Claude Code's own `/usage` in the background instead (`claude -p --no-session-persistence --strict-mcp-config /usage`: a few seconds, nothing sent to the model, not saved as a session, the `claude` command on your PATH), which goes by the terminal's login and only moves the figure of a week a response has already told the plugin about. If both fail, the plugin simply waits for replies.

Before your first response in a new session, the plugin uses the highest reading another of your sessions reported in the same week. If there is none, it says "no reading yet". A reading over 15 minutes old is shown as last known everywhere: the status line and the VS Code panel's summary line end with "as of 14:00" ("as of Tue 14:00" when it is from an earlier day), and the details say "Last known, as of 14:00". A re-warn notification or a block reason built on such a reading ends with the same mark. Usage on claude.ai or the mobile app shows up after your next response in Claude Code.

## Your account

To name your accounts and fetch their usage, each chat asks Anthropic two things, with that chat's own Claude login: who the account is (its email and organization) and its weekly usage. Claude Code attaches the login itself, only for Anthropic's own servers: the plugin never sees your token or password. The answers are shown only to you: the account's name in the settings ("Settings for Experts-cpa (you@company.com)"), the details ("Account: …") and `/budget`'s reply. The plugin keeps the email, name and organization in its local store, `~/.claude/plugins/store/`, to remember which settings are whose.

These are the addresses Claude's own apps use (`api.anthropic.com/api/oauth/profile` and `/usage`); they are not documented for plugins, so if Anthropic changes them, the plugin quietly goes back to telling accounts apart by when their week resets, and to the other sources of figures above.

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
/plugin install weekly-budget --marketplace Fafafa12/claude-weekly-budget
```

To try it from a local clone instead: `claude --plugin-dir ./weekly-budget`.

The plugin keeps its settings, your snooze and the last reading in Claude Code's plugin store on your machine. It makes no network requests of its own and reads no credentials.

## Development

From the repository root, `claude plugin test weekly-budget` runs the tests and `tsc -p weekly-budget` checks the types. The type check needs `weekly-budget/.claude-plugin/types/`, which is gitignored: a Claude session writes it when it loads the plugin. On a fresh clone, open a Claude session that loads the plugin once, for example `claude --plugin-dir ./weekly-budget`.

## License

MIT.
