import type { Reading } from '../../types'
import { DAY_NAMES } from './config'
import { pct } from './format'
import type { Budget } from './plan'
import type { Tz } from './tz'

// Where the pace leads: today's, from the last two hours of readings, to when today's
// share runs out; the week's, from its average per day so far, to the reset. Shown in
// the details only, for the person to read; it warns no one.

const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
export const PACE_WINDOW_MS = 2 * HOUR_MS
const MIN_SPAN_MS = 30 * MIN_MS // with less than the window read, at least this much
const MIN_WEEK_MS = 12 * HOUR_MS // a week's average means little before this
const AROUND_MS = 15 * MIN_MS // "around 16:30": times are said to the quarter hour

// A week's figure as it rose: kept only when it rises, so the figure at any moment
// is that of the last sample before it.
export type Sample = { at: number; percentUsed: number }

// A reading kept as a sample when it is higher than the last one, and not older: then
// only the window, and the sample before it, which says what the window began with.
export function addSample(samples: readonly Sample[], r: Reading, now: number): Sample[] {
  const last = samples.at(-1)
  const rises = last === undefined || (r.percentUsed > last.percentUsed && r.at >= last.at)
  const all = rises ? [...samples, { at: r.at, percentUsed: r.percentUsed }] : [...samples]
  const cutoff = now - PACE_WINDOW_MS
  const before = all.filter(x => x.at < cutoff).at(-1)
  const inWindow = all.filter(x => x.at >= cutoff)
  return before === undefined ? inWindow : [before, ...inWindow]
}

export type TodayForecast =
  | { kind: 'runsOut'; perHour: number; at: number }
  | { kind: 'lasts'; perHour: number }
  | { kind: 'idle'; since: number | null } // null: in all of the window
  | { kind: 'measuring' }

// Today's share at the pace of the last two hours, from the figure the window began
// with (or, with less read, from the first reading half an hour back at least). Over
// today, or at the weekly limit, the state says it all: no forecast.
export function todayForecast(
  budget: Pick<Budget, 'left' | 'state'>,
  samples: readonly Sample[],
  now: number,
  tz: Tz,
): TodayForecast | null {
  if (budget.state === 'over' || budget.state === 'limit') return null
  const cutoff = now - PACE_WINDOW_MS
  const latest = samples.at(-1)
  const first = samples[0]
  if (latest === undefined || first === undefined) return { kind: 'measuring' }
  const base = samples.filter(x => x.at <= cutoff).at(-1) ?? (now - first.at >= MIN_SPAN_MS ? first : null)
  if (base === null) return { kind: 'measuring' }
  const isWholeWindow = base.at <= cutoff
  const used = latest.percentUsed - base.percentUsed
  if (used <= 0) return { kind: 'idle', since: isWholeWindow ? null : base.at }
  const perHour = used / ((isWholeWindow ? PACE_WINDOW_MS : now - base.at) / HOUR_MS)
  const at = now + (Math.max(budget.left, 0) / perHour) * HOUR_MS
  return around(at) < tz.midnightAfter(now) ? { kind: 'runsOut', perHour, at } : { kind: 'lasts', perHour }
}

export type WeekForecast =
  | { kind: 'reaches'; perDay: number; at: number }
  | { kind: 'lasts'; perDay: number; endsAt: number }
  | { kind: 'none' } // nothing used yet
  | { kind: 'early' } // too little of the week gone to tell

// The week at its average per day so far, carried to the reset: the moment it would
// reach the limit, or where it would end. At the limit already, no forecast.
export function weekForecast(
  budget: Pick<Budget, 'used' | 'weekStartMs' | 'resetMs'>,
  now: number,
): WeekForecast | null {
  if (budget.used >= 100) return null
  const gone = now - budget.weekStartMs
  if (gone < MIN_WEEK_MS) return { kind: 'early' }
  if (budget.used <= 0) return { kind: 'none' }
  const perDay = budget.used / (gone / DAY_MS)
  const at = now + ((100 - budget.used) / perDay) * DAY_MS
  if (at < budget.resetMs) return { kind: 'reaches', perDay, at }
  return { kind: 'lasts', perDay, endsAt: budget.used + perDay * ((budget.resetMs - now) / DAY_MS) }
}

// A pace line, "2% an hour → today's share runs out around 18:00": what leads, what it
// comes to, and the colour that is in (none for a line that only says there is no pace).
export type PaceLine = { lead: string; outcome: string | null; tone: 'warning' | 'success' | null }

const around = (ms: number): number => Math.round(ms / AROUND_MS) * AROUND_MS

export function todayPaceLine(f: TodayForecast, tz: Tz): PaceLine {
  switch (f.kind) {
    case 'runsOut':
      return { lead: `${pct(f.perHour)}% an hour`, outcome: `today's share runs out around ${tz.hhmm(around(f.at))}`, tone: 'warning' }
    case 'lasts':
      return { lead: `${pct(f.perHour)}% an hour`, outcome: "today's share lasts the day", tone: 'success' }
    case 'idle':
      return { lead: f.since === null ? 'no use in the last 2 hours' : `no use since ${tz.hhmm(f.since)}`, outcome: null, tone: null }
    case 'measuring':
      return { lead: 'not enough readings yet', outcome: null, tone: null }
  }
}

export function weekPaceLine(f: WeekForecast, tz: Tz, now: number): PaceLine {
  switch (f.kind) {
    case 'reaches': {
      const at = around(f.at)
      const day = tz.dayKey(at) === tz.dayKey(now) ? 'today' : DAY_NAMES[tz.weekday(at)]
      return { lead: `${pct(f.perDay)}% a day`, outcome: `the limit is reached ${day} around ${tz.hhmm(at)}`, tone: 'warning' }
    }
    case 'lasts':
      return { lead: `${pct(f.perDay)}% a day`, outcome: `lasts until the reset, ending near ${Math.round(f.endsAt)}%`, tone: 'success' }
    case 'none':
      return { lead: 'nothing used yet', outcome: null, tone: null }
    case 'early':
      return { lead: 'too early to tell', outcome: null, tone: null }
  }
}
