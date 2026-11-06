import { expect, test } from 'claude-code/testing'

import { addSample, todayForecast, todayPaceLine, weekForecast, weekPaceLine } from '../hooks/lib/forecast'
import type { Sample } from '../hooks/lib/forecast'
import { fixedOffsetTz } from '../hooks/lib/tz'

const MIN_MS = 60e3
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
const tz = fixedOffsetTz(180)
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const weekStartMs = reset - 7 * DAY_MS // Tue 20:00 local, the week before

const s = (agoMs: number, percentUsed: number): Sample => ({ at: now - agoMs, percentUsed })
const today = (left: number, state: 'ok' | 'near' | 'over' | 'limit' = 'ok') => ({ left, state })

test('today runs out at the pace of the last two hours', async () => {
  const samples = [s(2 * HOUR_MS, 20), s(HOUR_MS, 22), s(10 * MIN_MS, 24)]
  // 4% in 2 hours is 2% an hour: 6% left lasts 3 hours, to 18:00.
  expect(todayForecast(today(6), samples, now, tz)).toEqual({ kind: 'runsOut', perHour: 2, at: now + 3 * HOUR_MS })
  // 30% left would last past midnight.
  expect(todayForecast(today(30), samples, now, tz)).toEqual({ kind: 'lasts', perHour: 2 })
})

test("the window starts at the figure it began with, from a reading before it", async () => {
  // 20% three hours ago, nothing since until 22%: the window began at 20%, so 2% in
  // its 2 hours.
  const samples = [s(3 * HOUR_MS, 20), s(30 * MIN_MS, 22)]
  expect(todayForecast(today(6), samples, now, tz)).toMatchObject({ perHour: 1 })
})

test('with less than two hours read, half an hour is enough', async () => {
  const samples = [s(45 * MIN_MS, 22), s(5 * MIN_MS, 24)]
  expect(todayForecast(today(6), samples, now, tz)).toMatchObject({ perHour: 2 / 0.75 })
  expect(todayForecast(today(6), [s(10 * MIN_MS, 24)], now, tz)).toEqual({ kind: 'measuring' })
  expect(todayForecast(today(6), [], now, tz)).toEqual({ kind: 'measuring' })
})

test('no use is said as such: in the window, or since the first reading', async () => {
  expect(todayForecast(today(6), [s(5 * HOUR_MS, 24)], now, tz)).toEqual({ kind: 'idle', since: null })
  expect(todayForecast(today(6), [s(45 * MIN_MS, 24)], now, tz)).toEqual({ kind: 'idle', since: now - 45 * MIN_MS })
})

test('over today, or at the limit, there is no forecast for today', async () => {
  const samples = [s(2 * HOUR_MS, 20), s(10 * MIN_MS, 24)]
  expect(todayForecast(today(-4, 'over'), samples, now, tz)).toBeNull()
  expect(todayForecast(today(0, 'limit'), samples, now, tz)).toBeNull()
})

test("the week's average per day, carried to the reset", async () => {
  const thu20 = weekStartMs + 2 * DAY_MS // two days in
  // 20% in two days is 10% a day: 70% by the reset.
  expect(weekForecast({ used: 20, weekStartMs, resetMs: reset }, thu20)).toEqual({ kind: 'lasts', perDay: 10, endsAt: 70 })
  // 40% is 20% a day: the 60% left lasts three days, to Sun 20:00.
  expect(weekForecast({ used: 40, weekStartMs, resetMs: reset }, thu20)).toEqual({
    kind: 'reaches',
    perDay: 20,
    at: thu20 + 3 * DAY_MS,
  })
  expect(weekForecast({ used: 0, weekStartMs, resetMs: reset }, thu20)).toEqual({ kind: 'none' })
  expect(weekForecast({ used: 5, weekStartMs, resetMs: reset }, weekStartMs + 6 * HOUR_MS)).toEqual({ kind: 'early' })
  expect(weekForecast({ used: 100, weekStartMs, resetMs: reset }, thu20)).toBeNull()
})

test("today's pace in words, the outcome in the colour it calls for", async () => {
  expect(todayPaceLine({ kind: 'runsOut', perHour: 2, at: now + 3 * HOUR_MS + 7 * MIN_MS }, tz)).toEqual({
    lead: '2% an hour',
    outcome: "today's share runs out around 18:00",
    tone: 'warning',
  })
  expect(todayPaceLine({ kind: 'lasts', perHour: 2.54 }, tz)).toEqual({
    lead: '2.5% an hour',
    outcome: "today's share lasts the day",
    tone: 'success',
  })
  expect(todayPaceLine({ kind: 'idle', since: null }, tz)).toEqual({ lead: 'no use in the last 2 hours', outcome: null, tone: null })
  expect(todayPaceLine({ kind: 'idle', since: now - 45 * MIN_MS }, tz)).toEqual({ lead: 'no use since 14:15', outcome: null, tone: null })
  expect(todayPaceLine({ kind: 'measuring' }, tz)).toEqual({ lead: 'not enough readings yet', outcome: null, tone: null })
})

test("the week's pace in words", async () => {
  expect(weekPaceLine({ kind: 'reaches', perDay: 20, at: Date.parse('2026-11-08T17:05:00Z') }, tz, now)).toEqual({
    lead: '20% a day',
    outcome: 'the limit is reached Sun around 20:00',
    tone: 'warning',
  })
  expect(weekPaceLine({ kind: 'reaches', perDay: 50, at: now + 2 * HOUR_MS }, tz, now)?.outcome).toBe(
    'the limit is reached today around 17:00',
  )
  expect(weekPaceLine({ kind: 'lasts', perDay: 10, endsAt: 70.4 }, tz, now)).toEqual({
    lead: '10% a day',
    outcome: 'lasts until the reset, ending near 70%',
    tone: 'success',
  })
  expect(weekPaceLine({ kind: 'none' }, tz, now)).toEqual({ lead: 'nothing used yet', outcome: null, tone: null })
  expect(weekPaceLine({ kind: 'early' }, tz, now)).toEqual({ lead: 'too early to tell', outcome: null, tone: null })
})

test('a reading is kept as a sample when the figure rises, the window and its start value only', async () => {
  const r = (percentUsed: number, at: number) => ({ percentUsed, resetsMs: reset, at })
  let samples: Sample[] = []
  samples = addSample(samples, r(20, now - 4 * HOUR_MS), now - 4 * HOUR_MS)
  samples = addSample(samples, r(20, now - 3 * HOUR_MS), now - 3 * HOUR_MS) // no rise
  samples = addSample(samples, r(21, now - 3 * HOUR_MS), now - 3 * HOUR_MS)
  samples = addSample(samples, r(23, now - HOUR_MS), now - HOUR_MS)
  samples = addSample(samples, r(22, now - 30 * MIN_MS), now - 30 * MIN_MS) // lower: an older figure
  samples = addSample(samples, r(24, now), now)
  // The 20% of four hours ago goes: the window begins at the 21% of three hours ago.
  expect(samples).toEqual([s(3 * HOUR_MS, 21), s(HOUR_MS, 23), s(0, 24)])
})
