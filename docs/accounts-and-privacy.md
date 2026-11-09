# Accounts, figures and privacy

## More than one account

Each Claude account has its own weekly limit, and many people have two: a personal one in the desktop app, a work one in the terminal. weekly-budget keeps them apart.

- **Each account's week is its own.** Weeks are told apart by when they reset, so a chat shows its own account's week. Before a new chat's first figure arrives, it shows the week last seen on the same app (the terminal, VS Code or the desktop app), else the one read last.
- **Each account has its own settings**: its own plan, mode, heads-up and display. The settings header says whose they are.
- **An account seen for the first time** starts with a copy of the settings last used on the same app.
- **If Claude moves an account's reset** to another day or hour, its settings follow it, as long as a chat on it has asked Anthropic who it is.
- **The details say why they show a week**, under the account: "Week: this chat's own", or, before the chat has a figure of its own, "Week: the one the terminal last saw" or "Week: the latest any chat saw". Those two are guesses, and may be another account's week until the chat's first figure arrives.
- **Snooze is one for all.**

## How accounts are named

Each chat asks Anthropic who it is signed in as, and from then on the settings, the details ("Account: …") and `/budget`'s reply name the account:

- a team or enterprise account as its organization and email: "Acme (you@acme.dev)"
- a personal account as its email: "you@example.com"

Until a chat on an account has asked, that account is named by when its week resets: "Settings for the account whose week resets Tue 20:00".

## Where the figures come from

| Source | When | Notes |
| --- | --- | --- |
| **Claude Code itself** | after every response | The usage Claude Code reports with each reply. It comes with the response's headers, which are sent before the response is counted, so on its own it runs one reply behind. |
| **Anthropic, with the chat's own login** | 10 seconds after each of your turns ends, when a chat starts or its app's window connects, when you run `/budget`, and when the figure shown is over 15 minutes old | The exact figure. At most every 30 seconds per account after a turn or for `/budget`, otherwise every 10 minutes, across all your chats. |
| **Claude Code's `/usage`**, as a fallback | the same moments except after a turn, if Anthropic didn't answer | Runs `claude -p --no-session-persistence --strict-mcp-config /usage` in the background: a few seconds, nothing sent to the model, not saved as a session. It goes by the terminal's login, so it only updates a week the plugin already knows, matched by its reset time. |

If none of them answers, the plugin waits for your next response.

**Last-known figures are marked.** A figure over 15 minutes old ends with "as of 14:00" ("as of Tue 14:00" when it's from an earlier day) everywhere it shows, and the details say "Last known, as of 14:00".

**Usage elsewhere counts too.** What you use on claude.ai or the mobile app comes off the same weekly limit, and shows up in Claude Code with the next fresh figure.

## What is sent, and to whom

- **To Anthropic, and no one else.** Each chat asks two addresses on `api.anthropic.com`: who the account is (`/api/oauth/profile`: its email, name and organization) and its weekly usage (`/api/oauth/usage`).
- **Your login stays with Claude Code.** Claude Code attaches it itself, through a sealed handle that only works for Anthropic's own servers. The plugin never sees your token or password, and reads no credentials.
- **The `/usage` fallback** runs Claude Code on your machine; it sends nothing to the model.

These addresses are the ones Claude's own apps use; they aren't documented for plugins. If Anthropic changes them, the plugin quietly goes back to naming accounts by their reset time and to the other sources of figures.

## What is kept on your machine

Everything lives in one file, `~/.claude/plugins/store/weekly-budget_weekly-budget-<id>.json`, shared by all your sessions:

- your settings, one set per account
- the snooze
- for each running week: its latest figure, what today began with, how the figure rose over the last 2 hours (for the pace), and which warnings fired today
- which week each app last saw
- each account's email, name and organization, to know whose settings are whose
- when each account's figure was last fetched

Nothing leaves this file. Delete it to make the plugin forget everything; it starts over with the default settings.
