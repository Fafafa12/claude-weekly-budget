import type { On, PaneOpenArgs, RenderSurface, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { paneTitle, textBar } from '../hooks/lib/format'
import { computeBudget } from '../hooks/lib/plan'
import { fixedOffsetTz } from '../hooks/lib/tz'

const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local, with WEEKLY_BUDGET_TZ_OFFSET_MIN=180
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local

// Thu 15:00 with a weekend pin of 10%: the plan allows 39% by tonight and 18% of
// it is today's, so 33% is ok (6% left) and 37% is near (2% left).
const pinned: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const tz = fixedOffsetTz(180)
const budgetAt = (used: number) =>
  computeBudget({ percentUsed: used, resetsMs: reset, at: now }, pinned, now, tz)
const titleAt = (used: number) => paneTitle(budgetAt(used), null, tz, now)

const HOUR_MS = 3600e3
const reading = (percentUsed: number, at = now) => ({ percentUsed, resetsMs: reset, at })
const sevenDay = (used: number) => [
  { kind: 'seven_day', percentUsed: used, resetsAt: new Date(reset).toISOString() },
]

// The kit's `mock.store` refuses `$.store` calls from a hook the test registers, so a
// test changes what is stored through this inline plugin's own hook: `put <key> <json>`.
const writer: Plugin = {
  name: 'store-writer',
  register(on) {
    on('command.run', { command: 'put' }, async ($, e) => {
      const space = e.args.indexOf(' ')
      await $.store.set(e.args.slice(0, space), JSON.parse(e.args.slice(space + 1)))
      return { text: 'stored' }
    })
  },
}
const put = ($: Engine, key: string, value: unknown) =>
  $.command.run({
    command: 'put',
    args: `${key} ${JSON.stringify(value)}`,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

type Calls = { opens: PaneOpenArgs[]; closes: string[] }

// Everything beneath the plugin: the clock, environment and store, and an engine
// that keeps its panes as the real one does, so that a pane the test closes is gone
// from `ui.panes` and the plugin has to decide what that means.
function engine(
  on: On,
  options: { store?: Record<string, unknown> | null; surfaces?: RenderSurface[] } = {},
) {
  const calls: Calls = { opens: [], closes: [] }
  const state = { surfaces: options.surfaces ?? ['terminal'], panes: [] as UiPane[] }
  const clock = mock.clock(on, { now })
  mock.env(on, { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180' })
  if (options.store !== null) mock.store(on, options.store ?? { config: pinned })

  on('session.surfaces', () => ({ value: state.surfaces }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => {
    calls.opens.push(e)
    const shown = { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true }
    state.panes = [...state.panes.filter(p => p.id !== e.id), shown]
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    calls.closes.push(e.id)
    state.panes = state.panes.filter(p => p.id !== e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: state.panes }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  return { calls, clock, state }
}

const start = async ($: Engine, clock: MockClock, surface: RenderSurface = 'vscode') => {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  await clock.settle()
}
const measure = ($: Engine, used: number) =>
  $.session.measure({ context: { window: 200_000 }, rateLimits: sevenDay(used), changed: ['rateLimits'] })

const PANE = {
  plugin: 'weekly-budget',
  component: 'Pane',
  requestId: 'compact',
  props: {
    title: 'compact',
    isFocused: false,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 2 },
    view: {},
  },
} as const
const withColumns = (bodyColumns: number) => ({ ...PANE, props: { ...PANE.props, bodyColumns } })

test('vscode draws one Svg and no Button', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  const bars = await ui.findAll({ type: 'Svg' })
  expect(bars).toHaveLength(1)
  expect(bars[0]?.props).toMatchObject({ alt: '🟢 33% of 39% · 6% left today', width: 456, height: 34 })
  expect(String(bars[0]?.props.source)).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

test('the bar is as wide as the body, between 200 and 560', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  const widthAt = async (columns: number) => {
    const ui = await $.ui.mount({ ...withColumns(columns), surface: 'vscode' })
    const width = (await ui.find({ type: 'Svg' }))?.props.width
    await ui.unmount()
    return width
  }

  expect(await widthAt(40)).toBe(296)
  expect(await widthAt(10)).toBe(200)
  expect(await widthAt(200)).toBe(560)
})

test('no reading text', async ($, on) => {
  engine(on, { store: { config: pinned } })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /No weekly reading yet/ }))?.text).toBe(
    'No weekly reading yet — send a message.',
  )
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

test('a surface without Svg gets the text bar', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const bar = await ui.find({ type: 'Text' })
  expect(bar?.text).toBe(textBar(33, 39))
  expect(bar?.props.mono).toBe(true)
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  expect(await ui.findAll({ type: 'Button' })).toEqual([])
  await ui.unmount()
})

test('opens only off-terminal', async ($, on) => {
  const vscode = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, vscode.clock)

  expect(vscode.calls.opens).toEqual([{ id: 'compact', title: '🟢 33% of 39% · 6% left today', rows: 2 }])
})

// A reading another session shared an hour ago is last known, not live: the title
// and the bar's alt say when it is from, with the weekday once it is from an earlier day.
test('the title and the bar mark a reading an hour old', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33, now - HOUR_MS) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(calls.opens.map(open => open.title)).toEqual(['🟢 33% of 39% · 6% left today · as of 14:00'])
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('🟢 33% of 39% · 6% left today · as of 14:00')
  await ui.unmount()
})

test('a reading from yesterday is marked with its weekday', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33, now - 24 * HOUR_MS) },
    surfaces: ['vscode'],
  })

  await start($, clock)

  expect(calls.opens.at(-1)?.title).toEndWith(' · as of Wed 15:00')
})

test('an open pane is retitled once its reading goes stale', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await clock.advance(16 * 60e3)

  expect(calls.opens.map(open => open.title)).toEqual([titleAt(33), `${titleAt(33)} · as of 15:00`])
})

test('stays out of the terminal', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['terminal'],
  })

  await start($, clock, 'terminal')
  await measure($, 33)

  expect(calls.opens).toEqual([])
})

test('opens beside the terminal when another surface is attached too', async ($, on) => {
  const { calls, clock } = engine(on, { surfaces: ['terminal', 'desktop'] })

  await start($, clock)

  expect(calls.opens.map(open => open.id)).toEqual(['compact'])
})

test('opens when the surface attaches after the start', async ($, on) => {
  const { calls, clock, state } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: [] })

  await start($, clock)
  expect(calls.opens).toEqual([])

  state.surfaces = ['vscode']
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([{ id: 'compact', title: titleAt(33), rows: 2 }])
})

test('with no reading yet the pane is titled so', async ($, on) => {
  const { calls, clock } = engine(on, { surfaces: ['vscode'] })

  await start($, clock)

  expect(calls.opens).toEqual([{ id: 'compact', title: 'Weekly budget · no reading yet', rows: 2 }])
})

test('opens once per session', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:other' })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
})

test('never reopens a closed pane', async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  expect(calls.opens).toHaveLength(1)

  // The person closes it.
  state.panes = []
  await measure($, 37)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
  expect(calls.closes).toEqual([])
})

test('an open pane is retitled as the budget moves', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await measure($, 37)

  expect(calls.opens.map(open => open.title)).toEqual([titleAt(33), titleAt(37)])
  expect(titleAt(37)).toStartWith('🟡 37% of 39%')
  expect(calls.opens[1]).toMatchObject({ id: 'compact', rows: 2 })
})

test('an unchanged title is not sent again', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await measure($, 33)
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
})

test('showCompactPanel false: no open', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  await measure($, 33)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([])
  expect(calls.closes).toEqual([])
})

test('switching the panel off closes an open pane', { plugins: [writer] }, async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  expect(state.panes.map(p => p.id)).toEqual(['compact'])

  await put($, 'config', { ...pinned, showCompactPanel: false })
  await clock.advance(60_000)

  expect(calls.closes).toEqual(['compact'])
  expect(state.panes).toEqual([])
  expect(calls.opens).toHaveLength(1)
})

test('a failing store leaves the session start intact and the pane unopened', async ($, on) => {
  const { calls, clock } = engine(on, { store: null, surfaces: ['vscode'] })
  on('store.get', () => ({ deny: 'store is down' }))

  // The pane work it starts rejects; the kit fails the file on a rejection nobody handled.
  await start($, clock)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([])
})
