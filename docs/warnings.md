# Warnings

weekly-budget is meant to keep you on plan without nagging. It warns when you go over **today's** share, gives an early heads-up when little of today is left, and stays quiet otherwise.

## The three modes

Pick one with **Mode** in `/budget-config`.

| Mode | When you're over today's share |
| --- | --- |
| **Warn once** (default) | One notification the first time you go over, then nothing more that day. |
| **Every message** | A notification on every message you send while you are over. |
| **Block** | Your next message is held back, and so is each one after it while you are over. |

The over notification reads:

```
Over today's budget: 43% used, 39% allowed by tonight. Snooze with /budget snooze 1h.
```

### Block, in detail

- **Only the next message is held back.** A task that is already running finishes, and tool calls are never blocked.
- **Nothing is lost.** The text goes back into the prompt box, with the reason: `Over today's budget (43% of 39% allowed by tonight). To continue: /budget snooze 1h`.
- **It goes by the highest reading any of your sessions has for this week**, so the first message of a brand-new chat is held back too, before that chat has a figure of its own.
- **It fails open.** With no reading for this week yet, or if the plugin itself fails, messages go through.
- `/budget` and `/budget-config` are never blocked, so you can always snooze or change the mode.

## The heads-up

An early notification when little of today's share is left:

```
Heads-up: 4.5% of today's budget left (34.5% of 39% used).
```

By default it fires when 25% of today's share is left. Set **Heads-up (of today left)** to 10%, 25% or 50%, or Off. There's no heads-up once you're already over.

## What is never held back or warned about

Every message and block mode only act on messages **you** send. These always pass:

- a message you type while Claude is working (it joins the running task); one you queue to run *next* (`ctrl+x enter` by default) counts as your next message and is held back like any other
- background task notifications, scheduled and `/loop` prompts
- messages from other sessions or plugins
- `claude -p` runs and Agent SDK scripts with no app attached

## Keeping it quiet

- **Once a day.** The heads-up and the over warning each fire at most once per local day, across all your sessions. Every message is the exception, because you asked for repetition, and it repeats only the over warning.
- **A new day is a new chance.** Each can fire again tomorrow.
- **Fresh figures for the once-a-day warnings.** The heads-up and the first over warning need a reading from the last 15 minutes. Every message and block may go by an older one, since usage only goes up within a week, and then say so: "… · as of 14:00".
- **At the weekly limit**, there are no warnings and no block: it shows "Weekly limit reached", because Claude stops on its own.

## Snooze

A snooze silences warnings **and lets messages through in block mode**.

| How | What it does |
| --- | --- |
| `/budget snooze 30m`, `/budget snooze 2h` | Snooze for that many minutes or hours (any whole number). |
| `/budget snooze today` | Until local midnight. |
| `/budget snooze off` | End the snooze now. |
| The buttons in the details | **Snooze 1h** (one per value in **Snooze options**), **Snooze today**, and **Resume** while a snooze runs. |

Change the buttons with **Snooze options (minutes, comma-separated)** in `/budget-config`, for example `15, 60, 120`. Snooze is one for all your accounts and sessions; the details say "Warnings snoozed until 16:00" while it runs.
