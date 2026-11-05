import type { On, PromptOrigin, PromptSubmitInput, RenderSurface, UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { computeBudget } from '../hooks/lib/plan'
import { fixedOffsetTz, systemTz } from '../hooks/lib/tz'
import { blockReason, toastText } from '../hooks/lib/warnings'

const HOUR_MS = 3600e3
const DAY_MS = 24 * HOUR_MS
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local, with WEEKLY_BUDGET_TZ_OFFSET_MIN=180
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local

// Thu 15:00 with a weekend pin of 10%: the plan allows 39% by tonight and 18% of
// it is today's, so 33% is ok (6% left), 37% is near (2% left) and 43% is over.
const pinned: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const tz = fixedOffsetTz(180)
const budgetAtTime = (used: number, t: number) =>
  computeBudget({ percentUsed: used, resetsMs: reset, at: t }, pinned, t, tz)
const budgetAt = (used: number) => budgetAtTime(used, now)

const reading = (percentUsed: number, at = now, resetsMs = reset) => ({ percentUsed, resetsMs, at })
const sevenDay = (used: number, resetsMs = reset) => [
  { kind: 'seven_day', percentUsed: used, resetsAt: new Date(resetsMs).toISOString() },
]

// The kit's `mock.store` answers the `$.store` calls the plugin's own hooks make,
// and refuses them from a hook the test registers. So the tests read what got
// stored through this inline plugin, whose own hook does the reading.
const probe: Plugin = {
  name: 'store-probe',
  register(on) {
    on('command.run', { command: 'probe' }, async ($, e) => ({
      text: JSON.stringify((await $.store.get(e.args)) ?? null),
    }))
  },
}

type Calls = {
  statuses: (string | undefined)[]
  toasts: string[]
  opens: { id: string; title?: string }[]
  registered: string[]
}

// Everything beneath the plugin: the clock, environment and store, and what the
// engine does with the plugin's display calls, recorded.
function engine(
  on: On,
  options: { store?: Record<string, unknown> | null; surfaces?: RenderSurface[]; env?: Record<string, string> } = {},
) {
  const calls: Calls = { statuses: [], toasts: [], opens: [], registered: [] }
  const clock = mock.clock(on, { now })
  mock.env(on, options.env ?? { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180' })
  if (options.store !== null) mock.store(on, options.store ?? {})

  on('session.surfaces', () => ({ value: options.surfaces ?? ['terminal'] }))
  on('ui.status', (_, e) => {
    calls.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_, e) => {
    calls.opens.push({ id: e.id, title: e.title })
    return { value: { isPlaced: true } }
  })
  on('command.register', (_, e) => {
    calls.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  return { calls, clock }
}

// Starting a session refreshes in the background; settling waits for it.
const start = async ($: Engine, clock: MockClock) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
}
const measure = ($: Engine, used: number, resetsMs = reset) =>
  $.session.measure({ context: { window: 200_000 }, rateLimits: sevenDay(used, resetsMs), changed: ['rateLimits'] })
// A measure that moved no rate limit: the context alone, or the cost too (a response came).
const remeasure = ($: Engine, used: number, changed: UsageUnit[] = ['context']) =>
  $.session.measure({ context: { window: 200_000 }, rateLimits: sevenDay(used), changed })
const submit = ($: Engine, text = 'hi', command?: { name: string; args: string }) =>
  $.prompt.submit({ text, command, wait: false, origin: { kind: 'composer' } })
const run = ($: Engine, command: string, args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const stored = async ($: Engine, key: string): Promise<unknown> =>
  JSON.parse((await run($, 'probe', key)).text ?? 'null')

const blocking = { config: { ...pinned, mode: 'block' }, lastReading: reading(43, now - 30 * 60e3) }

test('terminal shows status line', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned }, surfaces: ['terminal'] })

  await start($, clock)
  await measure($, 33)

  expect(calls.statuses.at(-1)).toStartWith('🟢 ')
  expect(calls.statuses.at(-1)).toContain('33% → 39%')
})

test('vscode hides status line', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned }, surfaces: ['vscode'] })

  await start($, clock)
  await measure($, 33)

  expect(calls.statuses.length).toBeGreaterThan(0)
  expect(calls.statuses.at(-1)).toBeUndefined()
})

test('heads-up toast once across two sessions', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })

  await start($, clock)
  await measure($, 37)

  expect(calls.toasts).toEqual([toastText('headsUp', budgetAt(37))])
  expect(calls.toasts[0]).toStartWith('Heads-up: 2% of today')
  // The ledger it left is what the second session reads.
  expect(await stored($, 'ledger')).toEqual({ weekKey: reset, headsUpDay: '2026-11-05', overDay: null })
})

test('the second session finds the ledger the first wrote', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, ledger: { weekKey: reset, headsUpDay: '2026-11-05', overDay: null } },
  })

  await start($, clock)
  await measure($, 37)

  expect(calls.toasts).toEqual([])
})

test('block drops the next message from a shared reading', async ($, on) => {
  const { calls, clock } = engine(on, { store: blocking })

  await start($, clock)
  const result = await submit($)

  expect(result).toEqual({ drop: blockReason(budgetAt(43)) })
  expect(result.drop).toContain('/budget snooze 1h')
  expect(calls.toasts).toEqual([])
})

// No session.start, and nothing else that refreshes: this session's own state holds
// no reading, so the drop can only come from the reading another session shared.
test('block drops from a shared reading before this session has refreshed', async ($, on) => {
  const { calls } = engine(on, { store: blocking })

  const result = await submit($)

  expect(result).toEqual({ drop: blockReason(budgetAt(43)) })
  expect(result.drop).toContain('/budget snooze 1h')
  expect(calls.statuses).toEqual([])
})

test('block lets /budget commands through', async ($, on) => {
  const { clock } = engine(on, { store: blocking })

  await start($, clock)
  const result = await submit($, '/budget snooze 1h', { name: 'budget', args: 'snooze 1h' })

  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('/budget snooze 1h')

  const config = await submit($, '/budget-config', { name: 'budget-config', args: '' })
  expect(config.drop).toBeUndefined()
})

test('block lets a meta prompt through', async ($, on) => {
  engine(on, { store: blocking })

  const result = await $.prompt.submit({ text: 'note', isMeta: true, wait: false, origin: { kind: 'composer' } })

  expect(result.drop).toBeUndefined()
})

// Block and re-warn are for the person's own next message. A prompt nobody typed
// (a notification, a /loop tick, another session, a plugin) has no box to go back
// to, and one delivered into a running turn is part of a task already going.
const passing = [
  { label: 'a task notification delivered into a running turn', origin: { kind: 'task-notification' }, turnId: 't1' },
  { label: 'a scheduled trigger', origin: { kind: 'scheduled-trigger' } },
  { label: 'a peer session', origin: { kind: 'peer' } },
  { label: 'a plugin', origin: { kind: 'plugin', name: 'other-plugin' } },
  { label: 'a message typed into a running turn', origin: { kind: 'composer' }, turnId: 't1' },
] as const
const fromOrigin = ($: Engine, input: { origin?: PromptOrigin; turnId?: string }) =>
  $.prompt.submit({ text: 'hi', wait: false, ...input } as PromptSubmitInput)

for (const { label, ...input } of passing) {
  test(`block lets ${label} through`, async ($, on) => {
    engine(on, { store: blocking })

    const result = await fromOrigin($, input)

    expect(result.drop).toBeUndefined()
    expect(result.text).toBe('hi')
  })

  test(`rewarn does not toast on ${label}`, async ($, on) => {
    const { calls } = engine(on, { store: { config: { ...pinned, mode: 'rewarn' }, lastReading: reading(43) } })

    const result = await fromOrigin($, input)

    expect(result.drop).toBeUndefined()
    expect(calls.toasts).toEqual([])
  })
}

test('a prompt that passes untouched reads nothing from the store', async ($, on) => {
  engine(on, { store: null })
  let reads = 0
  on('store.get', () => {
    reads++
    return { deny: 'store is down' }
  })

  await fromOrigin($, { origin: { kind: 'scheduled-trigger' } })
  await $.prompt.submit({ text: 'note', isMeta: true, wait: false, origin: { kind: 'composer' } })
  expect(reads).toBe(0)

  // The person's own prompt does read it (and passes, as the store is down).
  expect((await submit($)).drop).toBeUndefined()
  expect(reads).toBeGreaterThan(0)
})

// What a person can be behind: the VS Code panel's stamp is not documented, so sdk
// and unclassified count as theirs, and so does a prompt with no origin at all.
const held = [
  { label: 'composer', origin: { kind: 'composer' } },
  { label: 'bridge', origin: { kind: 'bridge' } },
  { label: 'sdk', origin: { kind: 'sdk' } },
  { label: 'slack-ping', origin: { kind: 'slack-ping' } },
  { label: 'unclassified', origin: { kind: 'unclassified' } },
  { label: 'no origin', origin: undefined },
] as const
for (const { label, origin } of held) {
  test(`block drops a prompt from ${label}`, async ($, on) => {
    engine(on, { store: blocking })

    const result = await fromOrigin($, origin === undefined ? {} : { origin })

    expect(result).toEqual({ drop: blockReason(budgetAt(43)) })
  })
}

// Fri 30% in UTC with the window from Tue 00:00: Thu allows 35%, which the sums
// make 34.99999999999999. Using exactly that is not over.
test('block lets a message through at exactly what the plan allows', async ($, on) => {
  const fri30: Config = { ...DEFAULT_CONFIG, mode: 'block', pins: [{ days: [5], percent: 30 }] }
  const { calls } = engine(on, {
    store: { config: fri30, lastReading: reading(35, now, Date.parse('2026-11-10T00:00:00Z')) },
    env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: '0' },
  })

  const result = await submit($)

  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('hi')
  expect(calls.toasts).toEqual([])
})

test('block fails open with no reading', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: { ...pinned, mode: 'block' } } })

  await start($, clock)
  const result = await submit($)

  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('hi')
  expect(calls.statuses.at(-1)).toBe('Weekly budget: no reading yet — send a message')
})

test('block ignores a shared reading from a window that is over', async ($, on) => {
  engine(on, { store: { config: { ...pinned, mode: 'block' }, lastReading: reading(43, now - DAY_MS, now - HOUR_MS) } })

  const result = await submit($)

  expect(result.drop).toBeUndefined()
})

test('a failing store lets the message through', async ($, on) => {
  engine(on, { store: null })
  on('store.get', () => ({ deny: 'store is down' }))

  const result = await submit($)

  expect(result.drop).toBeUndefined()
  expect(result.text).toBe('hi')
})

test('a failing store breaks neither the session start nor the tick', async ($, on) => {
  const { calls, clock } = engine(on, { store: null })
  on('store.get', () => ({ deny: 'store is down' }))

  // The refreshes it starts reject; the kit fails the file on a rejection nobody handled.
  await start($, clock)
  await clock.advance(60_000)
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })

  expect(calls.registered).toEqual(['budget', 'budget-config'])
  expect(calls.statuses).toEqual([])
})

test('snooze command unblocks', { plugins: [probe] }, async ($, on) => {
  const { clock } = engine(on, { store: blocking })

  await start($, clock)
  expect((await submit($)).drop).toBeDefined()

  const snoozed = await run($, 'budget', 'snooze 1h')
  expect(snoozed.text).toBe('Snoozed until 16:00.')
  expect(await stored($, 'snooze')).toEqual({ until: now + HOUR_MS })

  expect((await submit($)).drop).toBeUndefined()
})

test('snooze off resumes warnings', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { ...blocking, snooze: { until: now + HOUR_MS } } })

  expect((await submit($)).drop).toBeUndefined()

  const resumed = await run($, 'budget', 'snooze off')
  expect(resumed.text).toBe('Warnings resumed.')
  expect(await stored($, 'snooze')).toEqual({ until: null })

  expect((await submit($)).drop).toBeDefined()
})

test('snooze today lasts until local midnight', async ($, on) => {
  engine(on, { store: blocking })

  expect((await run($, 'budget', 'snooze today')).text).toBe('Snoozed until 00:00.')
})

test('snooze takes any case and spaces', async ($, on) => {
  engine(on, { store: blocking })

  expect((await run($, 'budget', '  Snooze 2H ')).text).toBe('Snoozed until 17:00.')
  expect((await run($, 'budget', 'SNOOZE Today')).text).toBe('Snoozed until 00:00.')
})

test('budget command answers bad input', async ($, on) => {
  engine(on)

  expect((await run($, 'budget', 'snooze soon')).text).toBe('Use /budget snooze 30m, 1h, today or off.')
  expect((await run($, 'budget', 'snooze')).text).toBe('Use /budget snooze 30m, 1h, today or off.')
  expect((await run($, 'budget', 'bogus')).text).toBe('Usage: /budget, /budget snooze 30m|1h|today|off')
})

test('/budget opens the details pane', async ($, on) => {
  const { calls } = engine(on)

  const result = await run($, 'budget', '')

  expect(result.text).toBe('Budget details opened.')
  expect(calls.opens).toEqual([{ id: 'details', title: 'Weekly budget' }])
})

test('session start registers the commands', async ($, on) => {
  const { calls, clock } = engine(on)

  await start($, clock)

  expect(calls.registered).toEqual(['budget', 'budget-config'])
})

test('rewarn toasts each message', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: { ...pinned, mode: 'rewarn' }, lastReading: reading(43) } })

  await start($, clock)
  const first = await submit($)
  const second = await submit($, 'again')

  expect(first.drop).toBeUndefined()
  expect(second.drop).toBeUndefined()
  expect(second.text).toBe('again')
  expect(calls.toasts).toEqual([toastText('over', budgetAt(43)), toastText('over', budgetAt(43))])
  expect(calls.toasts[0]).toStartWith("Over today's budget: 43% used")
})

test('warn mode over lets messages through without a toast', async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned, lastReading: reading(43) } })

  const result = await submit($)

  expect(result.drop).toBeUndefined()
  expect(calls.toasts).toEqual([])
})

test('new week resets ledger', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })
  const over = toastText('over', budgetAt(43))

  await start($, clock)
  await measure($, 43)
  await measure($, 43)
  expect(calls.toasts).toEqual([over])

  // An early reset: the window now runs a week from now.
  const newReset = now + 7 * DAY_MS
  await measure($, 43, newReset)

  expect(calls.toasts).toHaveLength(2)
  expect(calls.toasts[1]).toStartWith("Over today's budget: 43% used")
  expect(await stored($, 'ledger')).toEqual({ weekKey: newReset, headsUpDay: null, overDay: '2026-11-05' })
})

test('a new week while snoozed still resets the ledger', { plugins: [probe] }, async ($, on) => {
  const old = { weekKey: reset, headsUpDay: '2026-11-05', overDay: '2026-11-05' }
  const { calls } = engine(on, { store: { config: pinned, ledger: old, snooze: { until: now + HOUR_MS } } })
  const newReset = now + 7 * DAY_MS

  await measure($, 43, newReset)

  expect(calls.toasts).toEqual([])
  expect(await stored($, 'ledger')).toEqual({ weekKey: newReset, headsUpDay: null, overDay: null })
})

test('a measure shares its reading with other sessions', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: pinned } })

  await measure($, 33)

  expect(await stored($, 'lastReading')).toEqual(reading(33))
})

// The rate limits a measure carries are the last response's. One raised because only
// the context moved may carry figures an hour old: they are not re-dated as fresh.
test('a context-only measure keeps the time of the figures it repeats', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })

  await measure($, 33)
  await clock.advance(HOUR_MS)
  await remeasure($, 33)

  expect(await stored($, 'lastReading')).toEqual(reading(33, now))
  expect(calls.statuses.at(-1)).toEndWith(' · as of 15:00')
})

test('a measure after a response re-dates the same figures', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })

  await measure($, 33)
  await clock.advance(HOUR_MS)
  await remeasure($, 33, ['context', 'cost'])

  expect(await stored($, 'lastReading')).toEqual(reading(33, now + HOUR_MS))
  expect(calls.statuses.at(-1)).not.toContain('as of')
})

// Only this session's own reading keeps its time: one another session shared is
// not what this session measured, so the same figures here are this session's, now.
test('a context-only measure re-dates figures this session has not measured before', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33, now - HOUR_MS) } })

  await start($, clock)
  expect(calls.statuses.at(-1)).toEndWith(' · as of 14:00')
  await remeasure($, 33)

  expect(await stored($, 'lastReading')).toEqual(reading(33, now))
  expect(calls.statuses.at(-1)).not.toContain('as of')
})

// Heads-up and over toasts need a fresh reading: the snooze ran out, but the figures
// that are over are an hour old, so the toast waits for the next real reading.
test('no measure toast on figures an hour old', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, snooze: { until: now + 30 * 60e3 } } })

  await measure($, 43)
  await clock.advance(HOUR_MS)
  await remeasure($, 43)
  expect(calls.toasts).toEqual([])

  await remeasure($, 43, ['context', 'cost'])
  expect(calls.toasts).toEqual([toastText('over', budgetAtTime(43, now + HOUR_MS))])
})

test('a measure from a window that is over does not replace the shared reading', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  await measure($, 50, now - HOUR_MS)

  expect(await stored($, 'lastReading')).toEqual(reading(33))
})

test('a lower reading in the same window does not replace a higher one', { plugins: [probe] }, async ($, on) => {
  const higher = reading(40, now - 5 * 60e3)
  engine(on, { store: { config: pinned, lastReading: higher } })

  await measure($, 33)

  expect(await stored($, 'lastReading')).toEqual(higher)
})

test('a measure without a weekly window changes nothing but the line', async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned } })

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 90, resetsAt: new Date(now + HOUR_MS).toISOString() }],
    changed: ['rateLimits'],
  })

  expect(calls.toasts).toEqual([])
  expect(calls.statuses.at(-1)).toBe('Weekly budget: no reading yet — send a message')
})

test('a reading from an hour ago is shown as last known, with no toast', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(43, now - HOUR_MS) } })

  await start($, clock)
  await $.session.attach({ surface: 'terminal', clientId: 'terminal:default' })

  expect(calls.toasts).toEqual([])
  expect(calls.statuses.at(-1)).toContain('as of 14:00')
})

test('the status line follows the clock', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) } })

  await start($, clock)
  await clock.advance(60_000)
  const before = calls.statuses.length
  await clock.advance(60_000)

  expect(calls.statuses.length).toBeGreaterThan(before)
  expect(calls.statuses.at(-1)).toStartWith('🟢 ')
})

test('without the offset variable the system zone is used', async ($, on) => {
  engine(on, { store: blocking, env: {} })

  expect((await run($, 'budget', 'snooze 1h')).text).toMatch(/^Snoozed until \d\d:\d\d\.$/)
})

test('a bad offset variable falls back to the system zone', async ($, on) => {
  engine(on, { store: blocking, env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: 'later' } })

  expect((await run($, 'budget', 'snooze 1h')).text).toMatch(/^Snoozed until \d\d:\d\d\.$/)
})

// The override is minutes east of UTC, a whole number from -840 to 840 (UTC-14 to
// UTC+14). Anything else is ignored, and the machine's own zone is used.
test('the offset variable takes 840', async ($, on) => {
  engine(on, { store: blocking, env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: '840' } })

  // 13:00Z is 03:00 the next day at UTC+14.
  expect((await run($, 'budget', 'snooze 1h')).text).toBe('Snoozed until 03:00.')
})

test('the offset variable takes -840', async ($, on) => {
  engine(on, { store: blocking, env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: '-840' } })

  expect((await run($, 'budget', 'snooze 1h')).text).toBe('Snoozed until 23:00.')
})

for (const raw of ['841', '-841', '999999999999', '90.5']) {
  test(`an offset variable of ${raw} is ignored`, async ($, on) => {
    engine(on, { store: blocking, env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: raw } })

    expect((await run($, 'budget', 'snooze 1h')).text).toBe(`Snoozed until ${systemTz.hhmm(now + HOUR_MS)}.`)
  })
}
