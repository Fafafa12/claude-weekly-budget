import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import {
  labelForSlot,
  loadAccounts,
  loadConfig,
  loadProbeAt,
  loadSnooze,
  loadSurfaceWeeks,
  loadWeeks,
  pickWeek,
  saveAccount,
  saveConfig,
  saveProbeAt,
  saveSnooze,
  saveSurfaceWeek,
  saveWeekDayStart,
  saveWeekLedger,
  saveWeekReading,
  STALE_MS,
} from '../hooks/lib/store'

const MIN_MS = 60e3
const DAY_MS = 24 * 60 * MIN_MS
const now = Date.parse('2026-11-05T12:00:00Z')
const reset = now + 5 * DAY_MS

// The kit's `mock.store` answers the `$.store` calls a plugin's own hooks make,
// and the test's `$` has no `store`. Nothing registers these functions as hooks
// yet (the controller will), so they get a `$` over an in-memory store that, like
// the engine's, reads back what JSON keeps.
function fakeEngine(entries: Record<string, unknown> = {}): EngineInterface {
  const data = new Map<string, string>(Object.entries(entries).map(([k, v]) => [k, JSON.stringify(v)]))
  const store = {
    get: async (key: string): Promise<unknown> => {
      const json = data.get(key)
      return json === undefined ? undefined : JSON.parse(json)
    },
    set: async (key: string, value: unknown): Promise<void> => {
      data.set(key, JSON.stringify(value))
    },
    delete: async (key: string): Promise<void> => {
      data.delete(key)
    },
    keys: async (): Promise<string[]> => [...data.keys()],
  }
  return { store } as unknown as EngineInterface
}

test('loadConfig on empty store returns DEFAULT_CONFIG', async () => {
  const $ = fakeEngine()
  expect(await loadConfig($)).toEqual(DEFAULT_CONFIG)
})

test('config round-trips', async () => {
  const $ = fakeEngine()
  await saveConfig($, { ...DEFAULT_CONFIG, mode: 'block' })
  expect((await loadConfig($)).mode).toBe('block')
})

test('malformed snooze is null', async () => {
  const $ = fakeEngine({ snooze: 'x' })
  expect(await loadSnooze($)).toBeNull()
})

test('snooze round-trips and clears', async () => {
  const $ = fakeEngine()
  expect(await loadSnooze($)).toBeNull()
  await saveSnooze($, now + 60 * MIN_MS)
  expect(await loadSnooze($)).toBe(now + 60 * MIN_MS)
  await saveSnooze($, null)
  expect(await loadSnooze($)).toBeNull()
})

// Two accounts on one machine each have their own week, told apart by when it resets:
// "team" resets in 5 days, "pro" in 2.
const team = reset
const pro = now + 2 * DAY_MS
const at = (percentUsed: number, resetsMs: number, when = now) => ({ percentUsed, resetsMs, at: when })
const readingsOf = async ($: EngineInterface) => (await loadWeeks($)).map(w => w.reading)

test('saveWeekReading keeps the higher figure in a week, then the later', async () => {
  const $ = fakeEngine()
  await saveWeekReading($, at(10, team), now)
  await saveWeekReading($, at(9, team, now + MIN_MS), now)
  expect(await readingsOf($)).toEqual([at(10, team)])
  await saveWeekReading($, at(10, team, now + MIN_MS), now)
  expect(await readingsOf($)).toEqual([at(10, team, now + MIN_MS)])
  await saveWeekReading($, at(12, team, now - MIN_MS), now)
  expect(await readingsOf($)).toEqual([at(12, team, now - MIN_MS)])
})

test("saveWeekReading keeps each account's week apart", async () => {
  const $ = fakeEngine()
  await saveWeekReading($, at(49, team), now)
  await saveWeekReading($, at(3, pro), now)
  expect(await readingsOf($)).toEqual([at(49, team), at(3, pro)])
})

test('saveWeekReading never keeps a week that is over, and drops the ones that end', async () => {
  const $ = fakeEngine()
  await saveWeekReading($, at(30, now), now)
  expect(await readingsOf($)).toEqual([])
  await saveWeekReading($, at(30, now + MIN_MS), now)
  await saveWeekReading($, at(10, team), now + 2 * MIN_MS)
  expect(await readingsOf($)).toEqual([at(10, team)])
})

test("a week's start of day and warning record are its own", async () => {
  const $ = fakeEngine()
  await saveWeekReading($, at(49, team), now)
  await saveWeekReading($, at(3, pro), now)
  await saveWeekDayStart($, { weekKey: team, dayKey: '2026-11-05', percentUsed: 45 })
  await saveWeekLedger($, { weekKey: pro, headsUpDay: null, overDay: '2026-11-05' })
  const weeks = await loadWeeks($)
  expect(weeks.find(w => w.reading.resetsMs === team)).toEqual({
    reading: at(49, team),
    dayStart: { weekKey: team, dayKey: '2026-11-05', percentUsed: 45 },
    ledger: null,
    samples: [{ at: now, percentUsed: 49 }],
  })
  expect(weeks.find(w => w.reading.resetsMs === pro)).toEqual({
    reading: at(3, pro),
    dayStart: null,
    ledger: { weekKey: pro, headsUpDay: null, overDay: '2026-11-05' },
    samples: [{ at: now, percentUsed: 3 }],
  })
  // A week no reading has told of yet keeps nothing.
  await saveWeekDayStart($, { weekKey: now + DAY_MS, dayKey: '2026-11-05', percentUsed: 1 })
  expect(await loadWeeks($)).toHaveLength(2)
})

test("an older version's single reading, start of day and record become one week", async () => {
  const $ = fakeEngine({
    lastReading: at(49, team),
    dayStart: { weekKey: team, dayKey: '2026-11-05', percentUsed: 45 },
    ledger: { weekKey: team, headsUpDay: '2026-11-05', overDay: null },
  })
  expect(await loadWeeks($)).toEqual([
    {
      reading: at(49, team),
      dayStart: { weekKey: team, dayKey: '2026-11-05', percentUsed: 45 },
      ledger: { weekKey: team, headsUpDay: '2026-11-05', overDay: null },
      samples: [],
    },
  ])
  // Records of another week than the reading's are not carried over.
  const mixed = fakeEngine({ lastReading: at(49, team), dayStart: { weekKey: pro, dayKey: '2026-11-05', percentUsed: 1 } })
  expect((await loadWeeks(mixed))[0]?.dayStart).toBeNull()
})

test('malformed weeks are none', async () => {
  expect(await loadWeeks(fakeEngine({ weeks: 'x' }))).toEqual([])
  expect(await loadWeeks(fakeEngine({ weeks: [{ reading: { percentUsed: 'a' } }, { reading: at(3, pro) }] }))).toEqual([
    { reading: at(3, pro), dayStart: null, ledger: null, samples: [] },
  ])
})

test("a week keeps its figure's rises, for the pace", async () => {
  const $ = fakeEngine()
  await saveWeekReading($, at(10, team, now - 30 * MIN_MS), now - 30 * MIN_MS)
  await saveWeekReading($, at(10, team, now - 20 * MIN_MS), now - 20 * MIN_MS)
  await saveWeekReading($, at(12, team), now)
  expect((await loadWeeks($))[0]?.samples).toEqual([
    { at: now - 30 * MIN_MS, percentUsed: 10 },
    { at: now, percentUsed: 12 },
  ])
  // Samples that are not the shape expected are left out.
  const odd = fakeEngine({ weeks: [{ reading: at(3, pro), samples: [{ at: 'x' }, { at: now, percentUsed: 3 }] }] })
  expect((await loadWeeks(odd))[0]?.samples).toEqual([{ at: now, percentUsed: 3 }])
})

test('the week each surface last saw round-trips', async () => {
  const $ = fakeEngine()
  expect(await loadSurfaceWeeks($)).toEqual({})
  await saveSurfaceWeek($, 'desktop', pro)
  await saveSurfaceWeek($, 'terminal', team)
  expect(await loadSurfaceWeeks($)).toEqual({ desktop: pro, terminal: team })
})

const weekOf = (reading: ReturnType<typeof at>) => ({ reading, dayStart: null, ledger: null, samples: [] })

test("pickWeek shows the session's own week, the better of its own and the stored reading", async () => {
  const weeks = [weekOf(at(49, team)), weekOf(at(3, pro, now - MIN_MS))]
  expect(pickWeek(at(2, pro), weeks, team, now).reading).toEqual(at(3, pro, now - MIN_MS))
  expect(pickWeek(at(4, pro), weeks, team, now).reading).toEqual(at(4, pro))
  expect(pickWeek(at(4, pro), weeks, team, now).entry).toEqual(weeks[1])
})

test('pickWeek without a reading of its own shows the week its surface last saw, else the latest', async () => {
  const weeks = [weekOf(at(49, team, now - 30 * MIN_MS)), weekOf(at(3, pro, now - MIN_MS))]
  expect(pickWeek(null, weeks, team, now).reading).toEqual(at(49, team, now - 30 * MIN_MS))
  expect(pickWeek(null, weeks, null, now).reading).toEqual(at(3, pro, now - MIN_MS))
  // A remembered week that is over, or unknown, is no guide.
  expect(pickWeek(null, weeks, now - 1, now).reading).toEqual(at(3, pro, now - MIN_MS))
})

test('pickWeek ignores weeks that are over, and marks an old reading stale', async () => {
  expect(pickWeek(at(5, now), [weekOf(at(6, now))], null, now)).toEqual({ entry: null, reading: null, staleSince: null, basis: null })
  const old = at(49, team, now - STALE_MS - 1)
  expect(pickWeek(null, [weekOf(old)], null, now).staleSince).toBe(old.at)
  expect(pickWeek(null, [weekOf(at(49, team, now - STALE_MS))], null, now).staleSince).toBeNull()
  expect(pickWeek(null, [], null, now)).toEqual({ entry: null, reading: null, staleSince: null, basis: null })
})

test('pickWeek says why it picked the week', async () => {
  const weeks = [weekOf(at(49, team, now - 30 * MIN_MS)), weekOf(at(3, pro, now - MIN_MS))]
  expect(pickWeek(at(4, pro), weeks, team, now).basis).toBe('own')
  expect(pickWeek(null, weeks, team, now).basis).toBe('app')
  expect(pickWeek(null, weeks, null, now).basis).toBe('latest')
  expect(pickWeek(null, weeks, now - 1, now).basis).toBe('latest')
})

const acc = { id: 'acc-1', email: 'you@acme.dev', name: 'Alex', organization: 'Acme', organizationType: 'claude_team' }

test('an account is kept with the weekly slot it was last seen in', async () => {
  const $ = fakeEngine()
  expect(await loadAccounts($)).toEqual({})
  await saveAccount($, acc, null)
  await saveAccount($, acc, '61200000')
  await saveAccount($, { ...acc, email: 'new@acme.dev' }, null)
  expect(await loadAccounts($)).toEqual({ 'acc-1': { ...acc, email: 'new@acme.dev', slot: '61200000' } })
})

test('labelForSlot names the account a slot was last seen with', async () => {
  const accounts = { 'acc-1': { ...acc, slot: '61200000' } }
  expect(labelForSlot(accounts, '61200000')).toBe('Acme (you@acme.dev)')
  expect(labelForSlot(accounts, '1')).toBeNull()
  expect(labelForSlot(accounts, null)).toBeNull()
})

test('the last refresh is kept per account, and an old single one is no one\'s', async () => {
  const $ = fakeEngine({ probeAt: { at: now } })
  expect(await loadProbeAt($, 'acc-1')).toBeNull()
  await saveProbeAt($, 'acc-1', now)
  await saveProbeAt($, 'cli', now - MIN_MS)
  expect(await loadProbeAt($, 'acc-1')).toBe(now)
  expect(await loadProbeAt($, 'cli')).toBe(now - MIN_MS)
})
