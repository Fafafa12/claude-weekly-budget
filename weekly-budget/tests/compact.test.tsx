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
// The host draws the header in plain text, so it only names the panel: the summary,
// coloured, is the panel's first line.
const TITLE = 'Weekly budget'

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
const EXPANDED_ROWS = 18

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
  expect(bars[0]?.props).toMatchObject({ alt: '33% of 39% · 6% left today', height: 20 })
  expect(bars[0]?.props.width).toBeUndefined()
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
  // Today's balance is in the summary line and, now open, in the details too.
  const todays = await ui.findAll({ type: 'Text', text: /^6% left today$/ })
  expect(todays).toHaveLength(2)
  const today = todays.at(-1)
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
  expect(calls.opens.slice(1)).toEqual([{ id: 'compact', title: TITLE, rows: EXPANDED_ROWS }])

  await ui.press({ key: 'details-toggle' })

  expect(await ui.find({ type: 'Text', text: /Used 33%/ })).toBeUndefined()
  expect(await ui.find({ key: 'snooze-60' })).toBeUndefined()
  expect((await ui.find({ key: 'details-toggle' }))?.props.label).toBe('▸ Details')
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS })
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
    { id: 'compact', title: TITLE, rows: EXPANDED_ROWS },
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

// The bar has no width of its own: it takes the panel's, whatever that is.
test('the bar stretches to the panel, and the weekday labels line up under it', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })

  for (const columns of [10, 60, 200]) {
    const ui = await $.ui.mount({ ...withColumns(columns), surface: 'vscode' })
    expect((await ui.find({ type: 'Svg' }))?.props.width).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const widths = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(async i => (await ui.find({ key: `day-${i}` }))?.props.width))
  expect(widths).toEqual(['3%', '18%', '18%', '18%', '5%', '5%', '18%', '15%'])
  // The first Tue is too narrow for its label; the last one has it.
  expect(await ui.findAll({ type: 'Text', text: /^Tue$/ })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /^Thu$/ }))?.props).toMatchObject({ color: 'claude', weight: 'semibold' })
  expect((await ui.find({ type: 'Text', text: /^Wed$/ }))?.props.dimColor).toBe(true)
  await ui.unmount()
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

  const bar = (await ui.findAll({ type: 'Text' })).find(text => text.props.mono === true)
  expect(bar?.text).toBe(textBar(33, 39))
  expect(await ui.findAll({ type: 'Svg' })).toEqual([])
  expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toEqual(['details-toggle'])
  await ui.unmount()
})

test('opens only off-terminal', async ($, on) => {
  const vscode = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, vscode.clock)

  expect(vscode.calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS }])
})

// A reading another session shared an hour ago is last known, not live: the title
// and the bar's alt say when it is from, with the weekday once it is from an earlier day.
test('the summary line and the bar mark a reading an hour old', async ($, on) => {
  const { calls, clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33, now - HOUR_MS) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(calls.opens.map(open => open.title)).toEqual([TITLE])
  expect((await ui.find({ type: 'Text', text: /^ · as of 14:00$/ }))?.props.dimColor).toBe(true)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toBe('33% of 39% · 6% left today · as of 14:00')
  await ui.unmount()
})

test('a reading from yesterday is marked with its weekday', async ($, on) => {
  const { clock } = engine(on, {
    store: { config: pinned, lastReading: reading(33, now - 24 * HOUR_MS) },
    surfaces: ['vscode'],
  })

  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(await ui.find({ type: 'Text', text: /^ · as of Wed 15:00$/ })).toBeDefined()
  await ui.unmount()
})

test('a reading going stale is marked in the panel, which is not re-opened for it', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await clock.advance(16 * 60e3)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(calls.opens).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^ · as of 15:00$/ })).toBeDefined()
  await ui.unmount()
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
  const { calls, clock } = engine(on, { surfaces: ['terminal', 'vscode'] })

  await start($, clock)

  expect(calls.opens.map(open => open.id)).toEqual(['compact'])
})

test('opens when the surface attaches after the start', async ($, on) => {
  const { calls, clock, state } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: [] })

  await start($, clock)
  expect(calls.opens).toEqual([])

  state.surfaces = ['vscode']
  await $.session.attach({ surface: 'vscode', clientId: 'vscode:default' })

  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS }])
})

test('with no reading yet the pane is titled so', async ($, on) => {
  const { calls, clock } = engine(on, { surfaces: ['vscode'] })

  await start($, clock)

  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS }])
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

test('the budget moving redraws the panel without re-opening it', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })

  await start($, clock)
  await measure($, 37)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS }])
  expect((await ui.find({ type: 'Text', text: /^37%$/ }))?.props.color).toBe('warning')
  await ui.unmount()
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

  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: EXPANDED_ROWS }])
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
  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS }])

  await put($, 'config', { ...pinned, showCompactPanel: false })
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(2)
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: EXPANDED_ROWS })
  expect(calls.closes).toEqual([])
  expect(state.panes.map(p => p.id)).toEqual(['compact'])

  // Nothing changed since, so nothing is sent again.
  await clock.advance(60_000)
  expect(calls.opens).toHaveLength(2)

  await put($, 'config', pinned)
  await clock.advance(60_000)

  expect(calls.opens).toHaveLength(3)
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS })
  expect(calls.closes).toEqual([])
})

test('a title change keeps the rows of an expanded compact view', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'details-toggle' })

  await measure($, 37)

  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: EXPANDED_ROWS })
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
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: COLLAPSED_ROWS })
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
  expect(calls.opens).toEqual([{ id: 'compact', title: TITLE, rows: EXPANDED_ROWS }])
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

  await settings.press({ key: 'compact-panel-off' })
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: EXPANDED_ROWS })
  expect(await panel.find({ key: 'details-toggle' })).toBeUndefined()

  await settings.press({ key: 'compact-panel-on' })
  expect(calls.opens.at(-1)).toEqual({ id: 'compact', title: TITLE, rows: EXPANDED_ROWS })
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

// The used figure and today's balance carry the state's theme colour; the rest of the
// line is plain, the "as of" mark dim.
const SUMMARIES = [
  [33, '33%', '6% left today', 'success'],
  [37, '37%', '2% left today', 'warning'],
  [43, '43%', '4% over today', 'error'],
  [100, '100%', 'weekly limit reached', 'error'],
] as const
for (const [used, usedText, todayText, color] of SUMMARIES) {
  test(`at ${used}% the summary colours "${usedText}" and "${todayText}" ${color}`, async ($, on) => {
    engine(on, { store: { config: pinned, lastReading: reading(used) } })
    const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

    expect((await ui.find({ type: 'Text', text: new RegExp(`^${usedText}$`) }))?.props.color).toBe(color)
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${todayText}$`) }))?.props.color).toBe(color)
    expect((await ui.find({ type: 'Text', text: /^ of 39% · $/ }))?.props.color).toBeUndefined()
    await ui.unmount()
  })
}

test('collapsed, the summary sits beside a quiet Details link', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(37) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /37% of 39% · 2% left today/ }))).toBeDefined()
  expect((await ui.find({ key: 'details-toggle' }))?.props).toMatchObject({ plain: true, dimColor: true })
  await ui.unmount()
})

test('the panel has no state word: the colours say it, collapsed or expanded', async ($, on) => {
  const { clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['vscode'] })
  await start($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  const words = /^(On track|Running low|Over today|Weekly limit reached)$/

  expect(await ui.findAll({ type: 'Text', text: words })).toEqual([])
  await ui.press({ key: 'details-toggle' })
  expect(await ui.findAll({ type: 'Text', text: words })).toEqual([])
  await ui.unmount()
})

test('the full view has the coloured summary too, and no toggle', async ($, on) => {
  engine(on, { store: { config: { ...pinned, showCompactPanel: false }, lastReading: reading(43) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /^43%$/ }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: /^4% over today$/ }))?.props.color).toBe('error')
  expect(await ui.find({ key: 'details-toggle' })).toBeUndefined()
  await ui.unmount()
})

// The host takes a Box width only as a whole percentage (/^\d{1,3}%$/): a plan whose
// shares are not whole (the default, 100/7 a day, and the window's partial days)
// must still give whole widths, which add up to the whole bar.
test('the label widths are whole percentages that add up to 100, whatever the plan', async ($, on) => {
  engine(on, { store: { config: DEFAULT_CONFIG, lastReading: reading(33) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  const widths: string[] = []
  for (let i = 0; i < 8; i++) {
    const width = (await ui.find({ key: `day-${i}` }))?.props.width
    if (typeof width === 'string') widths.push(width)
  }
  expect(widths).toHaveLength(8)
  for (const width of widths) expect(width).toMatch(/^\d{1,3}%$/)
  expect(widths.reduce((sum, width) => sum + Number.parseInt(width, 10), 0)).toBe(100)
  await ui.unmount()
})

// The desktop app draws the bar as a strip above the message box, its AbovePrompt
// band; the terminal (which has the status line) and VS Code (which has no band) don't.
const STRIP = {
  plugin: 'weekly-budget',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

test('the desktop strip has the coloured summary, a Details link and the bar', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })
  const ui = await $.ui.mount({ ...STRIP, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /^33%$/ }))?.props.color).toBe('success')
  expect((await ui.find({ type: 'Text', text: /^6% left today$/ }))?.props.color).toBe('success')
  expect((await ui.find({ key: 'strip-details' }))?.props).toMatchObject({ label: '▸ Details', plain: true, dimColor: true })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /^Fri$/ }))).toBeDefined()
  await ui.unmount()
})

test("the strip's Details link opens the details in the side panel", async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['desktop'] })
  const ui = await $.ui.mount({ ...STRIP, surface: 'desktop' })

  await ui.press({ key: 'strip-details' })

  expect(calls.opens).toEqual([{ id: 'details', title: 'Weekly budget' }])
  await ui.unmount()
})

test('the strip with no reading says so, and still links to the details', async ($, on) => {
  engine(on, { store: { config: pinned } })
  const ui = await $.ui.mount({ ...STRIP, surface: 'desktop' })

  expect(await ui.find({ type: 'Text', text: /No weekly reading yet/ })).toBeDefined()
  expect(await ui.find({ key: 'strip-details' })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'vscode'] as const) {
  test(`no strip on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned, lastReading: reading(33) } })
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>engine</Text>
    })
    const ui = await $.ui.mount({ ...STRIP, surface })

    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect(await ui.find({ key: 'strip-details' })).toBeUndefined()
    await ui.unmount()
  })
}

test('the strip gives way to a survey', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33) } })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({ ...STRIP, surface: 'desktop', props: { ...STRIP.props, hasSurvey: true } })

  expect(await ui.find({ key: 'strip-details' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /survey/ })).toBeDefined()
  await ui.unmount()
})

test('on the desktop no panel opens by itself: the strip is there instead', async ($, on) => {
  const { calls, clock } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['desktop'] })

  await start($, clock, 'desktop')
  await $.session.attach({ clientId: 'desktop-1', surface: 'desktop' })
  await clock.settle()

  expect(calls.opens).toEqual([])
})

test('/budget on the desktop opens the details in the side panel', async ($, on) => {
  const { calls } = engine(on, { store: { config: pinned, lastReading: reading(33) }, surfaces: ['desktop'] })

  const result = await run($, 'budget')

  expect(result.text).toBe('Budget details opened.')
  expect(calls.opens).toEqual([{ id: 'details', title: 'Weekly budget' }])
})
