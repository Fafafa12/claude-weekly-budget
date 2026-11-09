# Troubleshooting

Real problems, and what fixes them. If yours isn't here, [open an issue](https://github.com/Fafafa12/claude-weekly-budget/issues) with what you see and which app you're in.

## "No weekly reading yet — send a message."

The plugin has no figure for this account's week yet.

- **Send a message**, or run `/budget`, which fetches one. A fresh chat usually gets its figure within seconds of starting.
- **Check the subscription.** With an API key, or any login without a weekly limit, Claude reports no weekly figure, so there's nothing to budget.

## The figure ends with "as of 14:00"

The figure is over 15 minutes old: no response came since, and the fresh fetch didn't answer. Run `/budget` to fetch one now. If it keeps happening, the plugin is falling back to waiting for responses; everything still works, just less fresh.

## The figure doesn't move right after a reply

A reply's own figure is read before that reply is counted, so it runs one reply behind. From 0.7.1, the plugin fetches the exact figure 10 seconds after each of your turns ends, and the panel, strip and status line move then. On 0.7.0 or earlier, run `/budget` to catch up, or [update](getting-started.md#update).

## The settings say "the account whose week resets Tue 20:00" instead of a name

No chat on that account has asked Anthropic who it is yet.

1. Make sure you're on 0.6.1 or later (the desktop app only names its account from 0.6.1): see [Update](getting-started.md#update).
2. Restart the app, open a chat and run `/budget`.

The name then shows in the settings, the details and `/budget`'s reply. With no Claude login in that app (an API key, for example), there is no name to ask for.

## Two apps show the same week, but they're on different accounts

Each account's week is told apart by when it resets. Before a chat's first figure, it shows the week last seen on the same app, so a brand-new chat can briefly show the other account's week. Send a message or run `/budget` and it switches to its own. If two accounts reset at exactly the same minute, the plugin can't tell them apart.

The details tell you which case you're in, under the account line. "Week: this chat's own" means the figure is the chat's own account's. "… last saw (this chat has no figure of its own yet)" means it's a guess. If a chat says "this chat's own" and still shows another account's numbers, that's a bug: please [report it](https://github.com/Fafafa12/claude-weekly-budget/issues) with a screenshot of the details, and the time.

## The desktop app doesn't show the new version

The desktop app keeps its own copy of the marketplace. Update from a terminal, then restart the desktop app:

```
claude plugin marketplace update weekly-budget
claude plugin update weekly-budget@weekly-budget
```

If it still shows the old version, uninstall and reinstall the plugin from the desktop app's plugin settings.

## The VS Code panel is empty, or doesn't appear

- **It was closed.** Closing the panel with its ✕ keeps it closed for that chat. Run `/budget`.
- **It draws nothing.** VS Code refuses a panel it can't lay out, and logs why. Open the Claude Code extension's log (on Linux, `~/.config/Code/logs/<date>/window1/exthost/Anthropic.claude-code/Claude VSCode.log`) and search for `weekly-budget` and "hook skipped". Please [report it](https://github.com/Fafafa12/claude-weekly-budget/issues) with that line.

## The terminal has no status line

- Check that mods are on, and that you're not in `--safe-mode`, `--bare` or under `disableAllHooks`: see [When it does nothing](getting-started.md#when-it-does-nothing).
- VS Code and the desktop app have no status line for plugins; they show the panel and the strip instead.

## My message was held back

You're in **Block** mode and over today's share. Your text is back in the prompt box. Run `/budget snooze 1h` (or `today`), then send it again, or switch **Mode** in `/budget-config`. `/budget` and `/budget-config` are never blocked. See [Warnings](warnings.md).

## The day changes at the wrong time

Days are cut at midnight in the machine's time zone. To force another zone, set `WEEKLY_BUDGET_TZ_OFFSET_MIN` to its offset in minutes east of UTC before starting Claude, for example `WEEKLY_BUDGET_TZ_OFFSET_MIN=180` for UTC+3. It's a fixed offset, with no daylight saving.

## "Pace today: not enough readings yet"

The pace needs at least half an hour of figures. It fills in as you work. Right after updating to 0.7.0, the plugin had no history yet.

## "Pace week" says I'll hit the limit, but my plan says I'm fine

The week's pace is a plain average per day. It doesn't know that your weekend is pinned light, so on a heavy weekday it can sound gloomier than your plan. Trust **left today** for the plan; read the pace as a trend.

## Nothing shows on claude.ai, the web, or my phone

claude.ai, Claude Code on the web and the regular Claude chat run no plugins. On a phone with Remote Control, panels draw on the computer: `/budget`'s reply is what the phone shows.

## Starting over

Delete `~/.claude/plugins/store/weekly-budget_weekly-budget-<id>.json` with your Claude apps closed. The plugin forgets every setting, week and account, and starts with the defaults.
