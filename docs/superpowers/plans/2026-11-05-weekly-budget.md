# Weekly Budget Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `weekly-budget`, a Claude Code plugin (TypeScript mod). It shows the weekly usage limit against a per-day plan the user defines, and warns, re-warns, blocks or snoozes when the user is over. It runs in the terminal and the VS Code extension.

**Architecture:**
- **Pure modules** in `hooks/lib/` hold all the logic: the plan math, formatting, the SVG, and the warning/gate decisions. They have no `$` and take time zone helpers as a parameter, so tests are deterministic.
- **`hooks/lib/store.ts`** and **`hooks/controller.ts`** are the only code that touches `$` (store, state, UI).
- **`hooks/register.tsx`** only binds events to controller functions.
- **The three panes** live in `hooks/ui/`.

**Tech Stack:**
- TypeScript in the Claude Code mod runtime: ES modules, no Node, no DOM, no npm dependencies. JSX uses `h`.
- Tests run with `claude plugin test` using `claude-code/testing`.
- Type-checking uses `tsc` 5.9 (already installed).

**Spec:** `docs/superpowers/specs/2026-11-05-claude-weekly-budget-design.md`. Read it before starting. §-numbers below refer to it.

## Global Constraints

### Plugin and runtime

- **Location:** the plugin lives at `weekly-budget/` in the repo root.
  - Manifest: `weekly-budget/.claude-plugin/plugin.json` with `"name": "weekly-budget"`, `"license": "MIT"`, `"types": "./types/index.d.ts"`.
  - Hooks: `weekly-budget/hooks/hooks.json` is exactly `{ "modules": ["./register.tsx"] }`.
- **Version floor:** Claude Code CLI ≥ 2.1.287 and VS Code extension ≥ 2.1.299, because mods are on by default from those versions. Development was done on 2.1.318.
- **Passing `$`:** pass `$` only to functions declared at the top level of a module file. `claude plugin validate` rejects anything else, including closures and methods.
- **Imports:** use static `import` declarations only. A module containing `import()` does not load.
- **Surfaces:** use `$.session.surfaces()`, never the deprecated `$.session.surface()`. `$.ui.notify` must never be used.

### Data

- **Weekly reading:** the `rateLimits` entry with `kind === "seven_day"`. `percentUsed` runs 0–100. `resetsAt` is an ISO string. Ignore every other `kind`.
- **The week:** `[resetMs − 7·24h, resetMs)`. Day boundaries are local midnights.
- **Weekday numbers:** `Date#getDay()` numbering, where 0 = Sunday … 6 = Saturday.
- **Test time zone:** always run the tests as `TZ=Etc/GMT-3 claude plugin test weekly-budget`.
  - The fixtures assume UTC+3. The reset at `2026-11-10T17:00:00Z` is Tue 20:00 local, and `2026-11-05T12:00:00Z` is Thu 15:00.
  - Pure-module tests use `fixedOffsetTz(180)`. Controller and pane tests run on `systemTz`, so they need `TZ` set to pass on any machine.
- **`$.store` keys** (persisted, shared by all sessions):
  - `config`
  - `snooze` (`{ until: number | null }`)
  - `ledger`
  - `lastReading`
- **`$.state` plugin key** (per session): `weekly-budget`, holding the values declared in `types/index.d.ts`.

### UI

- **Commands:** `budget` (with `snooze <30m|1h|…|today|off>` arguments) and `budget-config`. Never block them.
- **Pane ids:** `compact`, `details`, `settings`. The compact pane opens with `rows: 2`.
- **Colours** (spec §7), exactly:

  | Role | Colour |
  | --- | --- |
  | claude | `#D97757` |
  | track | `#B1ADA1` |
  | ok | `#8CB88A` |
  | near | `#E0B562` |
  | over | `#E08A7A` |
  | overDeep | `#C4553F` |
  | label | `#9A958A` |

- **State glyphs:** 🟢 ok · 🟡 near · 🔴 over and limit.
- **Defaults:**
  - mode `warn`
  - heads-up on, at `0.25` of today's share
  - status style `B`
  - snooze options `[60]` minutes, plus "rest of today"
  - compact panel on
  - no pins, so each day gets 100/7

## Review Focus

These are the input classes the spec implies but nothing else exercises. Each line names the task whose tests pin it.

1. **A week containing a DST change** (a 23h or 25h local day). The pieces must still total the sum of the plan's day shares, with no gap and no double count. Pinned in Task 1.
2. **`resetsAt` moves forward mid-session** (a new week, or an early reset). The ledger resets so warnings can fire again. A shared reading from the old window must never be used. Pinned in Tasks 3 and 4.
3. **Two sessions open at once.** A toast already recorded in the shared ledger by session A must not fire again in session B the same day. Pinned in Task 5.
4. **Bad plan input in settings:** a day in two groups, a share over 100 or not a number, pins totalling more than 100. The error is shown and the stored config stays unchanged. Pinned in Task 8.
5. **No reading at all** (a non-subscriber, or no session has ever had a response) **while in block mode.** The message goes through (fail open), and the display says "no reading yet". Pinned in Task 5.

---

### Task 1: Scaffold the plugin, remove the spike, plan math

**Files:**
- Delete:
  - `~/.claude/dev-mods/11f0d16f-5dad-46ee-bcdc-c6fb320ade97/budget-spike/`
  - the link `.claude/skills/budget-spike`
- Modify: `.gitignore`. Replace the `budget-spike` line with `.claude/skills/`.
- Create:
  - `weekly-budget/.claude-plugin/plugin.json`
  - `weekly-budget/hooks/hooks.json`
  - `weekly-budget/hooks/register.tsx`, which exports `register` with no hooks yet
  - `weekly-budget/tsconfig.json` = `{ "extends": "./.claude-plugin/types/tsconfig.json" }`
  - `weekly-budget/types/index.d.ts`
  - `weekly-budget/hooks/lib/tz.ts`
  - `weekly-budget/hooks/lib/config.ts`
  - `weekly-budget/hooks/lib/plan.ts`
- Link: `.claude/skills/weekly-budget → ../../weekly-budget`. This makes any new Claude session in this project, terminal or VS Code, load the plugin.
- Test: `weekly-budget/tests/plan.test.ts`

**Interfaces:**

`tz.ts`:

```ts
export type Tz = { midnightAfter(ms: number): number; weekday(ms: number): Weekday; dayKey(ms: number): string; hhmm(ms: number): string }
export const systemTz: Tz                                  // Date local-time methods
export function fixedOffsetTz(offsetMin: number): Tz       // tests; offsetMin 180 = UTC+3
```

`config.ts`:

```ts
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type Pin = { days: Weekday[]; percent: number }     // group share, split evenly over its days
export type Mode = 'warn' | 'rewarn' | 'block'
export type StatusStyle = 'A' | 'B' | 'C'
export type Config = { version: 1; pins: Pin[]; mode: Mode; headsUpEnabled: boolean; headsUpFraction: number; statusStyle: StatusStyle; snoozeOptionsMin: number[]; showCompactPanel: boolean }
export const DEFAULT_CONFIG: Config
export function dayShares(pins: Pin[]): number[]           // length 7, by Weekday; unpinned days share max(0, 100 − pinnedSum) evenly
export function validatePins(pins: Pin[]): string | null   // exact copy below
export function normalizeConfig(raw: unknown): Config      // unknown/invalid fields → defaults; invalid pins → []
```

`plan.ts`:

```ts
export type Reading = { percentUsed: number; resetsMs: number; at: number }
export type BudgetState = 'ok' | 'near' | 'over' | 'limit'
export type Piece = { weekday: Weekday; startMs: number; endMs: number; share: number }
export type Budget = { used: number; allowed: number; left: number; todayShare: number; todayIndex: number; state: BudgetState; pieces: Piece[]; resetMs: number; weekStartMs: number }
export function readingFrom(rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[], at: number): Reading | null
export function weekPieces(resetMs: number, shares: number[], tz: Tz): Piece[]
export function computeBudget(r: Reading, cfg: Config, now: number, tz: Tz): Budget
```

`types/index.d.ts` declares:

```ts
'weekly-budget': { reading: Reading | null; config: Config; snoozedUntil: number | null; settingsError: string | null; pinDraftDays: string }
```

Tasks 4–8 use these.

`validatePins` copy, exactly:
- `"Each day can only be in one group."`
- `"A share must be between 0 and 100%."`
- `"Pinned shares add up to more than 100%."`

**Algorithms that the signatures don't pin down:**

`weekPieces`:
- Walk from `t = resetMs − 7d` to `resetMs`.
- Each piece ends at `min(tz.midnightAfter(t), resetMs)`.
- `share = shares[tz.weekday(t)] × (pieceLength / thatLocalDayLength)`. The day length comes from midnight to midnight, which handles 23h and 25h days.
- Then scale every share by `sum(shares) / sum(piece shares)`, so the pieces total exactly the plan's sum.
- Skip nothing here. Zero-share pieces are kept, and the SVG drops them.

`computeBudget`:
- `todayIndex` is the piece where `startMs ≤ now < endMs`, clamped to `[0, last]`.
- `allowed` = the sum of shares for pieces `0..todayIndex`.
- `left = allowed − used`.
- `state`:
  - `limit` if `used ≥ 100`
  - else `over` if `left < 0`
  - else `near` if `left ≤ headsUpFraction × todayShare`
  - else `ok`
- Don't round here.

- [ ] **Step 1: Remove the spike, scaffold, link, and load the plugin-authoring skill.**
  - Loading the plugin-authoring skill lays the API types and names their path.
  - Once the engine has loaded the plugin, it also writes `weekly-budget/.claude-plugin/types/`.
  - Until then, type-check against the skill's bundled `types/claude-code.d.ts`, as its SKILL.md describes.

- [ ] **Step 2: Check the engine's local time zone.**
  - This machine is `+0300` (`date +%z`).
  - Write a temporary `weekly-budget/tests/tz-check.test.ts` that asserts `new Date('2026-11-05T12:00:00Z').getHours() === 15`.
  - Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.
  - **PASS:** delete the file and use `systemTz` as the runtime Tz.
  - **FAIL:** the engine has no local zone. Stop and report: `systemTz` then needs the offset from `$.process.run({ argv: ['date', '+%z'] })` at session start. Bring that design back before continuing.

- [ ] **Step 3: Write the failing tests in `tests/plan.test.ts`.**

  Shared setup:
  - `tz = fixedOffsetTz(180)`
  - `cfg = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }`
  - `reset = Date.parse('2026-11-10T17:00:00Z')`, which is Tue 20:00 local

  Tests:
  - `dayShares weekend 10%`: returns `[5, 18, 18, 18, 18, 18, 5]`.
  - `dayShares no pins`: every entry `≈ 100/7`.
  - `dayShares pins sum 100 leaves unpinned at 0`: with `[{ days: [1, 2, 3, 4, 5], percent: 100 }]`, Sat and Sun are `0`.
  - `validatePins`:
    - overlapping days → the "one group" message
    - `percent: 120` → the "between 0 and 100%" message
    - `percent: NaN` → the "between 0 and 100%" message
    - pins summing to 110 → the "more than 100%" message
    - a valid plan → `null`
  - `normalizeConfig garbage`:
    - `normalizeConfig(null)` and `normalizeConfig({ mode: 'x' })` both equal `DEFAULT_CONFIG`
    - `normalizeConfig({ mode: 'block' }).mode === 'block'`
  - `weekPieces Tue→Tue gives 8 pieces`:
    - weekdays `[2, 3, 4, 5, 6, 0, 1, 2]`
    - shares `≈ [3, 18, 18, 18, 5, 5, 18, 15]`
    - total `≈ 100`
  - `weekPieces DST week`: use a test Tz whose offset changes from 120 to 60 minutes at `2026-10-25T01:00:00Z`, with a reset at `2026-10-27T18:00:00Z`.
    - The total is `≈ 100`.
    - Consecutive pieces touch: `pieces[i].endMs === pieces[i + 1].startMs`.
    - The piece count is `8`.
  - `computeBudget` at `now = Date.parse('2026-11-05T12:00:00Z')` (Thu 15:00 local), with reading `{ resetsMs: reset, at: now }`:

    | Used | Allowed | Left | Today share | State |
    | --- | --- | --- | --- | --- |
    | 33 | ≈ 39 | ≈ 6 | ≈ 18 | `ok` |
    | 37 | | | | `near` |
    | 43 | | | | `over` |
    | 100 | | | | `limit` |

  - `readingFrom`:
    - picks `seven_day`, ignoring `five_hour` and `seven_day_opus`
    - returns `null` for `[]`
    - returns `null` for a `seven_day` without `resetsAt`

- [ ] **Step 4: Run the tests and see them fail.**
  - Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.
  - Expected: FAIL, because the exports are missing.

- [ ] **Step 5: Implement `tz.ts`, `config.ts` and `plan.ts` with the interfaces above.**

- [ ] **Step 6: Run the tests and type-check.**
  - Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS.
  - Run `tsc -p weekly-budget` and expect exit 0.
  - Run `claude plugin validate weekly-budget`. Expect no hook errors. README, LICENSE and icon findings are fine until Task 9.

- [ ] **Step 7: Commit**: `feat: scaffold weekly-budget plugin with plan math`.

---

### Task 2: Formatting and the bar SVG

**Files:**
- Create: `weekly-budget/hooks/lib/format.ts`, `weekly-budget/hooks/lib/svg.ts`
- Test: `weekly-budget/tests/format.test.ts`, `weekly-budget/tests/svg.test.ts`

**Interfaces:**
- **Consumes:** `Budget`, `BudgetState`, `StatusStyle`, `Tz` (Task 1).
- **Produces:**

```ts
export function pct(n: number): string                 // 1 decimal, ".0" dropped: 39 → "39", 28.571 → "28.6", -4 → "-4"
export function stateGlyph(s: BudgetState): string     // ok "🟢", near "🟡", over/limit "🔴"
export function todayText(b: Budget): string           // left ≥ 0: "6% left today"; else "4% over today"; limit: "weekly limit reached"
export function countdown(ms: number): string          // "5d 9h"; under 1 day "9h 5m"; under 1h "45m"
export function textBar(used: number, allowed: number, cells?: number): string  // default 20 cells
export function statusLine(b: Budget | null, style: StatusStyle, staleSince: number | null, tz: Tz, now: number): string
export function paneTitle(b: Budget | null): string
export const COLORS: { claude: string; track: string; ok: string; near: string; over: string; overDeep: string; label: string }
export function barSvg(b: Budget, width: number, tz: Tz): string
```

**Exact copy** (from the approved mockups, spec §7). `x` = `pct(|left|)`, `U` = `pct(used)`, `A` = `pct(allowed)`, `G` = glyph:

| Case | Text |
| --- | --- |
| Style A | `${G} Week ${U}% / ${A}% allowed · today ${x}% left` (or `… · today ${x}% over`) |
| Style B | `${G} ${textBar(used, allowed)} ${U}% → ${A}% · today ${x}% left` (or `over`) |
| Style C | `${G} ${todayText(b)}` |
| `limit` state, any style | `🔴 Weekly limit reached · resets in ${countdown(resetMs − now)}` |
| `b === null` | `Weekly budget: no reading yet — send a message` |
| `staleSince` set | append ` · as of ${tz.hhmm(staleSince)}` |
| `paneTitle` | `${G} ${U}% of ${A}% · ${todayText(b)}`; `null` → `Weekly budget · no reading yet` |

**`textBar` rule:**
- `markAt = min(cells − 1, round(allowed / 100 · cells))`
- `usedCells = round(used / 100 · cells)`
- Cell `i`:
  - `│` at `markAt`
  - else `█` if `i < min(usedCells, markAt)`
  - else `▓` if `markAt < i < usedCells`
  - else `░`

**`barSvg` rules** (spec §7, option B; geometry from the approved `bar-colors.html`):
- Height `34`. Track `y=6 h=8 rx=4`, `track` colour at opacity `0.32`.
- Segment `x` positions are cumulative `share / sumShares · width`. Zero-share pieces get no segment and no tick.
- A tick between segments: `track` colour at opacity `0.55`, `y 3→17`.
- Each label is the 3-letter weekday (`Sun`…`Sat`) at `y=31`, `font-size 10`, centred. It is drawn **only if the segment is ≥ 24px wide**. It uses the `label` colour, except today's, which is `claude`, `font-weight 700`.
- Today's highlight: a rect over today's segment, `y 0 h 20`, `claude` colour at opacity `0.14`.
- Fill from `0` to `min(usedX, allowedX)`, in `ok`, `near` or `over` by state.
- If `usedX > allowedX`: an extra rect from `allowedX` to `usedX` in `overDeep`.
- Marker: a line at `allowedX`, `y 1→19`, `claude` colour, width `2.5`, round cap.
- Must contain `xmlns="http://www.w3.org/2000/svg"` and stay under 131072 characters.

- [ ] **Step 1: Write the failing tests.**

  Use Task 1's fixture budgets: used 33 / 37 / 43 / 100 at Thu 15:00, with `tz = fixedOffsetTz(180)`.

  `format.test.ts`:
  - `pct`:
    - `pct(39) === '39'`
    - `pct(28.5714) === '28.6'`
    - `pct(6.0000001) === '6'`
  - `statusLine` style A, used 33: `'🟢 Week 33% / 39% allowed · today 6% left'`.
  - `statusLine` style B, used 43: starts with `'🔴 '`, contains `'43% → 39% · today 4% over'`, and the bar contains `▓`.
  - `statusLine` style C, used 37: `'🟡 2% left today'`.
  - `statusLine` with `limit`: starts with `'🔴 Weekly limit reached · resets in '`.
  - `statusLine` with a `null` budget: the no-reading text.
  - `statusLine` with `staleSince = Date.parse('2026-11-05T07:44:00Z')`: ends with `' · as of 10:44'`.
  - `paneTitle`, used 33: `'🟢 33% of 39% · 6% left today'`.
  - `textBar(33, 39)`: length 20, `│` at index 8.
  - `countdown`:
    - `countdown((5 * 24 + 9) * 3600e3) === '5d 9h'`
    - `countdown(45 * 60e3) === '45m'`

  `svg.test.ts`, with `width = 520`:
  - The output has no `>Tue<` label for the first piece, which is 15.6px wide. It has exactly one `>Tue<`, for the last piece.
  - Today's label is `fill="#D97757"` with `font-weight="700"` on `>Thu<`.
  - The marker line has `x1="202.8"`. Format coordinates with at most 1 decimal.
  - For used 33, the fill is `#8CB88A`. For used 43, both `#E08A7A` and `#C4553F` appear.
  - With a plan `[{ days: [6], percent: 0 }]`, there is no `>Sat<`.
  - Length is under `131072`.

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement `format.ts` and `svg.ts`.**

- [ ] **Step 4: Run the tests and type-check.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 5: Commit**: `feat: status line styles, titles and Claude-coloured bar SVG`.

---

### Task 3: Warning, gate and snooze decisions (pure)

**Files:**
- Create: `weekly-budget/hooks/lib/warnings.ts`
- Test: `weekly-budget/tests/warnings.test.ts`

**Interfaces:**
- **Consumes:** `Budget`, `Config`, `Tz`, `pct`.
- **Produces:**

```ts
export type Toast = 'headsUp' | 'over'
export type Ledger = { weekKey: number; headsUpDay: string | null; overDay: string | null }   // weekKey = resetMs
export function measureToast(b: Budget, cfg: Config, ledger: Ledger | null, snoozedUntil: number | null, now: number, tz: Tz): { toast: Toast | null; ledger: Ledger }
export type Gate = { drop: string } | { toast: 'over' } | null
export function gatePrompt(b: Budget | null, cfg: Config, snoozedUntil: number | null, now: number, isExempt: boolean): Gate
export function toastText(t: Toast, b: Budget): string
export function blockReason(b: Budget): string
export function parseSnooze(arg: string, now: number, tz: Tz): { until: number | null } | { error: string }
```

**Rules** (spec §8):

`measureToast`:
1. If `ledger` is null or `ledger.weekKey !== b.resetMs`, start a fresh ledger.
2. If snoozed (`snoozedUntil > now`) or the state is `limit`, return no toast.
3. If the state is `over` and `ledger.overDay !== today`, toast `over` and set `overDay`.
4. Else, if the state is `near`, heads-up is enabled, `headsUpDay !== today`, and `overDay !== today`, toast `headsUp` and set `headsUpDay`.

`today` is `tz.dayKey(now)`. Return the updated ledger even when there's no toast, because it may have reset.

`gatePrompt`:
- Return `null` if any of these is true:
  - `isExempt`
  - `b === null`
  - snoozed
  - the state is not `over`. Note that `limit` passes, because Claude stops on its own.
- If the mode is `block`, return `{ drop: blockReason(b) }`.
- If the mode is `rewarn`, return `{ toast: 'over' }`.
- If the mode is `warn`, return `null`.

**Exact copy:**
- `headsUp`: ``Heads-up: ${pct(left)}% of today's budget left (${pct(used)}% of ${pct(allowed)}% used).``
- `over`: ``Over today's budget: ${pct(used)}% used, ${pct(allowed)}% allowed by tonight. Snooze with /budget snooze 1h.``
- `blockReason`: ``Over today's budget (${pct(used)}% of ${pct(allowed)}% allowed by tonight). To continue: /budget snooze 1h``

**`parseSnooze`:**
- `/^\s*(\d+)\s*(m|h)\s*$/` → `now + n·(60e3 | 3600e3)`
- `today` → `tz.midnightAfter(now)`
- `off` → `{ until: null }`
- anything else → `{ error: 'Use /budget snooze 30m, 1h, today or off.' }`

- [ ] **Step 1: Write the failing tests.**

  Use Task 1's fixtures and `tz = fixedOffsetTz(180)`.
  - `heads-up fires once a day`:
    - used 37, `ledger = null` → `headsUp`
    - again with the returned ledger → `null`
    - next day, `now + 24h`, with a recomputed near budget → `headsUp`
  - `over fires once a day, and suppresses heads-up that day`:
    - used 43 → `over`
    - again → `null`
    - then a near budget the same day → `null`
  - `ledger resets when resetsAt changes`: a ledger with `overDay = today` but an old `weekKey`, used 43 → `over`.
  - `snooze silences`: `snoozedUntil = now + 1h` → `null`, and the ledger is unchanged apart from a possible reset.
  - `limit never toasts`: used 100 → `null`.
  - `heads-up disabled`: `cfg.headsUpEnabled = false`, used 37 → `null`.
  - `gate`, used 43:

    | Mode | Result |
    | --- | --- |
    | `block` | `{ drop }` with the exact copy |
    | `rewarn` | `{ toast: 'over' }` |
    | `warn` | `null` |
    | `block`, `isExempt` | `null` |
    | `block`, snoozed | `null` |
    | `block`, `b === null` | `null` |
    | `block`, used 100 | `null` |

  - `parseSnooze`:
    - `'30m'` → `now + 1800000`
    - `'1h'` → `now + 3600000`
    - `'today'` → `Date.parse('2026-11-05T21:00:00Z')`
    - `'off'` → `{ until: null }`
    - `'soon'` → the error copy

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement `warnings.ts`.**

- [ ] **Step 4: Run the tests.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 5: Commit**: `feat: warning, block gate and snooze decisions`.

---

### Task 4: Store layer and reading selection

**Files:**
- Create: `weekly-budget/hooks/lib/store.ts`
- Test: `weekly-budget/tests/store.test.ts`

**Interfaces:**
- **Consumes:** `Config`, `normalizeConfig`, `Reading`, `Ledger`.
- **Produces.** All are top-level functions taking `$: EngineInterface`:

```ts
export const STALE_MS = 15 * 60e3
export async function loadConfig($): Promise<Config>                 // normalizeConfig(await $.store.get('config'))
export async function saveConfig($, c: Config): Promise<void>
export async function loadSnooze($): Promise<number | null>          // store 'snooze' → { until }
export async function saveSnooze($, until: number | null): Promise<void>
export async function loadLedger($): Promise<Ledger | null>
export async function saveLedger($, l: Ledger): Promise<void>
export async function loadSharedReading($): Promise<Reading | null>
export async function saveSharedReading($, r: Reading): Promise<void> // write if no stored reading, a different resetsMs, or r.at > stored.at
export function pickReading(session: Reading | null, shared: Reading | null, now: number): { reading: Reading | null; staleSince: number | null }
```

**`pickReading` rules:**
1. Discard any reading with `resetsMs ≤ now`, because its window is over.
2. Of the remaining readings with the **same** `resetsMs`, take the one with the later `at`. If the windows differ, take the later `resetsMs`.
3. `staleSince` is `reading.at` when `now − reading.at > STALE_MS`. Otherwise it is `null`.

Store values are plain JSON. Treat a malformed stored value as absent.

- [ ] **Step 1: Write the failing tests.**

  Use `mock.store(on, {...})` and `mock.clock(on)` from `claude-code/testing`. Call the functions with the test's `$`.
  - `loadConfig on empty store returns DEFAULT_CONFIG`.
  - `config round-trips`: `saveConfig` with mode `block`, then `loadConfig().mode === 'block'`.
  - `malformed snooze is null`: store `{ snooze: 'x' }` → `loadSnooze` returns `null`.
  - `saveSharedReading keeps the newer`:
    - save `{ at: 2 }`, then `{ at: 1 }` in the same window → the stored `at` is `2`
    - then a different `resetsMs` with `at: 1` → overwritten
  - `pickReading`:
    - a session reading from an expired window and no shared one → `{ reading: null }`
    - a shared reading 20 min old in the current window → that reading, with `staleSince = its at`
    - a session reading at `t` and a shared one at `t + 1` in the same window → the shared one
    - a shared reading from the previous window and a session reading from the new one → the session reading

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement `store.ts`.**

- [ ] **Step 4: Run the tests.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 5: Commit**: `feat: persisted config, snooze, ledger and shared readings`.

---

### Task 5: Controller wiring: status line, toasts, block, `/budget snooze`

**Files:**
- Create: `weekly-budget/hooks/controller.ts`
- Modify: `weekly-budget/hooks/register.tsx`
- Test: `weekly-budget/tests/controller.test.ts`

**Interfaces:**
- **Consumes:** everything above. Atoms are declared with `atom({ plugin: 'weekly-budget', key }, initial)` for `reading`, `config`, `snoozedUntil`, `settingsError` and `pinDraftDays`. Export them from `controller.ts` so the panes share them.
- **Produces.** All are top-level and take `$`:

```ts
export async function currentBudget($): Promise<{ budget: Budget | null; staleSince: number | null; cfg: Config; snoozedUntil: number | null }>
export async function refresh($): Promise<void>                       // re-read store → atoms; status line; retitle compact; invalidate render
export async function onMeasure($, rateLimits: readonly SessionRateLimit[]): Promise<void>
export async function onPrompt($, e: PromptSubmitInput): Promise<Gate> // register.tsx turns { drop } into the hook's return, { toast } into $.ui.toast
export async function runBudgetCommand($, args: string): Promise<string>
```

**Behaviour** (spec §7–§8):

`refresh`:
- Show the status line only when `(await $.session.surfaces()).includes('terminal')`. Otherwise call `$.ui.status(undefined)`.
- Use `statusLine(budget, cfg.statusStyle, staleSince, systemTz, now)`.

`onMeasure`:
- `readingFrom` → set the atom → `saveSharedReading`.
- Then `measureToast` using `loadLedger` / `saveLedger` and `loadSnooze`.
- Then `$.ui.toast(toastText(...))` if there's a toast.
- Then `refresh`.

`onPrompt`:
- `isExempt = e.isMeta === true || (e.command?.name ?? '').startsWith('budget')`.
- Decide with `currentBudget`, which uses shared readings, so new chats are covered (spec §8, "Block without a fresh reading").

`runBudgetCommand`:
- `''` → open the details pane (Task 7 provides the render; here just call `$.ui.open({ id: 'details', title: 'Weekly budget' })`) and return `'Budget details opened.'`.
- `snooze …` → `parseSnooze`. Then:
  - save it and return `` `Snoozed until ${systemTz.hhmm(until)}.` ``
  - for `off`, return `'Warnings resumed.'`
  - on a parse error, return the error copy
- Anything else → `'Usage: /budget, /budget snooze 30m|1h|today|off'`.

**`register.tsx` bindings:**
- `session.start`:
  - `$.command.register({ name: 'budget', description: 'Show your weekly Claude budget (or: /budget snooze 1h)' })` and `{ name: 'budget-config', description: 'Set your weekly Claude budget plan and warnings' }`
  - `$.clock.every(60_000, …refresh)`
  - `void refresh($)`
  - then `next(e)`
- `session.attach`: `refresh` (Task 6 adds the compact pane here).
- `session.measure`: `onMeasure(e.rateLimits)`, then `next(e)`.
- `prompt.submit`: `onPrompt`:
  - `{ drop }` → return it
  - `{ toast }` → toast, then `next(e)`
  - otherwise `next(e)`
  - `.catch(($, e, next) => next(e))`, so it fails open
- `command.run { command: 'budget' }` → `{ text: await runBudgetCommand($, e.args) }`.

- [ ] **Step 1: Write the failing tests.**

  Raise events through the test's `$`: `$.session.start`, `$.session.measure`, `$.prompt.submit`, `$.command.run`. Answer `session.surfaces`, `session.usage`, `ui.status`, `ui.toast` and `ui.open` with `on(...)` hooks that record calls. Use `mock.store` and `mock.clock` set to Thu 15:00 local. Check the exact hook and answer names in `claude-code/testing` in the laid types.
  - `terminal shows status line`: surfaces `['terminal']`, measure with `seven_day` 33% → the last `ui.status` text starts with `'🟢 '` (style B).
  - `vscode hides status line`: surfaces `['vscode']` → the last `ui.status` call is `undefined`.
  - `heads-up toast once across two sessions`:
    - Run two tests' worth of plugin instances on the **same** `mock.store` entries object. If the kit can't share one, seed the second with the ledger the first wrote.
    - Measure at 37% → exactly one toast, with the heads-up copy.
  - `block drops the next message from a shared reading`:
    - store `config.mode = 'block'`
    - store `lastReading` = 43% in the current window, written 30 min ago
    - no measure in this session
    - `$.prompt.submit({ text: 'hi' })` → the result has `drop` with the block copy
  - `block lets /budget commands through`: the same setup with `command: { name: 'budget', args: 'snooze 1h' }` → no `drop`.
  - `block fails open with no reading`: an empty store and mode `block` → no `drop`.
  - `snooze command unblocks`:
    - `$.command.run({ command: 'budget', args: 'snooze 1h' })` → the text starts with `'Snoozed until '`
    - then `prompt.submit` → no `drop`
  - `rewarn toasts each message`: mode `rewarn`, 43% → two submits give two `over` toasts, and neither drops.
  - `new week resets ledger` (Review Focus 2): measure 43% → toast. Then measure 43% with `resetsAt + 7d` → toast again.

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement `controller.ts` and the bindings.**

- [ ] **Step 4: Run all tests and checks.**
  - Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS.
  - Run `tsc -p weekly-budget` and expect exit 0.
  - Run `claude plugin validate weekly-budget`. Expect no hook errors, and the hooks listed should include `session.start, session.attach, session.measure, prompt.submit, command.run{command=budget}`.

- [ ] **Step 5: Commit**: `feat: status line, toasts, block gate and /budget snooze`.

---

### Task 6: VS Code compact pane

**Files:**
- Create: `weekly-budget/hooks/ui/compact.tsx`
- Modify: `weekly-budget/hooks/controller.ts`, `weekly-budget/hooks/register.tsx`
- Test: `weekly-budget/tests/compact.test.tsx`

**Interfaces:**
- **Consumes:** the `currentBudget`, `barSvg`, `paneTitle` and `textBar` atoms.
- **Produces:**

```ts
export async function ensureCompact($): Promise<void>   // controller.ts
export async function renderCompact($, e): Promise<RenderElement>   // ui/compact.tsx
```

**`ensureCompact`:**
- Opens `$.ui.open({ id: 'compact', title: paneTitle(budget), rows: 2 })` only when all three are true:
  - `cfg.showCompactPanel`
  - `(await $.session.surfaces()).some(s => s !== 'terminal')`
  - this session hasn't opened it before. Keep a `compactOpened` flag in the `weekly-budget` state contract, and add it to `types/index.d.ts`.
- Call it from `session.start` and `session.attach`.

**`refresh`:**
- If `(await $.ui.panes()).some(p => p.id === 'compact')`, re-open it with the new title. This retitles it.
- Never reopen a closed pane.
- If the compact panel has been switched off in config, close it with `$.ui.close`.

**`renderCompact` body:**
- When `'Svg' in $.ui.resolve(e)`: `<Svg source={barSvg(b, width, systemTz)} alt={paneTitle(b)} width={width} height={34} />`, where `width = clamp(e.props.bodyColumns · 8 − 24, 200, 560)`.
- Otherwise: `<Text mono>{textBar(...)}</Text>`.
- With no budget: `<Text dimColor>No weekly reading yet — send a message.</Text>`.
- **No buttons** (spec §7).

- [ ] **Step 1: Write the failing tests** (mount `{ plugin: 'weekly-budget', component: 'Pane', requestId: 'compact', props }` as in the plugin-authoring `pane.test.tsx` example):
  - `vscode draws one Svg and no Button`: on `vscode`, with a 33% reading in the store → `find({ type: 'Svg' })` exists, and `findAll({ type: 'Button' })` is empty.
  - `no reading text`: an empty store → finds `Text` matching `/No weekly reading yet/`.
  - `opens only off-terminal`:
    - `session.start` with surfaces `['vscode']` → `ui.open` is called with `id 'compact'`, `rows 2`, and the title `'🟢 33% of 39% · 6% left today'`
    - with `['terminal']` → it isn't called
  - `never reopens a closed pane`: after open, `ui.panes` answers `[]`, then a measure runs → no further `ui.open` for `compact`.
  - `showCompactPanel false`: no open.

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement the pane, then add the `ui.render { component: 'Pane', requestId: 'compact' }` binding.**

- [ ] **Step 4: Run all tests and checks.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 5: Commit**: `feat: compact budget bar above the VS Code chat`.

---

### Task 7: Details pane (`/budget`)

**Files:**
- Create: `weekly-budget/hooks/ui/details.tsx`
- Modify: `weekly-budget/hooks/register.tsx`
- Test: `weekly-budget/tests/details.test.tsx`

**Interfaces:**
- **Consumes:** `currentBudget`, `saveSnooze`, the `snoozedUntil` atom, `barSvg`, `textBar`, `todayText`, `countdown`, `dayShares`.
- **Produces:** `export async function renderDetails($, e): Promise<RenderElement>`.

**Content** (spec §7). The layout is the builder's call. The pane must contain these, findable by text:
1. The bar: `Svg` where the surface supports it, a mono `textBar` elsewhere.
2. `Used ${pct(used)}%`, `Allowed by tonight ${pct(allowed)}%`, and `todayText(b)`.
3. `Resets ${weekdayName} ${tz.hhmm(resetMs)} (in ${countdown(...)})`.
4. A plan summary: the seven day shares in week order, e.g. `Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5`.
5. `Mode: warn` (or `re-warn` / `block`).
6. A snooze line, `Warnings snoozed until HH:MM` or `Warnings on`, plus these buttons:

   | Key | Label | Action |
   | --- | --- | --- |
   | `snooze-<n>` | e.g. `Snooze 1h` | one per `cfg.snoozeOptionsMin` |
   | `snooze-today` | `Snooze today` | |
   | `resume` | `Resume` | only while snoozed |

   Each press calls `saveSnooze` and updates the atom.

With no reading, the pane shows the no-reading text and the plan summary.

- [ ] **Step 1: Write the failing tests.** Loop the body over `['terminal', 'vscode'] as const`.
  - `details shows numbers`: with 33% → finds `Text` matching `/Used 33%/`, `/Allowed by tonight 39%/`, `/6% left today/` and `/Sat 5 · Sun 5/`.
  - `snooze button snoozes`:
    - `press('snooze-60')` → the store `snooze.until === now + 3600000`
    - then `Resume` appears
    - `press('resume')` → `until === null`
  - `snooze today`: `press('snooze-today')` → `until === Date.parse('2026-11-05T21:00:00Z')`.
  - `terminal has no Svg`: on `terminal`, `find({ type: 'Svg' })` is undefined, and a `Text` containing `│` exists.

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement the pane, then add the `ui.render { component: 'Pane', requestId: 'details' }` binding.**

- [ ] **Step 4: Run all tests and checks.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 5: Commit**: `feat: /budget details pane with snooze buttons`.

---

### Task 8: Settings pane (`/budget-config`)

**Files:**
- Create: `weekly-budget/hooks/ui/settings.tsx`
- Modify: `weekly-budget/hooks/register.tsx`, `weekly-budget/hooks/controller.ts`
- Test: `weekly-budget/tests/settings.test.tsx`

**Interfaces:**
- **Consumes:**
  - `loadConfig` and `saveConfig`
  - `validatePins`
  - `dayShares`
  - the `config`, `settingsError` and `pinDraftDays` atoms
  - `refresh` and `ensureCompact`
- **Produces:**
  - `export async function renderSettings($, e): Promise<RenderElement>`
  - `export async function applyConfig($, next: Config): Promise<string | null>`, which validates, saves, sets the atoms and calls `refresh`. It returns the error copy or `null`, and the stored config is unchanged on error.
  - `export function parsePercent(s: string): number | null`. It accepts `"10"`, `"10%"` and `"7.5"`, and gives `null` otherwise.
  - The `command.run { command: 'budget-config' }` binding, which opens `$.ui.open({ id: 'settings', title: 'Weekly budget settings' })` and returns `'Budget settings opened.'`.

**Controls.** Keys are exact, because the tests use them:

| Key | Control | Values |
| --- | --- | --- |
| `pin-days` | `Select` | `weekend` = [6, 0] (default), `weekdays` = [1..5], `mon`…`sun` = single days. Stored in the `pinDraftDays` atom. |
| `pin-percent` | `Input`, label `% of the week` | `onSubmit` → `parsePercent`. Adds or replaces the pin for those days: drop any existing pin that shares a day with them, then add. Then `applyConfig`. |
| `remove-pin-<i>` | `Button` per pin, label `Remove ${daysLabel} ${pct}%` | e.g. `Remove Sat+Sun 10%` |
| `reset-plan` | `Button` | pins → `[]` |
| (text) | the computed shares line | the same format as the details plan summary |
| (text) | a note when pins total exactly 100 and some days are unpinned | `Days without a share get 0%.` |
| `mode` | `Select` | `warn` / `rewarn` / `block`, labels `Warn once` / `Warn on every message` / `Block next message` |
| `heads-up` | `Select` | `off`, `0.1`, `0.25`, `0.5`, labels `Off` / `10% of today left` / `25% of today left` / `50% of today left` |
| `status-style` | `Select` | `A` / `B` / `C`, labels `Numbers` / `Bar` / `Minimal` |
| `snooze-options` | `Input`, label `Snooze options (minutes, comma-separated)` | `"30, 60, 120"` → `[30, 60, 120]`. Error copy: `Snooze options must be whole minutes, like 30, 60.` |
| `compact-panel` | `Select` | `on` / `off`. After applying, call `ensureCompact` or close the pane. |

Show the `settingsError` atom, when set, as `<Text color="error">`. Clear it on the next successful apply.

- [ ] **Step 1: Write the failing tests.** Loop over `['terminal', 'vscode'] as const`.
  - `add weekend pin`: `select('pin-days', 'weekend')`, `input('pin-percent', '10')` → the stored `config.pins` is `[{ days: [6, 0], percent: 10 }]`, and a `Text` matches `/Sat 5 · Sun 5/`.
  - `replace overlapping pin`: then `select('pin-days', 'sat')`, `input('pin-percent', '2')` → the pins are exactly `[{ days: [6], percent: 2 }]`.
  - `bad percent keeps config` (Review Focus 4):
    - `input('pin-percent', 'abc')` → shows `/between 0 and 100%/`, and the stored config is unchanged
    - `'120'` → the same
  - `over 100 keeps config`: with weekdays at 95, add weekend 10 → `/more than 100%/`, unchanged.
  - `mode select`: `select('mode', 'block')` → the stored mode is `block`.
  - `snooze options`:
    - `input('snooze-options', '30, 60')` → `[30, 60]`
    - `'x'` → the error copy, unchanged
  - `compact off closes`: `select('compact-panel', 'off')` → `ui.close` is called with `'compact'`.

- [ ] **Step 2: Run the tests and see them fail.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget`.

- [ ] **Step 3: Implement it, then add the `ui.render { component: 'Pane', requestId: 'settings' }` binding.**

- [ ] **Step 4: Run all tests and checks.**
  - Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS.
  - Run `tsc -p weekly-budget` and expect exit 0.
  - Run `claude plugin validate weekly-budget` and expect no hook errors.

- [ ] **Step 5: Commit**: `feat: /budget-config settings pane`.

---

### Task 9: Packaging and live verification

**Files:**
- Create:
  - `weekly-budget/README.md`
  - `weekly-budget/LICENSE` (MIT; copyright "2026 weekly-budget contributors")
  - `weekly-budget/.claude-plugin/icon.png`
  - `.claude-plugin/marketplace.json` at the repo root
- Modify: `weekly-budget/.claude-plugin/plugin.json`. Add `"author": { "name": "<owner>" }`, asking the user for the name at this step, and `"icon": "./.claude-plugin/icon.png"`.

**README must cover** (at least 40 words, spec §11):
- what it does
- the plan model (Claude's reset-to-reset week, pins, the rest spread evenly, the allowance adding up)
- `/budget`, `/budget snooze …` and `/budget-config`
- the warn / re-warn / block modes and snooze
- terminal vs VS Code differences
- requirements: a Pro/Max/Ultra subscription, mods enabled, CLI ≥ 2.1.287 and VS Code extension ≥ 2.1.299
- what turns it off (`--safe-mode`, `--bare`, `disableAllHooks`, and admins' `allowManagedModsOnly`)
- install: `/plugin install weekly-budget --marketplace <owner>/<repo>`

**Icon:**
- Write a 512×512 SVG: a rounded square in `#D97757` with a cream (`#F4F3EE`) segmented bar and a marker.
- Convert it with `magick icon.svg -resize 512x512 weekly-budget/.claude-plugin/icon.png`, which is available on this machine.
- Keep the SVG source out of the plugin folder, in `assets/icon.svg` at the repo root.

**`marketplace.json`:** one plugin entry, `{ "name": "weekly-budget", "source": "./weekly-budget", "description": … }`. Follow the format in the plugin-authoring reference's "Sharing a mod".

- [ ] **Step 1: Write the README, LICENSE, icon, marketplace.json and manifest fields.**

- [ ] **Step 2: Run the directory checks.** Run `claude plugin validate weekly-budget --profile directory`. Expect `✔`, with no README, LICENSE or icon findings.

- [ ] **Step 3: Run the full tests and type-check again.** Run `TZ=Etc/GMT-3 claude plugin test weekly-budget` and expect PASS. Run `tsc -p weekly-budget` and expect exit 0.

- [ ] **Step 4: Live check in the terminal.** Start a new `claude` session in the repo, which loads the plugin through `.claude/skills/weekly-budget`. Send one message, then confirm each of these:
  - The status line shows style B with a 🟢, 🟡 or 🔴 glyph.
  - `/budget` opens the details pane with no Svg.
  - `/budget-config` changes the style to A, and the status line updates.
  - `/budget snooze 1h` replies `Snoozed until …`.
  - The compact pane does **not** open by itself.

- [ ] **Step 5: Live check in VS Code. Ask the user to do this step and report.** Open the repo, start a new Claude chat, send one message, then confirm each of these:
  - There is no text status line.
  - The compact pane sits above the chat box, with the summary title and a Claude-coloured share-sized bar.
  - ✕ closes it, and it stays closed.
  - `/budget` and `/budget-config` work, with real dropdowns.
  - Setting mode to block with the plan lowered below current usage holds back the next message with the block reason.
  - `/budget snooze 1h` lets it through.
  - Undo the test plan afterwards.

- [ ] **Step 6: Commit**: `feat: package weekly-budget for the plugin marketplace`.
