import type { Reading } from '../../types'
import { dayShares } from './config'
import type { Config, Weekday } from './config'
import type { Tz } from './tz'

// Reading lives in the plugin's contract, types/index.d.ts.
export type { Reading }

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export type BudgetState = 'ok' | 'near' | 'over' | 'limit'
// A stretch of the window inside one local calendar day.
export type Piece = { weekday: Weekday; startMs: number; endMs: number; share: number }
export type Budget = {
  used: number
  allowed: number // what the plan allows by the end of today
  left: number // allowed - used; negative when over
  todayShare: number
  todayIndex: number // into pieces
  state: BudgetState
  pieces: Piece[]
  resetMs: number
  weekStartMs: number
}

// The weekly reading out of what the session reports, or null when there is none.
export function readingFrom(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
  at: number,
): Reading | null {
  const week = rateLimits.find(l => l.kind === 'seven_day')
  if (!week?.resetsAt) return null
  const resetsMs = Date.parse(week.resetsAt)
  if (Number.isNaN(resetsMs)) return null
  return { percentUsed: week.percentUsed, resetsMs, at }
}

// The window [resetMs - 7d, resetMs) cut at local midnights. A day's share is
// spread over its own length (23h, 24h or 25h) and a piece takes its part of
// it; the pieces are then scaled so that they total exactly what the plan does.
export function weekPieces(resetMs: number, shares: number[], tz: Tz): Piece[] {
  const weekStartMs = resetMs - WEEK_MS

  // The last local midnight at or before the window's start.
  let dayStart = tz.midnightAfter(weekStartMs - 2 * DAY_MS)
  for (let next = tz.midnightAfter(dayStart); next <= weekStartMs; next = tz.midnightAfter(dayStart)) {
    dayStart = next
  }

  const pieces: Piece[] = []
  while (dayStart < resetMs) {
    const dayEnd = tz.midnightAfter(dayStart)
    const startMs = Math.max(dayStart, weekStartMs)
    const endMs = Math.min(dayEnd, resetMs)
    const weekday = tz.weekday(startMs)
    const share = (shares[weekday] ?? 0) * ((endMs - startMs) / (dayEnd - dayStart))
    pieces.push({ weekday, startMs, endMs, share })
    dayStart = dayEnd
  }

  const planTotal = shares.reduce((a, b) => a + b, 0)
  const piecesTotal = pieces.reduce((a, p) => a + p.share, 0)
  if (piecesTotal === 0) return pieces
  return pieces.map(p => ({ ...p, share: p.share * (planTotal / piecesTotal) }))
}

export function computeBudget(r: Reading, cfg: Config, now: number, tz: Tz): Budget {
  const pieces = weekPieces(r.resetsMs, dayShares(cfg.pins), tz)
  // Pieces run end to end, so "now is in piece i" is the first that ends after
  // now; before the window that is the first, after it nothing, so the last.
  const found = pieces.findIndex(p => now < p.endMs)
  const todayIndex = found === -1 ? pieces.length - 1 : found
  const todayShare = pieces[todayIndex]?.share ?? 0
  const allowed = pieces.slice(0, todayIndex + 1).reduce((a, p) => a + p.share, 0)
  const left = allowed - r.percentUsed

  let state: BudgetState = 'ok'
  if (r.percentUsed >= 100) state = 'limit'
  else if (left < 0) state = 'over'
  else if (left <= cfg.headsUpFraction * todayShare) state = 'near'

  return {
    used: r.percentUsed,
    allowed,
    left,
    todayShare,
    todayIndex,
    state,
    pieces,
    resetMs: r.resetsMs,
    weekStartMs: r.resetsMs - WEEK_MS,
  }
}
