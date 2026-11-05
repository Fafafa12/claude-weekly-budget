import type { StatusStyle } from './config'
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

export function todayText(b: Budget): string {
  if (b.state === 'limit') return 'weekly limit reached'
  return b.left >= 0 ? `${pct(b.left)}% left today` : `${pct(-b.left)}% over today`
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
// mark with ▓, so that "over" reads without colour. Being over always shows at
// least one ▓ right after the mark, even when used rounds to the mark's cell.
export function textBar(used: number, allowed: number, cells = 20): string {
  const markAt = Math.min(cells - 1, Math.round((allowed / 100) * cells))
  const usedCells = Math.round((used / 100) * cells)
  const overCells = used > allowed ? Math.max(usedCells - markAt - 1, 1) : 0
  let bar = ''
  for (let i = 0; i < cells; i++) {
    if (i === markAt) bar += '│'
    else if (i < Math.min(usedCells, markAt)) bar += '█'
    else if (i > markAt && i <= markAt + overCells) bar += '▓'
    else bar += '░'
  }
  return bar
}

export function statusLine(
  b: Budget | null,
  style: StatusStyle,
  staleSince: number | null,
  tz: Tz,
  now: number,
): string {
  if (b === null) return NO_READING
  const stale = staleSince === null ? '' : ` · as of ${tz.hhmm(staleSince)}`
  if (b.state === 'limit') {
    return `🔴 Weekly limit reached · resets in ${countdown(b.resetMs - now)}${stale}`
  }
  const glyph = stateGlyph(b.state)
  const today = `${pct(Math.abs(b.left))}% ${b.left >= 0 ? 'left' : 'over'}`
  switch (style) {
    case 'A':
      return `${glyph} Week ${pct(b.used)}% / ${pct(b.allowed)}% allowed · today ${today}${stale}`
    case 'B':
      return `${glyph} ${textBar(b.used, b.allowed)} ${pct(b.used)}% → ${pct(b.allowed)}% · today ${today}${stale}`
    case 'C':
      return `${glyph} ${todayText(b)}${stale}`
  }
}

export function paneTitle(b: Budget | null): string {
  if (b === null) return 'Weekly budget · no reading yet'
  return `${stateGlyph(b.state)} ${pct(b.used)}% of ${pct(b.allowed)}% · ${todayText(b)}`
}
