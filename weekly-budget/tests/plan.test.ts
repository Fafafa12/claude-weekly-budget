import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, dayShares, normalizeConfig, validatePins } from '../hooks/lib/config'
import type { Config, Pin, Weekday } from '../hooks/lib/config'
import { computeBudget, readingFrom, weekPieces } from '../hooks/lib/plan'
import { fixedOffsetTz } from '../hooks/lib/tz'
import type { Tz } from '../hooks/lib/tz'

const tz = fixedOffsetTz(180)
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local

const MIN_MS = 60_000
const DAY_MS = 24 * 60 * MIN_MS

// The expectation helpers round, so a failure prints the number, not "false".
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6 + 0
const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0)

// A zone whose UTC offset (minutes) depends on the instant, for DST weeks.
function steppedTz(offsetAt: (ms: number) => number): Tz {
  const local = (ms: number) => new Date(ms + offsetAt(ms) * MIN_MS)
  return {
    midnightAfter(ms) {
      const nextLocalMidnight = (Math.floor((ms + offsetAt(ms) * MIN_MS) / DAY_MS) + 1) * DAY_MS
      const guess = nextLocalMidnight - offsetAt(ms) * MIN_MS
      return nextLocalMidnight - offsetAt(guess) * MIN_MS
    },
    weekday: ms => local(ms).getUTCDay() as Weekday,
    dayKey: ms => local(ms).toISOString().slice(0, 10),
    hhmm: ms => local(ms).toISOString().slice(11, 16),
  }
}

test('dayShares weekend 10%', async () => {
  expect(dayShares(cfg.pins)).toEqual([5, 18, 18, 18, 18, 18, 5])
})

test('dayShares no pins', async () => {
  expect(dayShares([]).map(r6)).toEqual(Array(7).fill(r6(100 / 7)))
})

test('dayShares pins sum 100 leaves unpinned at 0', async () => {
  const shares = dayShares([{ days: [1, 2, 3, 4, 5], percent: 100 }])
  expect(shares).toEqual([0, 20, 20, 20, 20, 20, 0])
})

test('validatePins', async () => {
  const overlap: Pin[] = [
    { days: [1, 2], percent: 20 },
    { days: [2, 3], percent: 20 },
  ]
  expect(validatePins([{ days: [], percent: 50 }])).toBe('A group needs at least one day.')
  // Checked before the overlap: an empty group is named even beside an overlap.
  expect(validatePins([{ days: [], percent: 50 }, ...overlap])).toBe('A group needs at least one day.')
  expect(validatePins(overlap)).toBe('Each day can only be in one group.')
  expect(validatePins([{ days: [1], percent: 120 }])).toBe('A share must be between 0 and 100%.')
  expect(validatePins([{ days: [1], percent: NaN }])).toBe('A share must be between 0 and 100%.')
  expect(validatePins([{ days: [1], percent: -5 }])).toBe('A share must be between 0 and 100%.')
  const tooMuch: Pin[] = [
    { days: [1, 2], percent: 60 },
    { days: [3], percent: 50 },
  ]
  expect(validatePins(tooMuch)).toBe('Pinned shares add up to more than 100%.')
  expect(validatePins(cfg.pins)).toBeNull()
  expect(validatePins([])).toBeNull()
})

test('normalizeConfig garbage', async () => {
  expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG)
  expect(normalizeConfig({ mode: 'x' })).toEqual(DEFAULT_CONFIG)
  expect(normalizeConfig({ mode: 'block' }).mode).toBe('block')
  // Invalid pins are dropped as a whole, the rest of the config is kept.
  const bad = normalizeConfig({ mode: 'block', pins: [{ days: [1], percent: 120 }] })
  expect(bad.pins).toEqual([])
  expect(bad.mode).toBe('block')
  expect(normalizeConfig({ pins: [{ days: [9], percent: 10 }] }).pins).toEqual([])
  expect(normalizeConfig({ pins: [{ days: [], percent: 50 }] }).pins).toEqual([])
  expect(normalizeConfig({ pins: cfg.pins }).pins).toEqual(cfg.pins)
})

test('weekPieces Tue→Tue gives 8 pieces', async () => {
  const pieces = weekPieces(reset, dayShares(cfg.pins), tz)
  expect(pieces.map(p => p.weekday)).toEqual([2, 3, 4, 5, 6, 0, 1, 2])
  expect(pieces.map(p => r6(p.share))).toEqual([3, 18, 18, 18, 5, 5, 18, 15])
  expect(r6(sum(pieces.map(p => p.share)))).toBe(100)
})

test('weekPieces DST week', async () => {
  // Offset +2h, then +1h from 2026-10-25T01:00Z: Sun 25 Oct is a 25h day.
  const dst = steppedTz(ms => (ms < Date.parse('2026-10-25T01:00:00Z') ? 120 : 60))
  const pieces = weekPieces(Date.parse('2026-10-27T18:00:00Z'), dayShares(cfg.pins), dst)
  expect(pieces.length).toBe(8)
  expect(pieces.map(p => p.weekday)).toEqual([2, 3, 4, 5, 6, 0, 1, 2])
  expect(r6(sum(pieces.map(p => p.share)))).toBe(100)
  // Raw shares: the first Tuesday is 4h of 24h, the 25h Sunday is whole, and the
  // last Tuesday is 19h of 24h. They add up to 99.25, scaled up to 100. A day
  // length fixed at 24h would give the Sunday 5 x 25/24 and fail here.
  const raw = [3, 18, 18, 18, 5, 5, 18, 14.25]
  expect(r6(sum(raw))).toBe(99.25)
  expect(pieces.map(p => r6(p.share))).toEqual(raw.map(s => r6((s * 100) / 99.25)))
  for (let i = 0; i < pieces.length - 1; i++) {
    expect(pieces[i]?.endMs).toBe(pieces[i + 1]?.startMs)
  }
  // The window itself is untouched, and the 25h Sunday is a single piece.
  expect(pieces[0]?.startMs).toBe(Date.parse('2026-10-27T18:00:00Z') - 7 * DAY_MS)
  expect(pieces[7]?.endMs).toBe(Date.parse('2026-10-27T18:00:00Z'))
  const sunday = pieces.find(p => p.weekday === 0)
  expect((sunday?.endMs ?? 0) - (sunday?.startMs ?? 0)).toBe(25 * 60 * MIN_MS)
})

test('computeBudget at Thu 15:00', async () => {
  const at = (used: number) => computeBudget({ percentUsed: used, resetsMs: reset, at: now }, cfg, now, tz)

  const ok = at(33)
  expect(r6(ok.allowed)).toBe(39)
  expect(r6(ok.left)).toBe(6)
  expect(r6(ok.todayShare)).toBe(18)
  expect(ok.used).toBe(33)
  expect(ok.todayIndex).toBe(2)
  expect(ok.state).toBe('ok')
  expect(ok.pieces.length).toBe(8)
  expect(ok.resetMs).toBe(reset)
  expect(ok.weekStartMs).toBe(reset - 7 * DAY_MS)

  expect(at(37).state).toBe('near')
  const over = at(43)
  expect(over.state).toBe('over')
  expect(r6(over.left)).toBe(-4)
  expect(at(100).state).toBe('limit')
})

// Fri 30% and 70/6 for each other day, in UTC with the window from Tue 00:00: Tue,
// Wed and Thu allow 35%, which the sums make 34.99999999999999.
const fri30: Config = { ...DEFAULT_CONFIG, pins: [{ days: [5], percent: 30 }] }
const fri30Reset = Date.parse('2026-11-10T00:00:00Z')
const utc = fixedOffsetTz(0)

test('using exactly what the plan allows is not over, through float noise', async () => {
  const at = (used: number) => computeBudget({ percentUsed: used, resetsMs: fri30Reset, at: now }, fri30, now, utc)
  expect(r6(at(35).allowed)).toBe(35)
  expect(at(35).state).toBe('near')
  // Just past what float noise makes is over.
  expect(at(35.1).state).toBe('over')
})

test('computeBudget clamps today to the window', async () => {
  const reading = { percentUsed: 10, resetsMs: reset, at: now }
  const before = computeBudget(reading, cfg, reset - 8 * DAY_MS, tz)
  expect(before.todayIndex).toBe(0)
  expect(r6(before.allowed)).toBe(3)
  const after = computeBudget(reading, cfg, reset + DAY_MS, tz)
  expect(after.todayIndex).toBe(7)
  expect(r6(after.allowed)).toBe(100)
})

test('readingFrom', async () => {
  const resetsAt = '2026-11-10T17:00:00Z'
  const picked = readingFrom(
    [
      { kind: 'five_hour', percentUsed: 80, resetsAt: '2026-11-05T15:00:00Z' },
      { kind: 'seven_day_opus', percentUsed: 90, resetsAt },
      { kind: 'seven_day', percentUsed: 33, resetsAt },
    ],
    now,
  )
  expect(picked).toEqual({ percentUsed: 33, resetsMs: reset, at: now })
  expect(readingFrom([], now)).toBeNull()
  expect(readingFrom([{ kind: 'seven_day', percentUsed: 33 }], now)).toBeNull()
  expect(readingFrom([{ kind: 'seven_day', percentUsed: 33, resetsAt: 'soon' }], now)).toBeNull()
})
