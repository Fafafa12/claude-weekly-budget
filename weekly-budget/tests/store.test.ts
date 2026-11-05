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

test('saveSharedReading keeps the newer', async () => {
  const $ = fakeEngine()
  await saveSharedReading($, { percentUsed: 10, resetsMs: reset, at: 2 })
  await saveSharedReading($, { percentUsed: 9, resetsMs: reset, at: 1 })
  expect((await loadSharedReading($))?.at).toBe(2)

  // A different window always wins, even with an older timestamp.
  await saveSharedReading($, { percentUsed: 1, resetsMs: reset + 7 * DAY_MS, at: 1 })
  expect(await loadSharedReading($)).toEqual({ percentUsed: 1, resetsMs: reset + 7 * DAY_MS, at: 1 })
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

test('pickReading takes the later reading in the same window', () => {
  const t = now - 60e3
  const session = { percentUsed: 30, resetsMs: reset, at: t }
  const shared = { percentUsed: 31, resetsMs: reset, at: t + 1 }
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
