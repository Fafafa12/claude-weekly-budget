import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { countdown, paneTitle, pct, statusLine, textBar, todayText } from '../hooks/lib/format'
import { computeBudget } from '../hooks/lib/plan'
import { fixedOffsetTz } from '../hooks/lib/tz'

const tz = fixedOffsetTz(180)
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local

// Thu 15:00: the plan allows 39% by tonight and 18% of it is today's.
const at = (used: number) => computeBudget({ percentUsed: used, resetsMs: reset, at: now }, cfg, now, tz)

const HOUR_MS = 3600e3

test('pct drops a zero decimal and rounds to one', async () => {
  expect(pct(39)).toBe('39')
  expect(pct(28.5714)).toBe('28.6')
  expect(pct(6.0000001)).toBe('6')
  expect(pct(-4)).toBe('-4')
  expect(pct(0)).toBe('0')
})

test('countdown', async () => {
  expect(countdown((5 * 24 + 9) * HOUR_MS)).toBe('5d 9h')
  expect(countdown(9 * HOUR_MS + 5 * 60e3)).toBe('9h 5m')
  expect(countdown(24 * HOUR_MS)).toBe('1d 0h')
  expect(countdown(45 * 60e3)).toBe('45m')
  expect(countdown(0)).toBe('0m')
  expect(countdown(-5 * 60e3)).toBe('0m')
})

test('todayText', async () => {
  expect(todayText(at(33))).toBe('6% left today')
  expect(todayText(at(39))).toBe('0% left today')
  expect(todayText(at(43))).toBe('4% over today')
  expect(todayText(at(100))).toBe('weekly limit reached')
})

test('textBar marks the allowed share and the use past it', async () => {
  const under = textBar(33, 39)
  expect(under.length).toBe(20)
  expect(under.indexOf('│')).toBe(8)
  expect(under).toBe('███████░│░░░░░░░░░░░')
  expect(under).not.toContain('▓')

  expect(textBar(43, 39)).toBe('████████│▓░░░░░░░░░░')
  expect(textBar(100, 39)).toBe('████████│▓▓▓▓▓▓▓▓▓▓▓')
})

test('textBar shows over even when it is less than a cell', async () => {
  // 41% rounds to the same cell as the 39% mark, but it is over.
  expect(textBar(41, 39)).toBe('████████│▓░░░░░░░░░░')
  // Exactly on plan is not over.
  expect(textBar(39, 39)).toBe('████████│░░░░░░░░░░░')
})

test('textBar shows no over for float noise', async () => {
  expect(textBar(35, 34.99999999999999)).toBe(textBar(35, 35))
  expect(textBar(35, 34.99999999999999)).not.toContain('▓')
})

test('textBar keeps the mark inside the bar', async () => {
  expect(textBar(0, 100)).toBe('░░░░░░░░░░░░░░░░░░░│')
  expect(textBar(0, 0, 10)).toBe('│░░░░░░░░░')
  expect(textBar(50, 50, 10)).toBe('█████│░░░░')
  // Nowhere to put ▓ when the mark is in the last cell.
  expect(textBar(100, 99)).toBe('███████████████████│')
})

test('statusLine style A', async () => {
  expect(statusLine(at(33), 'A', null, tz, now)).toBe('🟢 Week 33% / 39% allowed · today 6% left')
  expect(statusLine(at(43), 'A', null, tz, now)).toBe('🔴 Week 43% / 39% allowed · today 4% over')
})

test('statusLine style B', async () => {
  const line = statusLine(at(43), 'B', null, tz, now)
  expect(line.startsWith('🔴 ')).toBe(true)
  expect(line).toContain('43% → 39% · today 4% over')
  expect(line).toContain('▓')
  expect(statusLine(at(33), 'B', null, tz, now)).toBe('🟢 ███████░│░░░░░░░░░░░ 33% → 39% · today 6% left')
})

test('statusLine style C', async () => {
  expect(statusLine(at(37), 'C', null, tz, now)).toBe('🟡 2% left today')
})

test('statusLine at the weekly limit, any style', async () => {
  for (const style of ['A', 'B', 'C'] as const) {
    // 5d 5h from Thu 12:00Z to the reset.
    expect(statusLine(at(100), style, null, tz, now)).toBe('🔴 Weekly limit reached · resets in 5d 5h')
  }
})

test('statusLine without a reading', async () => {
  expect(statusLine(null, 'B', null, tz, now)).toBe('Weekly budget: no reading yet — send a message')
})

// A stale reading carries its time, and its weekday when it is from an earlier local day.
test('statusLine marks a stale reading with the time of it', async () => {
  const staleSince = Date.parse('2026-11-05T07:44:00Z') // Thu 10:44 local, today
  expect(statusLine(at(33), 'A', staleSince, tz, now).endsWith(' · as of 10:44')).toBe(true)
  expect(statusLine(at(100), 'C', staleSince, tz, now)).toBe(
    '🔴 Weekly limit reached · resets in 5d 5h · as of 10:44',
  )
  const yesterday = Date.parse('2026-11-04T07:44:00Z') // Wed 10:44 local
  expect(statusLine(at(33), 'A', yesterday, tz, now)).toBe(
    '🟢 Week 33% / 39% allowed · today 6% left · as of Wed 10:44',
  )
  // Local midnight, not UTC's, divides the days: 22:30Z on Wed is already Thu 01:30.
  expect(statusLine(at(33), 'C', Date.parse('2026-11-04T22:30:00Z'), tz, now)).toBe('🟢 6% left today · as of 01:30')
})

test('used equal to allowed through float noise reads as left, not over', async () => {
  // Fri 30% in UTC with the window from Tue 00:00: Thu allows 35%, as 34.99999999999999.
  const fri30: Config = { ...DEFAULT_CONFIG, pins: [{ days: [5], percent: 30 }] }
  const utc = fixedOffsetTz(0)
  const b = computeBudget({ percentUsed: 35, resetsMs: Date.parse('2026-11-10T00:00:00Z'), at: now }, fri30, now, utc)
  expect(todayText(b)).toBe('0% left today')
  expect(statusLine(b, 'A', null, utc, now)).toBe('🟡 Week 35% / 35% allowed · today 0% left')
  expect(statusLine(b, 'C', null, utc, now)).toBe('🟡 0% left today')
})

test('the state, not the sign of left, decides left or over', async () => {
  // A budget a hair under what it allows, yet not over: never "0% over".
  const hair = { ...at(39), left: -1e-12, state: 'near' as const }
  expect(todayText(hair)).toBe('0% left today')
  expect(statusLine(hair, 'A', null, tz, now)).toBe('🟡 Week 39% / 39% allowed · today 0% left')
})

test('paneTitle', async () => {
  expect(paneTitle(at(33), null, tz, now)).toBe('🟢 33% of 39% · 6% left today')
  expect(paneTitle(at(43), null, tz, now)).toBe('🔴 43% of 39% · 4% over today')
  expect(paneTitle(at(100), null, tz, now)).toBe('🔴 100% of 39% · weekly limit reached')
  expect(paneTitle(null, null, tz, now)).toBe('Weekly budget · no reading yet')
})

test('paneTitle marks a stale reading as statusLine does', async () => {
  expect(paneTitle(at(33), now - HOUR_MS, tz, now)).toBe('🟢 33% of 39% · 6% left today · as of 14:00')
  expect(paneTitle(at(43), now - 24 * HOUR_MS, tz, now)).toBe('🔴 43% of 39% · 4% over today · as of Wed 15:00')
})
