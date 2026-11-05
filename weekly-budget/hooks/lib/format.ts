import { DAY_NAMES } from './config'
import type { StatusStyle } from './config'
import { OVER_MARGIN } from './plan'
import type { Budget, BudgetState } from './plan'
import type { Tz } from './tz'

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

const NO_READING = 'Weekly budget: no reading yet — send a message'

// One decimal, with a trailing ".0" dropped: 39 -> "39", 28.571 -> "28.6".
export function pct(n: number): string {
  return String(Math.round(n * 10) / 10)
}

export function stateGlyph(s: BudgetState): string {
  switch (s) {
    case 'ok':
      return '🟢'
    case 'near':
      return '🟡'
    case 'over':
    case 'limit':
      return '🔴'
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
    return `🔴 Weekly limit reached · resets in ${countdown(b.resetMs - now)}${stale}`
  }
  const glyph = stateGlyph(b.state)
  const today = balance(b)
  switch (style) {
    case 'A':
      return `${glyph} Week ${pct(b.used)}% / ${pct(b.allowed)}% allowed · today ${today}${stale}`
    case 'B':
      return `${glyph} ${textBar(b.used, b.allowed)} ${pct(b.used)}% → ${pct(b.allowed)}% · today ${today}${stale}`
    case 'C':
      return `${glyph} ${todayText(b)}${stale}`
  }
}

export function paneTitle(b: Budget | null, staleSince: number | null, tz: Tz, now: number): string {
  if (b === null) return 'Weekly budget · no reading yet'
  const summary = `${stateGlyph(b.state)} ${pct(b.used)}% of ${pct(b.allowed)}% · ${todayText(b)}`
  return `${summary}${staleMark(staleSince, tz, now)}`
}
