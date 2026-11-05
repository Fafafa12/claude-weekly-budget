import type { DayStart, Reading } from '../../types'
import { dayShares } from './config'
import type { Config, Weekday } from './config'
import type { Tz } from './tz'

// Reading and DayStart live in the plugin's contract, types/index.d.ts.
export type { DayStart, Reading }

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

// How far apart two percents may be and still be the same: sums of shares carry
// float noise (35 can come out as 34.99999999999999).
export const EPS = 1e-9

// How far past the plan a reading must be to be over. A reading has one decimal, so
// being over is decided at half of that: 31.0 against 30.952 allowed is on the plan
// (both show as 31%), 31.1 is over. This also covers the float noise above.
export const OVER_MARGIN = 0.05

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

  let dayStart = localDayStart(weekStartMs, tz)

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

// Adaptive: the pinned days keep their share, and what is left of the week once the
// usage at the start of today and the pinned days still ahead are taken out is shared
// over the unpinned days still ahead (today included), as their planned shares weigh.
// The days gone by become one stretch of what was actually used, so the pieces still
// add up and "allowed by tonight" ends at today. With no unpinned day ahead there is
// nothing to share: the plan stands as it is.
function adaptPieces(planned: Piece[], todayIndex: number, cfg: Config, atDayStart: number): Piece[] | null {
  const pinned = new Set(cfg.pins.flatMap(pin => pin.days))
  const ahead = planned.slice(todayIndex)
  const weight = ahead.filter(p => !pinned.has(p.weekday)).reduce((a, p) => a + p.share, 0)
  if (weight <= EPS) return null
  const pinnedAhead = ahead.filter(p => pinned.has(p.weekday)).reduce((a, p) => a + p.share, 0)
  const planTotal = planned.reduce((a, p) => a + p.share, 0)
  const toShare = Math.max(0, planTotal - atDayStart - pinnedAhead)
  const gone = planned.slice(0, todayIndex).reduce((a, p) => a + p.share, 0)
  return planned.map((p, i) => {
    if (i < todayIndex) return { ...p, share: gone > 0 ? (p.share * atDayStart) / gone : 0 }
    return pinned.has(p.weekday) ? p : { ...p, share: (toShare * p.share) / weight }
  })
}

// `atDayStart` is what had been used when today began (usageAtDayStart); only the
// adaptive leftover reads it.
export function computeBudget(r: Reading, cfg: Config, now: number, tz: Tz, atDayStart = r.percentUsed): Budget {
  const planned = weekPieces(r.resetsMs, dayShares(cfg.pins), tz)
  // Pieces run end to end, so "now is in piece i" is the first that ends after
  // now; before the window that is the first, after it nothing, so the last.
  const found = planned.findIndex(p => now < p.endMs)
  const todayIndex = found === -1 ? planned.length - 1 : found
  const base = Math.min(atDayStart, r.percentUsed)
  const adapted = cfg.leftover === 'adaptive' ? adaptPieces(planned, todayIndex, cfg, base) : null
  const pieces = adapted ?? planned
  const todayShare = pieces[todayIndex]?.share ?? 0
  const allowed =
    adapted === null ? pieces.slice(0, todayIndex + 1).reduce((a, p) => a + p.share, 0) : base + todayShare
  const left = allowed - r.percentUsed

  let state: BudgetState = 'ok'
  if (r.percentUsed >= 100) state = 'limit'
  else if (left < -OVER_MARGIN) state = 'over'
  else if (left <= cfg.headsUpFraction * todayShare + EPS) state = 'near'

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

// The local midnight at or before ms.
export function localDayStart(ms: number, tz: Tz): number {
  let start = tz.midnightAfter(ms - 2 * DAY_MS)
  for (let next = tz.midnightAfter(start); next <= ms; next = tz.midnightAfter(start)) start = next
  return start
}

// The record of what today began with, from a fresh reading: kept when it is today's
// in this week; else the last reading of this week from before (the earliest one
// known), or nothing used when the week itself began today, or what is measured now.
export function nextDayStart(
  stored: DayStart | null,
  previous: Reading | null,
  measured: Reading,
  now: number,
  tz: Tz,
): DayStart {
  const dayKey = tz.dayKey(now)
  if (stored !== null && stored.weekKey === measured.resetsMs && stored.dayKey === dayKey) return stored
  const weekBeganToday = measured.resetsMs - WEEK_MS >= localDayStart(now, tz)
  const before = previous !== null && previous.resetsMs === measured.resetsMs ? previous.percentUsed : null
  const percentUsed = weekBeganToday ? 0 : Math.min(before ?? measured.percentUsed, measured.percentUsed)
  return { weekKey: measured.resetsMs, dayKey, percentUsed }
}

// What had been used when today began: today's record for this week, never more than
// is used now; without one, nothing when the week began today, else the reading itself.
export function usageAtDayStart(r: Reading, stored: DayStart | null, now: number, tz: Tz): number {
  if (stored !== null && stored.weekKey === r.resetsMs && stored.dayKey === tz.dayKey(now)) {
    return Math.min(stored.percentUsed, r.percentUsed)
  }
  return r.resetsMs - WEEK_MS >= localDayStart(now, tz) ? 0 : r.percentUsed
}
