import { DAY_NAMES } from './config'
import type { Leftover, Mode, StatusStyle } from './config'
import { OVER_MARGIN } from './plan'
import type { Budget, BudgetState } from './plan'
import type { Tz } from './tz'

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

const NO_READING = 'Weekly budget: no reading yet — send a message'

// The mode and the leftover in the settings' own words, so that the details say what
// the settings do.
export const MODE_LABELS: Readonly<Record<Mode, string>> = { warn: 'Warn once', rewarn: 'Every message', block: 'Block' }
export const LEFTOVER_LABELS: Readonly<Record<Leftover, string>> = { fixed: 'Fixed', adaptive: 'Adaptive' }

// One decimal, with a trailing ".0" dropped: 39 -> "39", 28.571 -> "28.6".
export function pct(n: number): string {
  return String(Math.round(n * 10) / 10)
}

// The state in words, for the label a panel colours: the plain-text title and
// status line carry it in their numbers and the bar instead.
export function stateLabel(s: BudgetState): string {
  switch (s) {
    case 'ok':
      return 'On track'
    case 'near':
      return 'Running low'
    case 'over':
      return 'Over today'
    case 'limit':
      return 'Weekly limit reached'
  }
}

// Today's balance, "6% left" or "4% over", as the state has it rather than the sign
// of left: a budget within OVER_MARGIN of the plan is not over, and reads "0% left".
function balance(b: Budget): string {
  return b.state === 'over' ? `${pct(-b.left)}% over` : `${pct(Math.max(0, b.left))}% left`
}

export function todayText(b: Budget): string {
  if (b.state === 'limit') return 'weekly limit reached'
  return `${balance(b)} today`
}

// The two largest units that are not zero-padded away: "5d 9h", "9h 5m", "45m".
export function countdown(ms: number): string {
  const total = Math.max(0, ms)
  const days = Math.floor(total / DAY_MS)
  const hours = Math.floor((total % DAY_MS) / HOUR_MS)
  const minutes = Math.floor((total % HOUR_MS) / MIN_MS)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

// Used fills with █ up to the mark of what the plan allows (│), and past the
// mark with ▓, so that "over" reads without colour. Being over (by more than
// OVER_MARGIN, as the state has it) always shows at least one ▓ right after the
// mark, even when used rounds to the mark's cell.
export function textBar(used: number, allowed: number, cells = 20): string {
  const markAt = Math.min(cells - 1, Math.round((allowed / 100) * cells))
  const usedCells = Math.round((used / 100) * cells)
  const overCells = used > allowed + OVER_MARGIN ? Math.max(usedCells - markAt - 1, 1) : 0
  let bar = ''
  for (let i = 0; i < cells; i++) {
    if (i === markAt) bar += '│'
    else if (i < Math.min(usedCells, markAt)) bar += '█'
    else if (i > markAt && i <= markAt + overCells) bar += '▓'
    else bar += '░'
  }
  return bar
}

// When a last-known reading is from: "14:00" when that is today, "Wed 14:00" when
// it is from an earlier local day.
export function asOf(staleSince: number, tz: Tz, now: number): string {
  const time = tz.hhmm(staleSince)
  return tz.dayKey(staleSince) === tz.dayKey(now) ? time : `${DAY_NAMES[tz.weekday(staleSince)]} ${time}`
}

// What a line about the budget ends with: " · as of 14:00" for a last-known reading,
// nothing for a live one.
export function staleMark(staleSince: number | null, tz: Tz, now: number): string {
  return staleSince === null ? '' : ` · as of ${asOf(staleSince, tz, now)}`
}

export function statusLine(
  b: Budget | null,
  style: StatusStyle,
  staleSince: number | null,
  tz: Tz,
  now: number,
): string {
  if (b === null) return NO_READING
  const stale = staleMark(staleSince, tz, now)
  if (b.state === 'limit') {
    return `Weekly limit reached · resets in ${countdown(b.resetMs - now)}${stale}`
  }
  const today = balance(b)
  switch (style) {
    case 'A':
      return `Week ${pct(b.used)}% / ${pct(b.allowed)}% allowed · today ${today}${stale}`
    case 'B':
      return `${textBar(b.used, b.allowed)} ${pct(b.used)}% → ${pct(b.allowed)}% · today ${today}${stale}`
    case 'C':
      return `${todayText(b)}${stale}`
  }
}

// The details' line on why they show this week: the chat's own, or, with no figure of
// its own yet, the week its app last saw, or the latest any chat saw (either of which
// may be another account's).
const APP_NAMES: Record<string, string> = { terminal: 'the terminal', vscode: 'VS Code', desktop: 'the desktop app' }

export function weekBasisText(basis: 'own' | 'app' | 'latest', surface: string | null): string {
  const notYet = ' (this chat has no figure of its own yet)'
  switch (basis) {
    case 'own':
      return "Week: this chat's own"
    case 'app':
      return `Week: the one ${(surface !== null ? APP_NAMES[surface] : undefined) ?? 'this app'} last saw${notYet}`
    case 'latest':
      return `Week: the latest any chat saw${notYet}`
  }
}

export function paneTitle(b: Budget | null, staleSince: number | null, tz: Tz, now: number): string {
  if (b === null) return 'Weekly budget · no reading yet'
  const summary = `${pct(b.used)}% of ${pct(b.allowed)}% · ${todayText(b)}`
  return `${summary}${staleMark(staleSince, tz, now)}`
}

// What /budget replies, in one line of words: the used figure, what the plan allows
// by tonight, today's balance and the reset, marked when the reading is last known.
// A phone driving the session (Remote Control) shows replies but no panels.
export function budgetReply(b: Budget | null, staleSince: number | null, tz: Tz, now: number): string {
  if (b === null) return NO_READING
  const resets = `resets ${DAY_NAMES[tz.weekday(b.resetMs)]} ${tz.hhmm(b.resetMs)}`
  return `${pct(b.used)}% of ${pct(b.allowed)}% · ${todayText(b)} · ${resets}${staleMark(staleSince, tz, now)}`
}
