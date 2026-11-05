import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { computeBudget } from '../hooks/lib/plan'
import { fixedOffsetTz } from '../hooks/lib/tz'
import { blockReason, gatePrompt, measureToast, parseSnooze, toastText } from '../hooks/lib/warnings'
import type { Ledger } from '../hooks/lib/warnings'

const tz = fixedOffsetTz(180)
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local

const HOUR_MS = 3600e3
const DAY_MS = 24 * HOUR_MS

// Thu 15:00: the plan allows 39% by tonight and 18% of it is today's, so 37% is
// near (2% left), 43% is over and 100% is the limit.
const at = (used: number, t = now) => computeBudget({ percentUsed: used, resetsMs: reset, at: t }, cfg, t, tz)

test('heads-up fires once a day', async () => {
  const first = measureToast(at(37), cfg, null, null, now, tz)
  expect(first.toast).toBe('headsUp')
  expect(first.ledger).toEqual({ weekKey: reset, headsUpDay: '2026-11-05', overDay: null })

  const again = measureToast(at(37), cfg, first.ledger, null, now + HOUR_MS, tz)
  expect(again.toast).toBe(null)
  expect(again.ledger).toEqual(first.ledger)

  // Fri 15:00: the plan allows 57% by tonight, so 55% is near again.
  const nextDay = now + DAY_MS
  const tomorrow = measureToast(at(55, nextDay), cfg, again.ledger, null, nextDay, tz)
  expect(tomorrow.toast).toBe('headsUp')
  expect(tomorrow.ledger).toEqual({ weekKey: reset, headsUpDay: '2026-11-06', overDay: null })
})

test('over fires once a day, and suppresses heads-up that day', async () => {
  const first = measureToast(at(43), cfg, null, null, now, tz)
  expect(first.toast).toBe('over')
  expect(first.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: '2026-11-05' })

  const again = measureToast(at(43), cfg, first.ledger, null, now + HOUR_MS, tz)
  expect(again.toast).toBe(null)

  const near = measureToast(at(37), cfg, again.ledger, null, now + 2 * HOUR_MS, tz)
  expect(near.toast).toBe(null)
  expect(near.ledger).toEqual(first.ledger)
})

test('over fires on a day that already had a heads-up', async () => {
  const heads = measureToast(at(37), cfg, null, null, now, tz)
  const over = measureToast(at(43), cfg, heads.ledger, null, now + HOUR_MS, tz)
  expect(over.toast).toBe('over')
  expect(over.ledger).toEqual({ weekKey: reset, headsUpDay: '2026-11-05', overDay: '2026-11-05' })
})

test('ledger resets when resetsAt changes', async () => {
  const stale: Ledger = { weekKey: reset - 7 * DAY_MS, headsUpDay: '2026-11-05', overDay: '2026-11-05' }
  const r = measureToast(at(43), cfg, stale, null, now, tz)
  expect(r.toast).toBe('over')
  expect(r.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: '2026-11-05' })
})

test('snooze silences', async () => {
  const ledger: Ledger = { weekKey: reset, headsUpDay: null, overDay: null }
  const snoozedUntil = now + HOUR_MS
  for (const used of [37, 43, 100]) {
    const r = measureToast(at(used), cfg, ledger, snoozedUntil, now, tz)
    expect(r.toast).toBe(null)
    expect(r.ledger).toEqual(ledger)
  }
  // A snooze that has run out no longer silences.
  expect(measureToast(at(43), cfg, ledger, now, now, tz).toast).toBe('over')
})

test('snooze still resets a ledger from another week', async () => {
  const stale: Ledger = { weekKey: reset - 7 * DAY_MS, headsUpDay: '2026-11-05', overDay: '2026-11-05' }
  const r = measureToast(at(43), cfg, stale, now + HOUR_MS, now, tz)
  expect(r.toast).toBe(null)
  expect(r.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: null })
})

test('limit never toasts', async () => {
  const r = measureToast(at(100), cfg, null, null, now, tz)
  expect(r.toast).toBe(null)
  expect(r.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: null })
})

test('ok never toasts', async () => {
  const r = measureToast(at(20), cfg, null, null, now, tz)
  expect(r.toast).toBe(null)
  expect(r.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: null })
})

test('heads-up disabled', async () => {
  const off: Config = { ...cfg, headsUpEnabled: false }
  const r = measureToast(at(37), off, null, null, now, tz)
  expect(r.toast).toBe(null)
  expect(r.ledger).toEqual({ weekKey: reset, headsUpDay: null, overDay: null })
  // Over is not a heads-up, so it still shows.
  expect(measureToast(at(43), off, null, null, now, tz).toast).toBe('over')
})

test('toast copy', async () => {
  expect(toastText('headsUp', at(37))).toBe("Heads-up: 2% of today's budget left (37% of 39% used).")
  expect(toastText('over', at(43))).toBe(
    "Over today's budget: 43% used, 39% allowed by tonight. Snooze with /budget snooze 1h.",
  )
  expect(toastText('over', at(43.25))).toBe(
    "Over today's budget: 43.3% used, 39% allowed by tonight. Snooze with /budget snooze 1h.",
  )
})

test('gate', async () => {
  const b = at(43)
  const mode = (m: Config['mode']): Config => ({ ...cfg, mode: m })

  const blocked = gatePrompt(b, mode('block'), null, now, false)
  expect(blocked).toEqual({
    drop: "Over today's budget (43% of 39% allowed by tonight). To continue: /budget snooze 1h",
  })
  expect(blockReason(b)).toBe("Over today's budget (43% of 39% allowed by tonight). To continue: /budget snooze 1h")

  expect(gatePrompt(b, mode('rewarn'), null, now, false)).toEqual({ toast: 'over' })
  expect(gatePrompt(b, mode('warn'), null, now, false)).toBe(null)
  expect(gatePrompt(b, mode('block'), null, now, true)).toBe(null)
  expect(gatePrompt(b, mode('rewarn'), null, now, true)).toBe(null)
  expect(gatePrompt(b, mode('block'), now + HOUR_MS, now, false)).toBe(null)
  expect(gatePrompt(b, mode('rewarn'), now + HOUR_MS, now, false)).toBe(null)
  expect(gatePrompt(null, mode('block'), null, now, false)).toBe(null)
  expect(gatePrompt(at(100), mode('block'), null, now, false)).toBe(null)
  expect(gatePrompt(at(37), mode('block'), null, now, false)).toBe(null)
  expect(gatePrompt(at(20), mode('block'), null, now, false)).toBe(null)
  // A snooze that has run out no longer lets the prompt through.
  expect(gatePrompt(b, mode('block'), now, now, false)).toEqual({ drop: blockReason(b) })
})

test('parseSnooze', async () => {
  expect(parseSnooze('30m', now, tz)).toEqual({ until: now + 1800000 })
  expect(parseSnooze('1h', now, tz)).toEqual({ until: now + 3600000 })
  expect(parseSnooze(' 2 h ', now, tz)).toEqual({ until: now + 2 * 3600000 })
  expect(parseSnooze('today', now, tz)).toEqual({ until: Date.parse('2026-11-05T21:00:00Z') })
  expect(parseSnooze('off', now, tz)).toEqual({ until: null })
  const error = { error: 'Use /budget snooze 30m, 1h, today or off.' }
  expect(parseSnooze('soon', now, tz)).toEqual(error)
  expect(parseSnooze('', now, tz)).toEqual(error)
  expect(parseSnooze('1d', now, tz)).toEqual(error)
  expect(parseSnooze('-5m', now, tz)).toEqual(error)
})
