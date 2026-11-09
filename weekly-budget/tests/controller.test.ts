import type { On, PromptOrigin, PromptSubmitInput, RenderSurface, UsageUnit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'

import { accountSlot, DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { computeBudget } from '../hooks/lib/plan'
import { AFTER_TURN_MS } from '../hooks/lib/probe'
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
  surfaceAsks: number
  statuses: (string | undefined)[]
  toasts: string[]
  opens: { id: string; title?: string }[]
  registered: string[]
  probes: { argv: readonly string[]; env?: Readonly<Record<string, string>> }[]
  fetches: { url: string; auth?: string; headers?: Readonly<Record<string, string>> }[]
}

// Everything beneath the plugin: the clock, environment and store, and what the
// engine does with the plugin's display calls, recorded.
function engine(
  on: On,
  options: {
    store?: Record<string, unknown> | null
    surfaces?: RenderSurface[]
    env?: Record<string, string>
    usage?: string // what `claude -p /usage` prints; absent, it fails
    // What Anthropic's account addresses answer the chat's own login; absent, the
    // session has no first-party login, so neither is asked.
    oauth?: { profile?: unknown; usage?: unknown }
  } = {},
) {
  const calls: Calls = { surfaceAsks: 0, statuses: [], toasts: [], opens: [], registered: [], probes: [], fetches: [] }
  const clock = mock.clock(on, { now })
  mock.env(on, options.env ?? { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180' })
  if (options.store !== null) mock.store(on, options.store ?? {})

  on('session.surfaces', () => {
    calls.surfaceAsks++
    return { value: options.surfaces ?? ['terminal'] }
  })
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
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('process.run', (_, e) => {
    calls.probes.push({ argv: e.argv, env: e.init?.env })
    const ok = options.usage !== undefined
    return {
      value: { exitCode: ok ? 0 : 1, stdout: options.usage ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  on('session.authorize', () => ({ value: options.oauth === undefined ? null : { handle: 'sealed', kind: 'bearer' } }))
  on('http.fetch', (_, e) => {
    calls.fetches.push({ url: e.url, auth: e.init?.auth, headers: e.init?.headers })
    const body = e.url.endsWith('/profile') ? options.oauth?.profile : options.oauth?.usage
    const ok = body !== undefined
    return { value: { status: ok ? 200 : 500, ok, headers: {}, text: ok ? JSON.stringify(body) : 'error' } }
  })
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

// What the store keeps of one week (an account's): its reading, start of day and
// warning record. Before anything is written, the single keys an older version kept.
type StoredWeek = { reading: { resetsMs: number }; dayStart: unknown; ledger: unknown }
const storedWeekPart = async ($: Engine, week: number, part: 'reading' | 'dayStart' | 'ledger'): Promise<unknown> => {
  const weeks = await stored($, 'weeks')
  if (Array.isArray(weeks)) return (weeks as StoredWeek[]).find(w => w.reading.resetsMs === week)?.[part] ?? null
  const old = (await stored($, { reading: 'lastReading', dayStart: 'dayStart', ledger: 'ledger' }[part])) as {
    resetsMs?: number
    weekKey?: number
  } | null
  return old !== null && (old.resetsMs ?? old.weekKey) === week ? old : null
}
const storedReading = ($: Engine, week = reset) => storedWeekPart($, week, 'reading')
const storedDayStart = ($: Engine, week = reset) => storedWeekPart($, week, 'dayStart')
const storedLedger = ($: Engine, week = reset) => storedWeekPart($, week, 'ledger')

const blocking = { config: { ...pinned, mode: 'block' }, lastReading: reading(43, now - 30 * 60e3) }
// Its reading is half an hour old, so the reason says when it is from.
const blockedReason = blockReason(budgetAt(43), ' · as of 14:30')

test('terminal shows status line', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned }, surfaces: ['terminal'] })

  await start($, clock)
  await measure($, 33)

  expect(calls.statuses.at(-1)).toStartWith('███████░│')
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
  expect(await storedLedger($)).toEqual({ weekKey: reset, headsUpDay: '2026-11-05', overDay: null })
})

test('the second session finds the ledger the first wrote', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: {
      config: pinned,
      weeks: [
        { reading: reading(37), dayStart: null, ledger: { weekKey: reset, headsUpDay: '2026-11-05', overDay: null } },
      ],
    },
  })

  await start($, clock)
  await measure($, 37)

  expect(calls.toasts).toEqual([])
})

test('block drops the next message from a shared reading', async ($, on) => {
  const { calls, clock } = engine(on, { store: blocking })

  await start($, clock)
  const result = await submit($)

  expect(result).toEqual({ drop: blockedReason })
  expect(result.drop).toContain('/budget snooze 1h')
  expect(calls.toasts).toEqual([])
})

// No session.start, and nothing else that refreshes: this session's own state holds
// no reading, so the drop can only come from the reading another session shared.
test('block drops from a shared reading before this session has refreshed', async ($, on) => {
  const { calls } = engine(on, { store: blocking })

  const result = await submit($)

  expect(result).toEqual({ drop: blockedReason })
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
const fromOrigin = ($: Engine, input: { origin?: PromptOrigin; turnId?: string; wait?: boolean }) =>
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

// A message typed while a turn runs and queued to wait its turn (ctrl+x enter) runs
// as the next turn: it is the next message, so it is held back like any other.
test('block drops a message queued to run after the running turn', async ($, on) => {
  engine(on, { store: blocking })

  const result = await fromOrigin($, { origin: { kind: 'composer' }, turnId: 't1', wait: true })

  expect(result.drop).toContain('/budget snooze 1h')
})

test('rewarn toasts on a message queued to run after the running turn', async ($, on) => {
  const { calls } = engine(on, { store: { config: { ...pinned, mode: 'rewarn' }, lastReading: reading(43) } })

  await fromOrigin($, { origin: { kind: 'composer' }, turnId: 't1', wait: true })

  expect(calls.toasts).toEqual([toastText('over', budgetAt(43))])
})

test('a task notification queued to wait still passes', async ($, on) => {
  engine(on, { store: blocking })

  const result = await fromOrigin($, { origin: { kind: 'task-notification' }, turnId: 't1', wait: true })

  expect(result.drop).toBeUndefined()
})

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

// What a person can be behind, and a prompt with no origin at all. The VS Code
// panel's stamp is not documented, so sdk and unclassified count as theirs where
// the session draws somewhere (the terminal, in these tests).
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

    expect(result).toEqual({ drop: blockedReason })
  })
}

// Fri 30% in UTC with the window from Tue 00:00: Thu allows 35%, which the sums
// make 34.99999999999999. Using exactly that is not over.
// The SDK host's own turn is `claude -p` or the Agent SDK, which draw nothing; the
// VS Code panel's prompts may come stamped sdk or unclassified too, and it attaches
// a surface. So those two kinds are held back only where something is drawn.
for (const kind of ['sdk', 'unclassified'] as const) {
  test(`block lets an ${kind} prompt through with no surface attached`, async ($, on) => {
    engine(on, { store: blocking, surfaces: [] })

    const result = await fromOrigin($, { origin: { kind } })

    expect(result.drop).toBeUndefined()
    expect(result.text).toBe('hi')
  })

  test(`rewarn does not toast on an ${kind} prompt with no surface attached`, async ($, on) => {
    const { calls } = engine(on, {
      store: { config: { ...pinned, mode: 'rewarn' }, lastReading: reading(43) },
      surfaces: [],
    })

    expect((await fromOrigin($, { origin: { kind } })).drop).toBeUndefined()
    expect(calls.toasts).toEqual([])
  })
}

test('block drops an sdk prompt when VS Code is attached', async ($, on) => {
  engine(on, { store: blocking, surfaces: ['vscode'] })

  const result = await fromOrigin($, { origin: { kind: 'sdk' } })

  expect(result.drop).toContain('/budget snooze 1h')
})

test('block drops a composer prompt with no surface attached', async ($, on) => {
  const { calls } = engine(on, { store: blocking, surfaces: [] })

  const result = await fromOrigin($, { origin: { kind: 'composer' } })

  expect(result.drop).toContain('/budget snooze 1h')
  // Only the kinds a script may be behind ask where the session draws.
  expect(calls.surfaceAsks).toBe(0)
})

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

// The default plan allows 30.952 by tonight on Thu 15:00, shown as 31%. A reading of
// 31.0 is on the plan at a reading's one decimal, so it is not held back.
test('block lets a message through at 31.0 of 30.952 allowed', async ($, on) => {
  const { calls } = engine(on, { store: { config: { ...DEFAULT_CONFIG, mode: 'block' }, lastReading: reading(31) } })

  const result = await submit($)

  expect(result.drop).toBeUndefined()
  expect(calls.toasts).toEqual([])
})

test('block drops a message at 31.1 of 30.952 allowed', async ($, on) => {
  engine(on, { store: { config: { ...DEFAULT_CONFIG, mode: 'block' }, lastReading: reading(31.1) } })

  const result = await submit($)

  expect(result.drop).toStartWith("Over today's budget (31.1% of 31% allowed by tonight).")
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

  expect(result.text).toBe('Weekly budget: no reading yet — send a message')
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

// What a re-warn toast or a block reason says is from the reading behind it: when
// that is last known, they end with the same mark as the status line.
test('a block reason built on a reading an hour old ends with its time', async ($, on) => {
  engine(on, { store: { config: { ...pinned, mode: 'block' }, lastReading: reading(43, now - HOUR_MS) } })

  const result = await submit($)

  expect(result.drop).toBe(blockReason(budgetAt(43), ' · as of 14:00'))
  expect(result.drop).toEndWith('/budget snooze 1h · as of 14:00')
})

test('a block reason built on a reading from yesterday names the day', async ($, on) => {
  engine(on, { store: { config: { ...pinned, mode: 'block' }, lastReading: reading(43, now - DAY_MS) } })

  expect((await submit($)).drop).toEndWith(' · as of Wed 15:00')
})

test('a re-warn toast built on a reading an hour old ends with its time', async ($, on) => {
  const { calls } = engine(on, { store: { config: { ...pinned, mode: 'rewarn' }, lastReading: reading(43, now - HOUR_MS) } })

  await submit($)

  expect(calls.toasts).toEqual([toastText('over', budgetAt(43), ' · as of 14:00')])
  expect(calls.toasts[0]).toEndWith(' · as of 14:00')
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
  expect(await storedLedger($, newReset)).toEqual({ weekKey: newReset, headsUpDay: null, overDay: '2026-11-05' })
})

test('a new week while snoozed still resets the ledger', { plugins: [probe] }, async ($, on) => {
  const old = { weekKey: reset, headsUpDay: '2026-11-05', overDay: '2026-11-05' }
  const { calls } = engine(on, { store: { config: pinned, ledger: old, snooze: { until: now + HOUR_MS } } })
  const newReset = now + 7 * DAY_MS

  await measure($, 43, newReset)

  expect(calls.toasts).toEqual([])
  expect(await storedLedger($, newReset)).toEqual({ weekKey: newReset, headsUpDay: null, overDay: null })
})

test('a measure shares its reading with other sessions', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: pinned } })

  await measure($, 33)

  expect(await storedReading($)).toEqual(reading(33))
})

// The rate limits a measure carries are the last response's. One raised because only
// the context moved may carry figures an hour old: they are not re-dated as fresh.
test('a context-only measure keeps the time of the figures it repeats', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })

  await measure($, 33)
  await clock.advance(HOUR_MS)
  await remeasure($, 33)

  expect(await storedReading($)).toEqual(reading(33, now))
  expect(calls.statuses.at(-1)).toEndWith(' · as of 15:00')
})

test('a measure after a response re-dates the same figures', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned } })

  await measure($, 33)
  await clock.advance(HOUR_MS)
  await remeasure($, 33, ['context', 'cost'])

  expect(await storedReading($)).toEqual(reading(33, now + HOUR_MS))
  expect(calls.statuses.at(-1)).not.toContain('as of')
})

// Only this session's own reading keeps its time: one another session shared is
// not what this session measured, so the same figures here are this session's, now.
test('a context-only measure re-dates figures this session never measured', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33, now - HOUR_MS) } })

  await start($, clock)
  expect(calls.statuses.at(-1)).toEndWith(' · as of 14:00')
  await remeasure($, 33)

  expect(await storedReading($)).toEqual(reading(33, now))
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

test('a measure from a window that is over keeps the shared reading', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  await measure($, 50, now - HOUR_MS)

  expect(await storedReading($)).toEqual(reading(33))
})

// A window that is over says nothing about the week now running: such a measure is
// no reading at all. At 99% of a window that ended an hour ago, the old window's
// last day would read as a heads-up, and its week would reset the ledger.
test('a measure from a window that is over is ignored', { plugins: [probe] }, async ($, on) => {
  const ledger = { weekKey: reset, headsUpDay: null, overDay: '2026-11-05' }
  const { calls } = engine(on, { store: { config: pinned, ledger, lastReading: reading(33) } })

  await measure($, 99, now - HOUR_MS)

  expect(calls.toasts).toEqual([])
  expect(await storedLedger($)).toEqual(ledger)
  expect(await storedReading($)).toEqual(reading(33))
  expect(calls.statuses.at(-1)).toContain('33% → 39%')
})

test('a lower reading in the same window does not replace a higher one', { plugins: [probe] }, async ($, on) => {
  const higher = reading(40, now - 5 * 60e3)
  engine(on, { store: { config: pinned, lastReading: higher } })

  await measure($, 33)

  expect(await storedReading($)).toEqual(higher)
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
  expect(calls.statuses.at(-1)).toMatch(/^[█░▓│]+ \d/)
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

// Adaptive, Thu 15:00 with the weekend at 10%: 10% used when Thu began leaves 80% for
// the unpinned days ahead, so Thu allows 10 + 80 × 18/69 ≈ 30.9% by tonight.
const adaptiveConfig = { ...pinned, leftover: 'adaptive', statusStyle: 'A' }
const wednesdayNight = Date.parse('2026-11-04T20:00:00Z') // Wed 23:00 local

test("adaptive: a measure records what the day began with and shares out yesterday's leftover", { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: adaptiveConfig, lastReading: reading(10, wednesdayNight) },
    surfaces: ['terminal'],
  })

  await start($, clock)
  await measure($, 12)

  expect(calls.statuses.at(-1)).toBe('Week 12% / 30.9% allowed · today 18.9% left')
  expect(await storedDayStart($)).toEqual({ weekKey: reset, dayKey: '2026-11-05', percentUsed: 10 })
})

test("adaptive: a chat with no reading of its own goes by today's record", async ($, on) => {
  const { calls, clock } = engine(on, {
    store: {
      config: adaptiveConfig,
      lastReading: reading(12),
      dayStart: { weekKey: reset, dayKey: '2026-11-05', percentUsed: 10 },
    },
    surfaces: ['terminal'],
  })

  await start($, clock)

  expect(calls.statuses.at(-1)).toBe('Week 12% / 30.9% allowed · today 18.9% left')
})

test('a record of the day start leaves the fixed leftover as it is', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: {
      config: { ...pinned, statusStyle: 'A' },
      lastReading: reading(12),
      dayStart: { weekKey: reset, dayKey: '2026-11-05', percentUsed: 10 },
    },
    surfaces: ['terminal'],
  })

  await start($, clock)

  expect(calls.statuses.at(-1)).toBe('Week 12% / 39% allowed · today 27% left')
})

test('a day already recorded is not recorded again', { plugins: [probe] }, async ($, on) => {
  const today = { weekKey: reset, dayKey: '2026-11-05', percentUsed: 10 }
  const { clock } = engine(on, { store: { config: adaptiveConfig, lastReading: reading(11), dayStart: today } })

  await start($, clock)
  await measure($, 14)

  expect(await storedDayStart($)).toEqual(today)
})

// A fresh figure without a reply: Claude Code's own /usage, run in the background.
const USAGE_48 = 'Current session: 30% used · resets Nov 5, 2:39pm\nCurrent week (all models): 48% used · resets Nov 10, 8pm\n'
const PROBE = ['claude', '-p', '--no-session-persistence', '--strict-mcp-config', '/usage']
const halfHourAgo = now - 30 * 60e3
const shown = { config: { ...pinned, statusStyle: 'A' } }

test('a chat that starts runs /usage and shows its fresh figure', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, lastReading: reading(45, halfHourAgo) }, usage: USAGE_48 })

  await start($, clock)

  expect(calls.probes).toEqual([{ argv: PROBE, env: { WEEKLY_BUDGET_PROBE: '1' } }])
  expect(calls.statuses.at(-1)).toBe('Week 48% / 39% allowed · today 9% over')
  expect(await storedReading($)).toEqual({ percentUsed: 48, resetsMs: reset, at: now })
})

test('a session that is not interactive does not probe', async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, lastReading: reading(45, halfHourAgo) }, usage: USAGE_48 })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: false })
  await clock.settle()

  expect(calls.probes).toEqual([])
})

test('the Claude Code a probe starts does not probe in turn', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, halfHourAgo) },
    usage: USAGE_48,
    env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180', WEEKLY_BUDGET_PROBE: '1' },
  })

  await start($, clock)

  expect(calls.probes).toEqual([])
})

test('a probe in any chat in the last 10 minutes stands for this one', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, halfHourAgo), probeAt: { cli: now - 5 * 60e3 } },
    usage: USAGE_48,
  })

  await start($, clock)

  expect(calls.probes).toEqual([])
})

test('/budget probes when asked, unless one just ran', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, halfHourAgo), probeAt: { cli: now - 2 * 60e3 } },
    usage: USAGE_48,
  })
  // The start doesn't probe (one ran 2 minutes ago); /budget, asking, does.
  await start($, clock)
  expect(calls.probes).toHaveLength(0)

  await run($, 'budget', '')
  await clock.settle()
  expect(calls.probes).toHaveLength(1)
  expect(calls.statuses.at(-1)).toBe('Week 48% / 39% allowed · today 9% over')

  await run($, 'budget', '')
  await clock.settle()
  expect(calls.probes).toHaveLength(1)
})

test('with no week known yet there is nothing to probe for', async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, usage: USAGE_48 })

  await start($, clock)

  expect(calls.probes).toEqual([])
})

test('a probe that fails, or prints something else, changes nothing', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, lastReading: reading(45, halfHourAgo) } })

  await start($, clock)

  expect(calls.probes).toHaveLength(1)
  expect(await storedReading($)).toEqual(reading(45, halfHourAgo))
  expect(calls.statuses.at(-1)).toBe('Week 45% / 39% allowed · today 6% over · as of 14:30')
})

test('a reading going stale is probed again, at most every 10 minutes', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, now - 5 * 60e3) },
    usage: USAGE_48,
  })

  await start($, clock)
  // Fresh at the start: probed once (nothing ran in the last 10 minutes).
  expect(calls.probes).toHaveLength(1)
  // The probe made it fresh; 11 minutes on it is not stale yet, so no new probe.
  await clock.advance(11 * 60e3)
  expect(calls.probes).toHaveLength(1)
  // 16 minutes on it is stale, and the last probe was 16 minutes ago: probe again.
  await clock.advance(5 * 60e3)
  expect(calls.probes).toHaveLength(2)
})

// Two accounts on one machine: "team" (the week resetting Tue 20:00) in the terminal
// and VS Code, "pro" (resetting Sat 12:00 local) in the desktop app. Each keeps its own
// readings, start of day and warning record.
const proReset = Date.parse('2026-11-07T09:00:00Z')
const teamWeek = (percentUsed: number, at = now - 10 * 60e3) => ({
  reading: { percentUsed, resetsMs: reset, at },
  dayStart: { weekKey: reset, dayKey: '2026-11-05', percentUsed: 45 },
  ledger: null,
})
const proWeek = (percentUsed: number, at = now - 30 * 60e3) => ({
  reading: { percentUsed, resetsMs: proReset, at },
  dayStart: null,
  ledger: null,
})

test("another account's reading leaves this account's week alone", { plugins: [probe] }, async ($, on) => {
  const { clock } = engine(on, { store: { ...shown, weeks: [teamWeek(47)] } })
  await start($, clock)

  await measure($, 3, proReset)
  await measure($, 49)

  expect(await storedDayStart($)).toEqual({ weekKey: reset, dayKey: '2026-11-05', percentUsed: 45 })
  expect(await storedReading($)).toEqual({ percentUsed: 49, resetsMs: reset, at: now })
  expect(await storedReading($, proReset)).toEqual({ percentUsed: 3, resetsMs: proReset, at: now })
})

test('a reply tells which week its surface is on', { plugins: [probe] }, async ($, on) => {
  const { clock } = engine(on, { store: shown, surfaces: ['desktop'] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  await measure($, 3, proReset)

  expect(await stored($, 'surfaceWeeks')).toEqual({ desktop: proReset })
})

test('a new chat shows the week its surface last saw, else the one read last', async ($, on) => {
  const weeks = [teamWeek(49, now - 5 * 60e3), proWeek(3)]
  const pro = engine(on, { store: { ...shown, weeks, surfaceWeeks: { terminal: proReset } } })
  await start($, pro.clock)
  expect(pro.calls.statuses.at(-1)).toContain('Week 3% /')
})

test('with no surface remembered a new chat shows the week read last', async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, weeks: [teamWeek(49, now - 5 * 60e3), proWeek(3)] } })
  await start($, clock)
  expect(calls.statuses.at(-1)).toContain('Week 49% /')
})

test("/usage updates the week whose reset it names, not another account's chat", { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, weeks: [teamWeek(47), proWeek(3)], probeAt: { cli: now - 5 * 60e3 } },
    usage: USAGE_48,
  })
  await start($, clock)
  await measure($, 3, proReset) // this chat is on the pro account

  await run($, 'budget', '')
  await clock.settle()

  expect(calls.probes).toHaveLength(1)
  expect(await storedReading($)).toEqual({ percentUsed: 48, resetsMs: reset, at: now })
  expect(calls.statuses.at(-1)).toContain('Week 3% /')
})

// /budget answers with the numbers themselves, so that a phone driving this session
// (Remote Control), which shows replies but no panels, sees where the week stands.
test('/budget replies with the numbers, marked last known when they are', async ($, on) => {
  const { clock } = engine(on, { store: { config: pinned, lastReading: reading(33, now - HOUR_MS) } })
  await start($, clock)

  expect((await run($, 'budget', '')).text).toBe('33% of 39% · 6% left today · resets Tue 20:00 · as of 14:00')
})

test('/budget replies with the fresh figure /usage gave', async ($, on) => {
  const { clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, halfHourAgo), probeAt: { cli: now - 5 * 60e3 } },
    usage: USAGE_48,
  })
  await start($, clock)

  expect((await run($, 'budget', '')).text).toBe('48% of 39% · 9% over today · resets Tue 20:00')
})

test('an account seen for the first time starts with the settings last used on the same app', { plugins: [probe] }, async ($, on) => {
  const { clock } = engine(on, {
    store: {
      configs: { [accountSlot(reset)]: { ...pinned, mode: 'block' } },
      weeks: [teamWeek(47)],
      surfaceWeeks: { terminal: reset },
    },
  })
  await start($, clock)

  await measure($, 3, proReset)

  const configs = (await stored($, 'configs')) as Record<string, { mode: string; pins: unknown }>
  expect(configs[accountSlot(proReset)]).toMatchObject({ mode: 'block', pins: pinned.pins })
})

// Each chat's own login, through the sealed handle: who it is signed in as, and its
// account's week, exact to the second.
const PROFILE = {
  account: { uuid: 'acc-1', display_name: 'Faneva', email: 'faneva@experts-cpa.com' },
  organization: { uuid: 'org-1', name: 'Experts-cpa', organization_type: 'claude_team' },
}
const usageAnswer = (utilization: number, resetsAt = '2026-11-10T17:00:00.460074+00:00') => ({
  seven_day: { utilization, resets_at: resetsAt },
})

test("a chat that starts fetches its own account's week, with no reply and no /usage", { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(54) } })

  await start($, clock)

  expect(calls.fetches.map(f => f.url)).toEqual([
    'https://api.anthropic.com/api/oauth/profile',
    'https://api.anthropic.com/api/oauth/usage',
  ])
  expect(calls.fetches.every(f => f.auth === 'sealed' && f.headers?.['anthropic-beta'] === 'oauth-2025-04-20')).toBe(true)
  expect(calls.probes).toEqual([])
  expect(await storedReading($)).toEqual({ percentUsed: 54, resetsMs: reset, at: now })
  expect(calls.statuses.at(-1)).toBe('Week 54% / 39% allowed · today 15% over')
})

test('the account is named in /budget\'s reply', async ($, on) => {
  const { clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(33) } })
  await start($, clock)

  expect((await run($, 'budget', '')).text).toBe(
    '33% of 39% · 6% left today · resets Tue 20:00 · Experts-cpa (faneva@experts-cpa.com)',
  )
})

test("the usage address failing falls back to /usage", async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, lastReading: reading(45, halfHourAgo) },
    oauth: { profile: PROFILE },
    usage: USAGE_48,
  })

  await start($, clock)

  expect(calls.probes).toHaveLength(1)
  expect(calls.statuses.at(-1)).toBe('Week 48% / 39% allowed · today 9% over')
})

test('with no first-party login neither address is asked', async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, lastReading: reading(45, halfHourAgo) }, usage: USAGE_48 })

  await start($, clock)

  expect(calls.fetches).toEqual([])
  expect(calls.probes).toHaveLength(1)
})

// A reply's figure comes with its response's headers, sent before that response is
// counted: after a turn, the account's exact figure is fetched a little later.
const TOKENS = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
const turnDone = ($: Engine, more: { agentId?: string; usage?: typeof TOKENS | undefined } = { usage: TOKENS }) =>
  $.turn.complete({ answer: 'Done.', durationMs: 4000, isAborted: false, turnId: 'turn-1', reason: 'answer', ...more })

test("a turn's end fetches the account's exact figure a little later", { plugins: [probe] }, async ($, on) => {
  const oauth = { profile: PROFILE, usage: usageAnswer(54) as unknown }
  const { calls, clock } = engine(on, { store: shown, oauth })
  await start($, clock)
  await clock.advance(60_000)
  const fetched = calls.fetches.length

  await measure($, 54) // the reply's figure: from before the reply was counted
  oauth.usage = usageAnswer(56) // what Anthropic counts once it is
  await turnDone($)
  expect(calls.fetches).toHaveLength(fetched)

  await clock.advance(AFTER_TURN_MS)

  expect(calls.fetches.slice(fetched).map(f => f.url)).toEqual(['https://api.anthropic.com/api/oauth/usage'])
  expect(await storedReading($)).toEqual({ percentUsed: 56, resetsMs: reset, at: now + 60_000 + AFTER_TURN_MS })
  expect(calls.statuses.at(-1)).toBe('Week 56% / 39% allowed · today 17% over')
})

test("a subagent's turn, or one that cost nothing, fetches nothing after it", async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(54) } })
  await start($, clock)
  await clock.advance(60_000)
  const fetched = calls.fetches.length

  await turnDone($, { agentId: 'agent-7', usage: TOKENS })
  await turnDone($, { usage: undefined })
  await clock.advance(AFTER_TURN_MS)

  expect(calls.fetches).toHaveLength(fetched)
})

test('turns ending less than 30 seconds apart fetch once', async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(54) } })
  await start($, clock)
  await clock.advance(60_000)
  const fetched = calls.fetches.length

  await turnDone($)
  await clock.advance(AFTER_TURN_MS)
  await turnDone($)
  await clock.advance(AFTER_TURN_MS)

  expect(calls.fetches).toHaveLength(fetched + 1)
})

test("with no first-party login, a turn's end runs no /usage", async ($, on) => {
  const { calls, clock } = engine(on, { store: { ...shown, lastReading: reading(45) }, usage: USAGE_48 })
  await start($, clock)
  const probes = calls.probes.length

  await turnDone($)
  await clock.advance(AFTER_TURN_MS)

  expect(calls.fetches).toEqual([])
  expect(calls.probes).toHaveLength(probes)
})

test("an account's own fetch is throttled for it alone", async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { ...shown, probeAt: { 'acc-1': now - 5 * 60e3, cli: now - 5 * 60e3 } },
    oauth: { profile: PROFILE, usage: usageAnswer(54) },
  })

  await start($, clock)

  expect(calls.fetches.map(f => f.url)).toEqual(['https://api.anthropic.com/api/oauth/profile'])
})

test("a reply and the account's own answer name one week, though one comes a moment before the minute", { plugins: [probe] }, async ($, on) => {
  const { clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(54, '2026-11-10T16:59:59.723+00:00') } })
  await start($, clock)

  await measure($, 55)

  const weeks = (await stored($, 'weeks')) as StoredWeek[]
  expect(weeks.map(w => w.reading.resetsMs)).toEqual([reset])
  expect(((await stored($, 'accounts')) as Record<string, { slot: string }>)['acc-1']?.slot).toBe(accountSlot(reset))
  expect((await run($, 'budget', '')).text).toContain('Experts-cpa (faneva@experts-cpa.com)')
})

// The desktop app drives Claude Code through the SDK: its chat starts with no surface
// and no one at a prompt, and its client attaches after.
test("the desktop app's chat is named, and fetches its week, once its client attaches", { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, surfaces: ['desktop'], oauth: { profile: PROFILE, usage: usageAnswer(3, '2026-11-07T08:59:59.880+00:00') } })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.settle()
  expect(calls.fetches).toEqual([])

  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()

  expect(calls.fetches.map(f => f.url)).toEqual([
    'https://api.anthropic.com/api/oauth/profile',
    'https://api.anthropic.com/api/oauth/usage',
  ])
  expect(((await stored($, 'accounts')) as Record<string, { slot: string }>)['acc-1']?.slot).toBe(accountSlot(proReset))
  expect(await stored($, 'surfaceWeeks')).toEqual({ desktop: proReset })
  expect((await run($, 'budget', '')).text).toContain('Experts-cpa (faneva@experts-cpa.com)')
})

test('a client attaching to a chat someone already drives fetches nothing more', async ($, on) => {
  const { calls, clock } = engine(on, { store: shown, oauth: { profile: PROFILE, usage: usageAnswer(54) } })
  await start($, clock)

  await $.session.attach({ surface: 'mobile', clientId: 'mobile:phone' })
  await clock.settle()

  expect(calls.fetches).toHaveLength(2)
})

test('settings follow an account whose week moves to another slot', { plugins: [probe] }, async ($, on) => {
  const oldReset = reset - 3 * 60 * 60e3 // the account's week used to reset three hours earlier
  const { clock } = engine(on, {
    store: {
      configs: { [accountSlot(oldReset)]: { ...pinned, mode: 'block' } },
      accounts: { 'acc-1': { email: 'faneva@experts-cpa.com', slot: accountSlot(oldReset) } },
    },
    oauth: { profile: PROFILE, usage: usageAnswer(10) },
  })

  await start($, clock)

  const configs = (await stored($, 'configs')) as Record<string, { mode: string }>
  expect(configs[accountSlot(reset)]?.mode).toBe('block')
  expect(((await stored($, 'accounts')) as Record<string, { slot: string }>)['acc-1']?.slot).toBe(accountSlot(reset))
})
