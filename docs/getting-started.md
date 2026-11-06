# Getting started

## What you need

- **A Claude Pro, Max or Ultra subscription.** The plugin budgets the weekly limit that comes with it. With an API key there is no weekly limit, so there's nothing to budget: it shows "no reading yet" and never warns or blocks.
- **Claude Code with mods on.** They are on by default from Claude Code CLI 2.1.287 and the VS Code extension 2.1.299. The Claude desktop app's Code tab runs them too.

## Install

In any Claude Code session (terminal or VS Code):

```
/plugin install weekly-budget --marketplace Fafafa12/claude-weekly-budget
```

In the Claude desktop app, install it from the app's plugin settings, adding the marketplace `Fafafa12/claude-weekly-budget`.

A new chat shows the budget straight away: the status line in the terminal, a panel in VS Code, a strip above the message box in the desktop app. Before the first figure arrives it says "No weekly reading yet — send a message."

## Make a first plan

With no plan, every day gets one seventh of the week. Most people want something lighter on some days:

1. Run `/budget-config`.
2. On the **Pin** row, choose **Weekend** (or a single day, or Weekdays).
3. In **% of the week**, type `10` and press Enter.

The weekend now has 10% of the week, 5% a day, and the five weekdays share the other 90%, 18% each. The **Plan** line under it shows every day's share. To undo a pin, use **Remove …**, or **Reset plan** to clear them all. In the terminal, Tab or the arrow keys move, Enter chooses, Esc goes back to the prompt.

Each account has its own plan: see [Accounts, figures and privacy](accounts-and-privacy.md).

## Read the numbers

Run `/budget`, or look at the status line, panel or strip:

```
24% of 39% · 15% left today · resets Tue 20:00
```

- **24%**: how much of the week you've used, as Claude counts it.
- **39%**: what your plan allows by the end of today ("allowed by tonight").
- **15% left today**: the difference. Past it, it reads "4% over today".
- **resets Tue 20:00**: when Claude starts a new week.

The details (`/budget` in the terminal, **▸ Details** in VS Code and the desktop app) add where your pace leads, the reset countdown, your plan, the mode and the snooze buttons. [The plan](the-plan.md) explains each number.

## Pick how it warns

By default it warns once a day when you go over today's share, and gives a heads-up when 25% of today's share is left. In `/budget-config` you can switch **Mode** to **Every message** or **Block**, and change or turn off the heads-up. See [Warnings](warnings.md). To quiet it for a while: `/budget snooze 1h`.

## Update

From a terminal:

```
claude plugin marketplace update weekly-budget
claude plugin update weekly-budget@weekly-budget
```

Then restart your Claude apps: open sessions keep the version they started with. The desktop app keeps its own copy of the marketplace, so restart it too; if it still shows the old version, update it from its plugin settings.

## Uninstall

```
claude plugin uninstall weekly-budget@weekly-budget
```

Your settings stay in `~/.claude/plugins/store/`, in a file named `weekly-budget_weekly-budget-<id>.json`, in case you come back. Delete that file to forget them.

## When it does nothing

The plugin doesn't run, or draws nothing, in these cases:

- `claude --safe-mode` and `claude --bare`
- `disableAllHooks` in your settings
- an administrator's `allowManagedModsOnly` policy
- `claude -p` and Agent SDK scripts with no app attached: hooks run, but nothing is drawn and no message is held back
- claude.ai, Claude Code on the web and the regular Claude chat, which run no plugins (their usage still counts, and shows up in Claude Code with the next fresh figure)
