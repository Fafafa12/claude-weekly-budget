import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import {
  loadConfig,
  loadLedger,
  loadSharedReading,
  loadSnooze,
  pickReading,
  saveConfig,
  saveLedger,
  saveSharedReading,
  saveSnooze,
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

test('ledger round-trips, and a malformed one is null', async () => {
  const $ = fakeEngine()
  expect(await loadLedger($)).toBeNull()
  const ledger = { weekKey: reset, headsUpDay: '2026-11-05', overDay: null }
  await saveLedger($, ledger)
  expect(await loadLedger($)).toEqual(ledger)

  const bad = fakeEngine({ ledger: { weekKey: 'x', headsUpDay: 3, overDay: null } })
  expect(await loadLedger(bad)).toBeNull()
})

test('a malformed shared reading is null', async () => {
  const $ = fakeEngine({ lastReading: { percentUsed: '40', resetsMs: reset, at: now } })
  expect(await loadSharedReading($)).toBeNull()
})

// Usage only goes up within a window, so the better bound is the higher figure,
// and between equal ones the later reading. A later window beats an earlier one.
test('saveSharedReading keeps the higher figure in a window, then the later', async () => {
  const $ = fakeEngine()
  const first = { percentUsed: 10, resetsMs: reset, at: now - 3 * MIN_MS }
  await saveSharedReading($, first, now)
  await saveSharedReading($, { percentUsed: 9, resetsMs: reset, at: now - MIN_MS }, now)
  expect(await loadSharedReading($)).toEqual(first)

  const same = { ...first, at: now - 2 * MIN_MS }
  await saveSharedReading($, same, now)
  expect(await loadSharedReading($)).toEqual(same)
  await saveSharedReading($, first, now)
  expect(await loadSharedReading($)).toEqual(same)

  const higher = { percentUsed: 12, resetsMs: reset, at: now - 5 * MIN_MS }
  await saveSharedReading($, higher, now)
  expect(await loadSharedReading($)).toEqual(higher)
})

test('saveSharedReading keeps the later window, whatever its figure or time', async () => {
  const $ = fakeEngine()
  const next = { percentUsed: 1, resetsMs: reset + 7 * DAY_MS, at: now - 5 * MIN_MS }
  await saveSharedReading($, { percentUsed: 90, resetsMs: reset, at: now - MIN_MS }, now)
  await saveSharedReading($, next, now)
  expect(await loadSharedReading($)).toEqual(next)

  // An earlier window never comes back over it.
  await saveSharedReading($, { percentUsed: 95, resetsMs: reset, at: now }, now)
  expect(await loadSharedReading($)).toEqual(next)
})

test('saveSharedReading never stores a reading whose window is over', async () => {
  const $ = fakeEngine()
  // The reset instant itself is already the next window.
  await saveSharedReading($, { percentUsed: 30, resetsMs: now, at: now - MIN_MS }, now)
  expect(await loadSharedReading($)).toBeNull()

  const live = { percentUsed: 30, resetsMs: reset, at: now - MIN_MS }
  await saveSharedReading($, live, now)
  await saveSharedReading($, { percentUsed: 90, resetsMs: now - 1, at: now }, now)
  expect(await loadSharedReading($)).toEqual(live)
})

test('saveSharedReading replaces a stored reading whose window is over', async () => {
  const $ = fakeEngine({ lastReading: { percentUsed: 99, resetsMs: now - DAY_MS, at: now - 2 * DAY_MS } })
  const live = { percentUsed: 3, resetsMs: reset, at: now }
  await saveSharedReading($, live, now)
  expect(await loadSharedReading($)).toEqual(live)
})

test('pickReading drops a session reading from an expired window', () => {
  const session = { percentUsed: 30, resetsMs: now - 1, at: now - 5 * MIN_MS }
  expect(pickReading(session, null, now)).toEqual({ reading: null, staleSince: null })
  // The reset instant itself is already the next window.
  expect(pickReading({ ...session, resetsMs: now }, null, now).reading).toBeNull()
})

test('pickReading marks a shared reading older than STALE_MS stale', () => {
  const shared = { percentUsed: 30, resetsMs: reset, at: now - 20 * MIN_MS }
  expect(pickReading(null, shared, now)).toEqual({ reading: shared, staleSince: shared.at })
})

test('pickReading is not stale at exactly STALE_MS', () => {
  const shared = { percentUsed: 30, resetsMs: reset, at: now - STALE_MS }
  expect(pickReading(null, shared, now)).toEqual({ reading: shared, staleSince: null })
})

test('pickReading takes the higher figure in the same window, even when it is older', () => {
  const t = now - 60e3
  const session = { percentUsed: 30, resetsMs: reset, at: t + 1 }
  const shared = { percentUsed: 31, resetsMs: reset, at: t }
  expect(pickReading(session, shared, now)).toEqual({ reading: shared, staleSince: null })
  expect(pickReading(shared, session, now).reading).toEqual(shared)
})

test('pickReading takes the later of two equal figures in the same window', () => {
  const session = { percentUsed: 30, resetsMs: reset, at: now - 20 * MIN_MS }
  const shared = { percentUsed: 30, resetsMs: reset, at: now - MIN_MS }
  expect(pickReading(session, shared, now)).toEqual({ reading: shared, staleSince: null })
  expect(pickReading(shared, session, now).reading).toEqual(shared)
})

test('pickReading takes the new window over the previous one', () => {
  const shared = { percentUsed: 90, resetsMs: now + 60 * MIN_MS, at: now - 60e3 }
  const session = { percentUsed: 2, resetsMs: now + 60 * MIN_MS + 7 * DAY_MS, at: now - 120e3 }
  expect(pickReading(session, shared, now).reading).toEqual(session)
})

test('pickReading skips an expired reading even when it is newer', () => {
  const live = { percentUsed: 40, resetsMs: reset, at: now - 10 * MIN_MS }
  const expired = { percentUsed: 5, resetsMs: now - 1, at: now - 60e3 }
  expect(pickReading(expired, live, now).reading).toEqual(live)
})

test('pickReading with no readings is empty', () => {
  expect(pickReading(null, null, now)).toEqual({ reading: null, staleSince: null })
})
