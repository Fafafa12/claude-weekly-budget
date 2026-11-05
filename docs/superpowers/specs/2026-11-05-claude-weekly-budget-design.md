# Claude Weekly Budget — design

Date: 2026-11-05
Status: draft, awaiting approval

## 1. What this is, and why

The user has a Claude Pro/Max subscription with a **weekly usage limit**: the 7-day % that Claude Code's `/usage` shows. They haven't hit the limit. What they want is to see, at any moment, how their week is going against **their own plan** for spreading usage across the days. For example, "the weekend gets only 10% of the week, the rest goes to weekdays."

They use Claude Code in **both the terminal and the VS Code extension**, so the tool must work in both. They plan to **publish it later on a Claude plugin marketplace**, so it has to be clean, configurable and documented for other users, not just tuned to one machine.

## 2. Goals

1. At any moment, show **used % of the week vs. allowed so far** and **what's left (or over) for today**, in the terminal and in VS Code.
2. Let the user define a **plan by calendar day**: pin some days or groups of days to a share (e.g. Sat+Sun = 10% total) and spread the rest evenly over the other days.
3. The allowance **accumulates through the week**. Unused allowance carries forward. Overspending eats into later days.
4. **Warn** when over, with a configurable **early heads-up**. Optional modes are **re-warn** and **block**, plus **snooze**.
5. **Configuration** happens in a settings panel opened by a command.

## 3. Non-goals (v1)

These are the builder's calls unless marked otherwise.

- Budgeting the **5-hour** window. Only the weekly limit counts.
- The **per-model weekly counters** (`seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`). v1 uses only the overall `seven_day`.
- A separate **VS Code extension** or a VS Code bottom-bar item. This was ruled out because one Claude Code plugin covers both surfaces (see §5).
- History, analytics, or charts beyond the current week.
- Supporting API-key / pay-as-you-go users, or Team/Enterprise setups where admins disable user mods. These cases should **degrade gracefully** and are not supported.
- Undocumented usage endpoints, reading credentials, or scraping `/usage` output.

## 4. Anti-goals: what would make this a failure even if it works

- **Warnings popping up too often.** This is the user's stated reason they'd uninstall it. See the anti-noise rules in §8.
- **Interrupting a running task.** Block mode only holds back the *next* message (user's decision).
- Reopening a panel the user just closed (builder's call). Only the user's own `/budget` reopens it.
- Showing a stale number as if it were live (builder's call).

## 5. Platform facts this design rests on

These come from research of the docs and a working spike on Claude Code CLI **2.1.318** and VS Code extension **2.1.318**.

### Form

- A **Claude Code plugin** containing a **mod** (a TypeScript hooks module: `hooks/hooks.json` → `"modules": ["./register.tsx"]`).
- The same plugin runs in the terminal and in the VS Code chat panel. Mods are on by default from CLI 2.1.287 and VS Code extension 2.1.299.
- Language: **TypeScript** (user's choice).

### Usage data

- Read it with `$.session.usage().rateLimits` and the `session.measure` event.
- Each entry is `{ kind, percentUsed, resetsAt }`, where `percentUsed` runs 0–100 with one decimal and `resetsAt` is an ISO timestamp.
- The weekly entry has `kind === "seven_day"`. This was **confirmed in the spike on both surfaces.** Example reading: `seven_day` 12%, resets `2026-11-10T17:00:00Z`.
- The list is **empty before the first Claude response in a session** and for non-subscribers.
- **Freshness:**
  - The reading updates after each turn, and when a window moves a whole point.
  - Usage on claude.ai or mobile only shows up after the next Claude Code response.
  - Different Claude Code sessions each get their own readings.

### Surfaces

- **VS Code panel:**
  - `Pane` with `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown`.
  - `$.ui.status` (text) and `$.ui.toast`.
  - **No `AbovePrompt` band in VS Code.**
  - SVG is drawn as an image, so there are no hover tooltips.
- **Terminal:**
  - `Pane` without `Svg`.
  - `$.ui.status`, which the host prefixes with `⚠ <plugin>:`.
  - `$.ui.toast`.
- **VS Code pane frame:**
  - The host always draws a "From the `<plugin>` plugin" label, the pane **title**, and a close ✕. These **cannot be removed.**
  - The title *can* be changed by calling `$.ui.open({ id })` again with a new `title`.
  - `rows` requests the inline height.
  - A pane sits **inline above the chat box** when the panel is narrow, and **docks beside** the conversation at 800px or wider.

### Other platform facts

- **Blocking:** a `prompt.submit` hook returning `{ drop: reason }` blocks the message. The typed text goes back into the input, and the user sees "Prompt dropped by a hook: <reason>".
- **Storage:**
  - `$.store` persists JSON across sessions under `~/.claude/plugins/store/`.
  - `$.state` lasts for the session.
  - Module variables reset on reload.
- **Concurrency:** several sessions can be open at once (terminal plus one or more VS Code chats). Each loads the mod, and they share `$.store`.
- **Mod rule** (the validator enforces it): `$` may only be passed to functions declared at the top level of the module.
- **When mods are off:** `--safe-mode`, `--bare`, `disableAllHooks`, admin `allowManagedModsOnly`, and `claude -p` (hooks run but nothing draws). The Team/Enterprise guard `sec-default` does **not** block `session.measure`, `prompt.submit` or `tool.call`.
- **Publishing:** the plugin directory validator requires a README (at least 40 words) and a LICENSE (file or SPDX `license` in `plugin.json`). It warns when there's no icon (square PNG, 512–2048 px).
- The `$.session.surface()` API is deprecated. Use `$.session.surfaces()`.

## 6. The budget model (decided)

### The week

- The week is **Claude's window**, `[resetsAt − 7 days, resetsAt)`. It is **not** Monday–Sunday.
- For the user, that is currently about **Tuesday 20:00 → Tuesday 20:00** local time.
- Day boundaries use the user's **local time zone**.

### The plan

- Shares are set per **calendar weekday** (Mon…Sun).
- The user can **pin** single days or **groups** to a % of the week. Example: weekend = 10% total, split evenly between Sat and Sun, so 5% each.
- **Unpinned days share the remainder evenly.**
- With no pins (the default), each day gets 100/7%.
- Pinned shares must total ≤ 100%. If they total 100% and some days are unpinned, those days get 0%. The settings panel should say so.

### Edge days

- The window starts and ends partway through a weekday. That weekday's share is **prorated by the hours of it that fall inside the window**.
- Because the window is exactly 7×24h, the first and last partial days are the same weekday, and together they add up to one full share. So the week still totals 100%.
- This was the builder's call, and the user approved the description. Builder: normalize to 100% across DST changes.

### The numbers

- **Allowed by tonight:** the sum of the shares of every day (or part-day) in the window up to the **end of today**. The whole of today's share counts from the start of the day. This is what the user approved ("allowed by tonight").
- **Today left / over:** allowed by tonight − used. Positive means left. Negative means over.
- Carry-forward and overspend follow from the cumulative sum. Nothing extra is needed.

### When `resetsAt` changes

- When a new week starts, or the reset comes early, recompute everything from the new `resetsAt` and **reset the warning ledger** (§8).
- One unverified report says weekly resets sometimes arrive after about 72h. The design must not assume 7 days elapse.

### Leftover: Fixed or Adaptive (added 2026-11-05, user-approved)

- A setting, **Leftover**, with two values. The stored field is `leftover`, defaulting to `'fixed'`, in config `version: 1`.
  - **Fixed** is everything above: "allowed by tonight" is the plan's cumulative share up to the end of today, so a day's leftover or overuse lands on the next day.
  - **Adaptive**: pinned days keep their planned share. What is left of the week, `planTotal − usedAtDayStart − pinned shares still ahead`, floored at 0, is shared over the unpinned days still ahead, today included, in proportion to their planned shares.
- Under Adaptive:
  - "Allowed by tonight" is `usedAtDayStart + today's adapted share`.
  - The days gone by become one stretch, scaled to `usedAtDayStart`, so the pieces still add up and the marker ends at today.
  - With no unpinned day ahead, it is the same as Fixed.
- **`usedAtDayStart`** is what had been used when today began. It is fixed for the day, so "left today" doesn't shrink while you work.
  - It is kept in `$.store` under `dayStart` (`{ weekKey, dayKey, percentUsed }`), shared by every session.
  - The first fresh reading of a day records it, from the last same-window reading of an earlier day, or 0 when the week began today, or the reading itself.
  - Without a record for today, the reading itself stands in.

## 7. Display (decided)

### Terminal

- **Status line under the prompt, always on.** Three styles are selectable in settings (the user wanted all three to be configurable), and the default is **B**:
  - **A, plain:** `● Week 41% / 54% allowed · today 13% left`
  - **B, bar with an "allowed" marker** (default): `████████░░░│░░░░░░░░ 41% → 54% · today 13% left`. The bar fills with used %. The `│` marks "allowed by tonight". Past the marker shows as over.
  - **C, minimal:** `● 13% left today`
- **State glyph.** `$.ui.status` takes plain text, and the host colours it and puts `⚠ <plugin>:` in front. The user saw this in the spike and accepted it. So the plugin can't colour the line itself. Every style **starts with a state glyph**: 🟢 on track, 🟡 at or below the heads-up threshold, 🔴 over. In style B, the part of the bar past the marker uses a different block character (e.g. `▓`) so "over" can be read without colour. This is the builder's call.
- **No panel opens by itself in the terminal.** Panels open only through the commands below.

### VS Code

- **No text status line.** It is suppressed when the session's surfaces don't include `terminal`.
- **One panel above the chat box**, opened automatically at session start, with a **compact** or a **full** view (the user's decision on 2026-11-05, after the live check; it replaces the first design, which had a compact pane and a separate details pane in VS Code):
  - **Title** (in the host-drawn header): the summary. Example: `🟢 12% of 28.6% · 16.6% left today`, with 🟢/🟡/🔴 for state.
  - **Body:** a thin SVG bar, measured in % of the week, with the details under it (see "Views" below).
    - **Each day's segment is as wide as its share of the plan** (user's decision, option B). This is not equal time per day. Weekdays at 18% are wide and weekend days at 5% are thin, so the bar shows the plan itself. The "allowed by tonight" marker always lands at the **end of today's segment**.
    - **Segments follow the window's calendar-day pieces in order.** A Tue 20:00 → Tue 20:00 window gives 8 pieces: a short partial Tuesday, six full days, and a long partial Tuesday. Each piece is as wide as its prorated share (§6).
    - Each segment is labelled with its weekday name (Wed, Thu, …). The label is **left out when the segment is too narrow** for it, for example the short partial Tuesday or a ~2% day. A **0% day has no segment.** This is the builder's call.
    - Today's segment is highlighted.
    - Used fill, with the part past the marker shown as over.
    - A marker at "allowed by tonight".
  - **Colours follow Claude's own look** (user's request: "the same style colour as Claude, maybe pastel"). Warm and soft, not saturated traffic-light colours. The approved mockup is `.superpowers/brainstorm/.../bar-colors.html`. Suggested values:
    - Claude orange `#D97757` for today's highlight (at low opacity) and for the marker
    - warm grey `#B1ADA1` for the track and day ticks
    - fill by state: pastel sage `#8CB88A` (on track), sand `#E0B562` (heads-up), coral `#E08A7A` (over), with the part past the marker in a deeper rust `#C4553F`
    - labels in a warm mid-grey `#9A958A`, today's label in Claude orange
  - The SVG is drawn as an image and can't follow VS Code's theme. The colours must read on both dark and light themes.
  - In panels, `Text` uses theme keys (`claude`, `success`, `warning`, `error`) so it follows Claude's theme on each surface.
  - **Views.** The stored setting `showCompactPanel` (config `version: 1`, kept for compatibility) now picks the view, not whether the panel shows. In `/budget-config` it is "Compact panel (VS Code)", on or off:
    - **Compact (on, the default):** the bar, with a **collapsed "▸ Details" row** under it. Clicking it opens the details below the bar and the label becomes "▾ Details"; clicking again folds them away. The toggle's state is per session (`detailsExpanded`) and survives a change of view.
    - **Full (off):** the bar with the details always shown, and no toggle.
    - **The details** are what the terminal's details pane shows, from one shared renderer: used, allowed by tonight and the coloured today line, the reset line, the plan, the mode, and the snooze line with its buttons (snooze options, snooze today, Resume). A last-known reading is marked as it is everywhere else.
  - This **supersedes the earlier "no expand/▾ button, and no other controls" line**: the user decided on 2026-11-05 to have the toggle and the details in the panel.
  - **Height:** the panel asks for `rows: 4` in the compact view while collapsed (the bar, a gap and the toggle row), and `rows: 18` when expanded or in the full view (17 before the details gained the Leftover line). These are counted from the layout and are to be tuned by eye in VS Code (R32, revising R30). A change of the toggle or of the view asks again with the new height, under the same title. The plugin keeps the rows it last asked for, because the engine's pane list has none, and asks again on the next refresh if the view was changed from another session (R33).
  - **Opening:** the panel opens once per session on any surface but the terminal, in either view. Switching the view never closes it, and never reopens one the user closed.
  - Update the title whenever the numbers change, but **only if the panel is still open** (check `$.ui.panes()`). Never reopen a panel the user closed during that session by itself: ✕ closes it for the chat, and only `/budget` brings it back.

### Commands (both surfaces)

- **`/budget`:**
  - **In VS Code** (any surface but the terminal is attached): opens the **one panel** (the `compact` pane) in whichever view is set, even after the user closed it, and counts as the session's open. It answers "Budget panel opened."
  - **In a terminal:** opens the **details pane**, which has the bar (as text) and the details, and answers "Budget details opened." Nothing else opens by itself there.
  - The details are:
    - used %, allowed by tonight, today left/over
    - reset time (local time plus a countdown)
    - a plan summary
    - the current mode
    - snooze state, with snooze buttons: the configured options, rest of today, resume
- **`/budget-config`:** opens the **settings panel**, containing:
  - plan editor: pin days or groups, see the computed per-day shares
  - mode: warn / re-warn / block
  - heads-up threshold, or off
  - status line style: A / B / C
  - snooze durations offered
  - the VS Code panel's view: compact or full
- **`/budget snooze <duration>`** and **`/budget snooze off`:** typed shortcuts, so the user can snooze straight after a warning or a block without opening a panel.
- Exact command names are the builder's call, as long as they don't collide with built-ins. Panels use real `Input`/`Select` controls in VS Code and their terminal equivalents in the terminal.

Mockups shown to the user are in `.superpowers/brainstorm/`:
- `glance.html`: status line styles A/B/C
- `bar-segments.html`: the user picked **B**
- `bar-colors.html`: the Claude-style palette

Screenshots of the spike panel were reviewed in the conversation.

## 8. Warnings, modes, snooze (decided)

### When warnings fire

- **Heads-up:** fires when today's left falls to or below the threshold. The default threshold is **25% of today's share remaining**. The threshold is configurable, and the heads-up can be turned off.
- **Over:** fires when used > allowed by tonight.

### Modes

| Mode | When over |
| --- | --- |
| **warn** (default) | One toast when crossing the line, then nothing more that day. |
| **re-warn** | A toast on **every message sent** while over. |
| **block** | The **next message is held back** (`prompt.submit` → `{ drop }`), and so is each later one while over. A task that is already running **finishes**. Nothing blocks tool calls. The reason text says how to get through: `/budget snooze 1h`. |

### Snooze

- Snooze suppresses warnings **and lets messages through in block mode** for the chosen duration (user's decision).
- Durations: 1h, rest of today, or a custom value.
- **Resume** ends a snooze early.

### Anti-noise rules (from the anti-goal)

- **Each warning type fires at most once per local calendar day, across all sessions.** The exception is re-warn mode, where the user asked for repetition. Use a ledger in `$.store` keyed by week and date.
- A new day is a new chance to cross, so each warning can fire again on a new day.
- No heads-up once the user is already over.
- No toasts while there's no reading, or while the only reading is stale. The builder defines "stale" for display and toasts.
- Snooze always wins.

### Block without a fresh reading (builder's call)

- Every new chat starts with no reading of its own. If block mode only trusted a session's own reading, the first message of every new VS Code chat would get through. That defeats the point of block.
- So block decides on the **highest reading in the current week** shared in `$.store` by any session, as long as it is for the **current window**: its `resetsAt` is still in the future. Within a window, usage only goes up, so an older reading is a safe lower bound.
- Block **fails open** only when no reading exists for the current window, or the plugin errors. A guard's `.catch` lets the message through.
- If an early reset (§6) goes unnoticed because nothing is getting through, snooze is the way out. The block reason says so.
- `/budget…` commands are never blocked.
- Re-warn repeats only the **over** warning. The heads-up stays once per day.
- Warnings are **toasts** (`$.ui.toast`) or the block reason. Never use `$.ui.notify`: it doesn't reach VS Code, and OS notifications are noisier. Colour changes in the status line and panel title are not "pop-ups" and are always fine.

### Timing caveat

The reading reflects the state after the last response. That means block decides on the next message using the highest reading in the current week, and that is acceptable.

### Rulings made during the build (R19–R24)

- **R19:** only a prompt a person can be behind is gated (block or re-warn): an absent origin, or `composer`, `bridge`, `slack-ping`, `sdk` or `unclassified`; not `isMeta`; not a `/budget…` command; and not one delivered into a running turn. Every agent and automation kind passes.
- **R20:** the stale mark is ` · as of HH:MM` for a reading from today, and ` · as of Tue HH:MM` (a three-letter weekday) for one from an earlier day. The status line and the panel title both use it.
- **R21:** a message the person types while a turn is running is never held back, because it joins the running task, which must finish. Only the next message after the turn is gated.
- **R22:** "over" is decided at the reading's precision: `left < -0.05`, half the 0.1 display unit. Between -0.05 and 0 it reads "0% left today".
- **R23 (revises R19):** `sdk` and `unclassified` prompts are gated only when `$.session.surfaces()` is non-empty, so a plain `claude -p` run, which has none, always passes, and VS Code, which attaches `vscode`, is still held back.
- **R24 (refines R21):** a prompt with `turnId` set and `wait === true` is queued to run as the next turn, so it is "the next message" and is gated like any other. A plain mid-turn message passes.

## 9. State and storage

- **`$.store`** (persists across sessions):
  - config
  - snooze-until
  - warning ledger
  - the last known reading with its timestamp, so a new session can show "last known: 12% at 10:44" (dimmed) before its first response
- **`$.state`** / atoms (per session): the current reading, the settings pane's state, whether this session has opened the VS Code panel, and whether its compact view has its details open.
- Concurrent sessions race on the ledger, and a rare duplicate toast is acceptable. Writes should be re-read-then-write to keep this small.

## 10. Edge cases

- **No reading yet** (new session, or a non-subscriber): show "no reading yet — send a message", or the stale last-known reading, clearly marked.
- **used ≥ 100%:** Claude itself stops, so show red and give no extra warnings.
- **Mods disabled or an unsupported setup:** the plugin does nothing. The README explains why.
- **Config changes mid-day:** recompute immediately. The new plan is not a new crossing for the ledger unless the state actually changes, for example from not-over to over.

## 11. Publishing

- The target is the **Claude plugin marketplace** (user's decision). Expect the plugin directory review plus a GitHub-hosted marketplace (`.claude-plugin/marketplace.json`) as the self-serve path.
- Needs:
  - a README explaining the plan model, the commands, and the limits (mods must be enabled; terminal vs VS Code differences)
  - a LICENSE. The builder's call is **MIT**.
  - a square PNG icon
- The **plugin name** shows to users as "From the `<name>` plugin" in VS Code. The builder's call is the working name **`weekly-budget`**, which the user can rename before publishing.

## 12. Prior art (searched 2026-11-05)

Nothing combines user-defined per-day shares, accumulating allowance, warn/re-warn/block/snooze, and both terminal and VS Code. Patterns worth borrowing:

- **mikhin/claude-quota-budget:** day index from `resetsAt`, block on exceed, fails open.
- **georgetchelidze/claude-week:** a mod reading `rateLimits` through `session.measure`.
- **JamesCarron/claude-statusline:** the config shape for counted days and accrual.
- **ElishaPervez/claude-pace:** day boundaries anchored to reset time.
- **eliahuhorwitz/claude-usage-guard:** override until reset as the unblock pattern.

The full report is in the session scratchpad and isn't needed to build this.

## 13. Left to the builder

- Module structure, the testing approach (`claude plugin test` with seeded store values), and type contracts.
- Exact copy for toasts, block reasons, panel labels, colours and spacing, within the shapes above.
- Exact command names and argument parsing.
- How the plan editor looks in each surface, as long as it can pin days and groups and shows the computed shares.
- Store schema and migrations (`shape` tags).

## 14. Spike to remove before building

The throwaway spike mod lives at `~/.claude/dev-mods/11f0d16f-5dad-46ee-bcdc-c6fb320ade97/budget-spike/`. It is linked into this project at `.claude/skills/budget-spike`. It is **not** the basis of the real plugin. Remove both before building, so its `/budget-*` commands don't collide with the real ones. What it proved is recorded in §5.
