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

// The same for reading: `probe <key>` answers what is stored.
const probe: Plugin = {
  name: 'store-probe',
  register(on) {
    on('command.run', { command: 'probe' }, async ($, e) => ({
      text: JSON.stringify((await $.store.get(e.args)) ?? null),
    }))
  },
}
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const stored = async ($: Engine, key: string): Promise<unknown> =>
  JSON.parse((await run($, 'probe', key)).text ?? 'null')

type Calls = { opens: PaneOpenArgs[]; closes: string[] }

// The panel's two heights: the bar and the toggle row, or the bar with the details.
const COLLAPSED_ROWS = 4
const EXPANDED_ROWS = 17

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
  on('ui.invalidate', (_, e, next) => next(e))
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
const SETTINGS = {
  ...PANE,
  requestId: 'settings',
  props: { ...PANE.props, title: 'Weekly budget settings', placement: 'dock' },
} as const

test('compact view, collapsed: the bar and one Details toggle, no numbers', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  const bars = await ui.findAll({ type: 'Svg' })
  expect(bars).toHaveLength(1)
  expect(bars[0]?.props).toMatchObject({ alt: '33% of 39% · 6% left today', width: 456, height: 34 })
  expect(String(bars[0]?.props.source)).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
  const buttons = await ui.findAll({ type: 'Button' })
  expect(buttons.map(b => [b.key, b.props.label])).toEqual([['details-toggle', '▸ Details']])
  expect(await ui.find({ type: 'Text', text: /Used 33%/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Plan:|Mode:|Warnings/ })).toBeUndefined()
  await ui.unmount()
})

test('the toggle expands the details under the bar, and collapses them again', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'details-toggle' })

  expect((await ui.find({ type: 'Text', text: /Used 33%/ }))?.text).toBe('Used 33%')
  expect((await ui.find({ type: 'Text', text: /Allowed by tonight/ }))?.text).toBe('Allowed by tonight 39%')
  const today = await ui.find({ type: 'Text', text: /left today/ })
  expect(today?.text).toBe('6% left today')
  expect(today?.props.color).toBe('success')
  const resets = await ui.find({ type: 'Text', text: /Resets/ })
  expect(resets?.text).toBe('Resets Tue 20:00 (in 5d 5h)')
  expect(resets?.props.color).toBe('claude')
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
    'Plan: Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5',
  )
  expect((await ui.find({ type: 'Text', text: /Mode:/ }))?.text).toBe('Mode: warn')
  expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings on')
  expect((await ui.find({ key: 'snooze-60' }))?.props.label).toBe('Snooze 1h')
  expect((await ui.find({ key: 'snooze-today' }))?.props.label).toBe('Snooze today')
  expect(await ui.find({ key: 'resume' })).toBeUndefined()
  expect((await ui.find({ key: 'details-toggle' }))?.props.label).toBe('▾ Details')
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(calls.opens.slice(1)).toEqual([{ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS }])

  await ui.press({ key: 'details-toggle' })

  expect(await ui.find({ type: 'Text', text: /Used 33%/ })).toBeUndefined()
  expect(await ui.find({ key: 'snooze-60' })).toBeUndefined()
  expect((await ui.find({ key: 'details-toggle' }))?.props.label).toBe('▸ Details')
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: COLLAPSED_ROWS })
  expect(calls.opens).toHaveLength(3)
  await ui.unmount()
})

// A ✕ while a press is on its way must not bring the pane back.
test('the toggle opens nothing once the pane is closed', async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  state.panes = []

  await ui.press({ key: 'details-toggle' })

  expect(calls.opens).toHaveLength(1)
  expect(state.panes).toEqual([])
  expect((await ui.find({ key: 'details-toggle' }))?.props.label).toBe('▾ Details')
  await ui.unmount()
})

test('two presses at once cancel out', async ($, on) => {
  const { clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await Promise.all([ui.press({ key: 'details-toggle' }), ui.press({ key: 'details-toggle' })])

  expect((await ui.find({ key: 'details-toggle' }))?.props.label).toBe('▸ Details')
  await ui.unmount()
})

test('the toggle re-opens the pane under the title it has, last-known mark included', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33, now - HOUR_MS) },
    surfaces: ['vscode'],
  })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'details-toggle' })

  expect(calls.opens.slice(1)).toEqual([
    { id: 'compact', title: '33% of 39% · 6% left today · as of 14:00', rows: EXPANDED_ROWS },
  ])
  expect((await ui.find({ type: 'Text', text: /Last known/ }))?.text).toBe('Last known, as of 14:00')
  await ui.unmount()
})

test('a snooze from the expanded pane is stored, and Resume appears', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'details-toggle' })
  expect(await ui.find({ key: 'resume' })).toBeUndefined()

  await ui.press({ key: 'snooze-60' })

  expect(await stored($, 'snooze')).toEqual({ until: now + HOUR_MS })
  expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings snoozed until 16:00')
  expect((await ui.find({ key: 'resume' }))?.props.label).toBe('Resume')

  await ui.press({ key: 'resume' })

  expect(await stored($, 'snooze')).toEqual({ until: null })
  expect(await ui.find({ key: 'resume' })).toBeUndefined()
  await ui.unmount()
})

test('full view: the bar and the details, with no toggle', async ($, on) => {
  engine(on, { store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /Used 33%/ }))?.text).toBe('Used 33%')
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toContain('Sat 5 · Sun 5')
  expect((await ui.find({ type: 'Text', text: /Mode:/ }))?.text).toBe('Mode: warn')
  expect((await ui.find({ key: 'snooze-today' }))?.props.label).toBe('Snooze today')
  expect(await ui.find({ key: 'details-toggle' })).toBeUndefined()
  await ui.unmount()
})

test('full view with a stale reading marks it last known', async ($, on) => {
  engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33, now - HOUR_MS) },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  const mark = await ui.find({ type: 'Text', text: /Last known/ })
  expect(mark?.text).toBe('Last known, as of 14:00')
  expect(mark?.props.dimColor).toBe(true)
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
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['details-toggle'])
  await ui.unmount()
})

test('with no reading the expanded pane still has the plan, the mode and the snooze', async ($, on) => {
  engine(on, { store: { config: pinned } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'details-toggle' })

  expect(await ui.find({ type: 'Text', text: /No weekly reading yet/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toContain('Sat 5 · Sun 5')
  expect((await ui.find({ type: 'Text', text: /Mode:/ }))?.text).toBe('Mode: warn')
  expect((await ui.find({ key: 'snooze-60' }))?.props.label).toBe('Snooze 1h')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Used|Allowed|Resets/ })).toBeUndefined()
  await ui.unmount()
})

test('a surface without Svg gets the text bar', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const bar = await ui.find({ type: 'Text' })
  expect(bar?.text).toBe(textBar(33, 39))
  expect(bar?.props.mono).toBe(true)
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['details-toggle'])
  await ui.unmount()
})

test('opens only off-terminal', async ($, on) => {
  const vscode = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, vscode.clock)

  expect(vscode.calls.opens).toEqual([{ id: 'compact', title: '33% of 39% · 6% left today', rows: COLLAPSED_ROWS }])
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

  expect(calls.opens.map(open => open.title)).toEqual(['33% of 39% · 6% left today · as of 14:00'])
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('33% of 39% · 6% left today · as of 14:00')
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

  expect(calls.opens).toEqual([{ id: 'compact', title: titleAt(33), rows: COLLAPSED_ROWS }])
})

test('with no reading yet the pane is titled so', async ($, on) => {
  const { calls, clock } = engine(on, { surfaces: ['vscode'] })

  await start($, clock)

  expect(calls.opens).toEqual([{ id: 'compact', title: 'Weekly budget · no reading yet', rows: COLLAPSED_ROWS }])
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
  expect(titleAt(37)).toStartWith('37% of 39%')
  expect(calls.opens[1]).toMatchObject({ id: 'compact', rows: COLLAPSED_ROWS })
})

test('an unchanged title is not sent again', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await measure($, 33)
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
})

test('the full view opens by itself too, tall enough for the details', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  await measure($, 33)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([{ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS }])
  expect(calls.closes).toEqual([])
})

test('the full view stays off the terminal', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) },
    surfaces: ['terminal'],
  })

  await start($, clock, 'terminal')

  expect(calls.opens).toEqual([])
})

test('the full view never reopens a closed pane', async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) },
    surfaces: ['vscode'],
  })
  await start($, clock)

  state.panes = []
  await measure($, 37)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
})

// The engine's pane list has no rows, so the plugin keeps the rows it last opened with.
test('a view set elsewhere re-opens the open pane at the new height, once', { plugins: [writer] }, async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })
  await start($, clock)
  expect(state.panes.map(p => p.id)).toEqual(['compact'])
  expect(calls.opens).toEqual([{ id: 'compact', title: titleAt(33), rows: COLLAPSED_ROWS }])

  await put($, 'config', { ...pinned, showCompactPanel: false })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(2)
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS })
  expect(calls.closes).toEqual([])
  expect(state.panes.map(p => p.id)).toEqual(['compact'])

  // Nothing changed since, so nothing is sent again.
  await clock.advance(60_000)
  expect(calls.opens).toHaveLength(2)

  await put($, 'config', pinned)
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(3)
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: COLLAPSED_ROWS })
  expect(calls.closes).toEqual([])
})

test('a title change keeps the rows of an expanded compact view', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'details-toggle' })

  await measure($, 37)

  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(37), rows: EXPANDED_ROWS })
  await ui.unmount()
})

test('/budget in VS Code reopens the panel the person closed', async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['vscode'],
  })
  await start($, clock)
  state.panes = []

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget panel opened.')
  expect(calls.opens).toHaveLength(2)
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: COLLAPSED_ROWS })
  expect(calls.opens.map(open => open.id)).not.toContain('details')
  expect(state.panes.map(p => p.id)).toEqual(['compact'])
})

test('/budget opens the panel in the full view, tall enough for the details', async ($, on) => {
  const { calls } = engine(on, {
    store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(33) },
    surfaces: ['vscode'],
  })

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget panel opened.')
  expect(calls.opens).toEqual([{ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS }])
})

test('/budget opens the panel beside a terminal too', async ($, on) => {
  const { calls } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: ['terminal', 'vscode'],
  })

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget panel opened.')
  expect(calls.opens.map(open => open.id)).toEqual(['compact'])
})

test('/budget in a terminal opens the details pane, not the panel', async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['terminal'] })

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget details opened.')
  expect(calls.opens).toEqual([{ id: 'details', title: 'Weekly budget' }])
})

test('/budget counts as the session opening the panel: it stays closed after a ✕', async ($, on) => {
  const { calls, clock, state } = engine(on, {
    store: { config: pinned, lastReading: reading(33) },
    surfaces: [],
  })
  await start($, clock)
  expect(calls.opens).toEqual([])

  state.surfaces = ['vscode']
  await run($, 'budget')
  expect(calls.opens).toHaveLength(1)
  state.panes = []
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(1)
})

// The panel is how /budget shows anything in VS Code, so it opens even when the title cannot be worked out.
test('/budget still opens the panel when the store is down', async ($, on) => {
  const { calls, state } = engine(on, { store: null, surfaces: ['vscode'] })
  on('store.get', () => ({ deny: 'store is down' }))

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget panel opened.')
  expect(calls.opens).toEqual([{ id: 'compact', title: 'Weekly budget', rows: COLLAPSED_ROWS }])
  expect(state.panes.map(p => p.id)).toEqual(['compact'])
})

test('/budget snooze is unchanged in VS Code', { plugins: [probe] }, async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  const result = await run($, 'budget', 'snooze 1h')

  expect(result.text).toBe('Snoozed until 16:00.')
  expect(await stored($, 'snooze')).toEqual({ until: now + HOUR_MS })
  expect(calls.opens.map(open => open.id)).not.toContain('details')
})

test('switching the view keeps the details expanded', { plugins: [probe] }, async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const panel = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const settings = await $.ui.mount({ ...SETTINGS, surface: 'vscode' })
  await panel.press({ key: 'details-toggle' })
  expect(calls.opens.at(-1)?.rows).toBe(EXPANDED_ROWS)

  await settings.select({ key: 'compact-panel', value: 'off' })
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS })
  expect(await panel.find({ key: 'details-toggle' })).toBeUndefined()

  await settings.select({ key: 'compact-panel', value: 'on' })
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: titleAt(33), rows: EXPANDED_ROWS })
  expect((await panel.find({ key: 'details-toggle' }))?.props.label).toBe('▾ Details')
  expect((await panel.find({ type: 'Text', text: /Used 33%/ }))?.text).toBe('Used 33%')
  expect(calls.closes).toEqual([])
  await panel.unmount()
  await settings.unmount()
})

test('a failing store leaves the session start intact and the pane unopened', async ($, on) => {
  const { calls, clock } = engine(on, { store: null, surfaces: ['vscode'] })
  on('store.get', () => ({ deny: 'store is down' }))

  // The pane work it starts rejects; the kit fails the file on a rejection nobody handled.
  await start($, clock)
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([])
})

test('collapsed, the state sits beside a quiet Details link', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(37) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /^Running low$/ }))?.props).toMatchObject({ color: 'warning', bold: true })
  expect((await ui.find({ key: 'details-toggle' }))?.props).toMatchObject({ plain: true, dimColor: true })
  await ui.unmount()
})

test('expanded, the state label shows once', async ($, on) => {
  const { clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'details-toggle' })

  expect(await ui.findAll({ type: 'Text', text: /^On track$/ })).toHaveLength(1)
  await ui.unmount()
})

test('the full view shows the state label too', async ($, on) => {
  engine(on, { store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(43) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /^Over today$/ }))?.props).toMatchObject({ color: 'error', bold: true })
  expect(await ui.find({ key: 'details-toggle' })).toBeUndefined()
  await ui.unmount()
})
