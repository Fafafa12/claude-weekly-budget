import type { On, PaneOpenArgs, RenderSurface, UiPane } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Plugin } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config, Pin } from '../hooks/lib/config'

const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local, with WEEKLY_BUDGET_TZ_OFFSET_MIN=180
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const reading = (percentUsed: number) => ({ percentUsed, resetsMs: reset, at: now })

const weekdays95: Config = { ...DEFAULT_CONFIG, pins: [{ days: [1, 2, 3, 4, 5], percent: 95 }] }
const weekend10: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }

const BAD_PERCENT = 'A share must be between 0 and 100%.'
const OVER_100 = 'Pinned shares add up to more than 100%.'
const BAD_SNOOZE = 'Snooze options must be whole minutes, like 30, 60.'

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
const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
const stored = async ($: Engine, key: string): Promise<unknown> =>
  JSON.parse((await run($, 'probe', key)).text ?? 'null')
const storedConfig = async ($: Engine) => (await stored($, 'config')) as Config

type Calls = { opens: PaneOpenArgs[]; closes: string[]; statuses: (string | undefined)[] }

// Everything beneath the plugin: the clock, environment and store, and an engine
// that keeps its panes as the real one does, so that a pane the test closes is gone
// from `ui.panes`.
function engine(on: On, options: { store?: Record<string, unknown>; surfaces?: RenderSurface[] } = {}) {
  const calls: Calls = { opens: [], closes: [], statuses: [] }
  const state = { surfaces: options.surfaces ?? ['terminal'], panes: [] as UiPane[] }
  const clock = mock.clock(on, { now })
  mock.env(on, { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180' })
  mock.store(on, options.store ?? {})

  on('session.surfaces', () => ({ value: state.surfaces }))
  on('ui.status', (_, e) => {
    calls.statuses.push(e.text)
    return { value: undefined }
  })
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

const start = async ($: Engine, clock: MockClock, surface: RenderSurface) => {
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  await clock.settle()
}

const PANE = {
  plugin: 'weekly-budget',
  component: 'Pane',
  requestId: 'settings',
  props: {
    title: 'Weekly budget settings',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'vscode'] as const

// A setting is a row of choice buttons keyed `<setting>-<value>`; the chosen one is
// drawn at full strength, the others dim.
type Found = { key?: string; props: Record<string, unknown> }
type Drawn = { findAll: (query: { type: 'Button' }) => Promise<Found[]> }
const choicesOf = async (ui: Drawn, setting: string): Promise<Found[]> =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith(`${setting}-`) && !b.key.startsWith('remove-'))
const chosen = async (ui: Drawn, setting: string): Promise<string | undefined> => {
  const on = (await choicesOf(ui, setting)).filter(b => b.props.dimColor !== true)
  return on.length === 1 ? on[0]?.key?.slice(setting.length + 1) : undefined
}
const choices = async (ui: Drawn, setting: string) =>
  (await choicesOf(ui, setting)).map(b => [b.key?.slice(setting.length + 1), b.props.label])

for (const surface of SURFACES) {
  test(`add weekend pin on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'pin-days-weekend' })
    await ui.input({ key: 'pin-percent', text: '10' })

    expect((await storedConfig($)).pins).toEqual([{ days: [6, 0], percent: 10 }])
    expect((await ui.find({ type: 'Text', text: /Sat 5 · Sun 5/ }))?.text).toBe(
      'Plan: Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5',
    )
    await ui.unmount()
  })

  test(`replace overlapping pin on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'pin-days-weekend' })
    await ui.input({ key: 'pin-percent', text: '10' })

    await ui.press({ key: 'pin-days-sat' })
    await ui.input({ key: 'pin-percent', text: '2' })

    expect((await storedConfig($)).pins).toEqual([{ days: [6], percent: 2 }])
    expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
      'Plan: Mon 16.3 · Tue 16.3 · Wed 16.3 · Thu 16.3 · Fri 16.3 · Sat 2 · Sun 16.3',
    )
    await ui.unmount()
  })

  test(`a pin keeps the pins that do not share a day on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on, { store: { config: weekdays95 } })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'pin-days-sun' })
    await ui.input({ key: 'pin-percent', text: '5' })

    expect((await storedConfig($)).pins).toEqual([
      { days: [1, 2, 3, 4, 5], percent: 95 },
      { days: [0], percent: 5 },
    ])
    await ui.unmount()
  })

  test(`a percent is read as 10, 10% or 7.5 on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.input({ key: 'pin-percent', text: '10%' })
    expect((await storedConfig($)).pins).toEqual([{ days: [6, 0], percent: 10 }])

    await ui.input({ key: 'pin-percent', text: ' 7.5 ' })
    expect((await storedConfig($)).pins).toEqual([{ days: [6, 0], percent: 7.5 }])
    await ui.unmount()
  })

  for (const text of ['abc', '120', '', '-5', '1e1', '10 %%']) {
    test(`bad percent "${text}" keeps the config on ${surface}`, { plugins: [probe] }, async ($, on) => {
      engine(on, { store: { config: weekdays95 } })
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.input({ key: 'pin-percent', text })

      const shown = await ui.find({ type: 'Text', text: /between 0 and 100%/ })
      expect(shown?.text).toBe(BAD_PERCENT)
      expect(shown?.props.color).toBe('error')
      expect(await stored($, 'config')).toEqual(weekdays95)
      await ui.unmount()
    })
  }

  test(`over 100 keeps the config on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on, { store: { config: weekdays95 } })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'pin-days-weekend' })
    await ui.input({ key: 'pin-percent', text: '10' })

    const shown = await ui.find({ type: 'Text', text: /more than 100%/ })
    expect(shown?.text).toBe(OVER_100)
    expect(shown?.props.color).toBe('error')
    expect(await stored($, 'config')).toEqual(weekdays95)
    expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
      'Plan: Mon 19 · Tue 19 · Wed 19 · Thu 19 · Fri 19 · Sat 2.5 · Sun 2.5',
    )
    await ui.unmount()
  })

  test(`the next good change clears the error on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'pin-percent', text: 'abc' })
    expect(await ui.find({ type: 'Text', text: /between 0 and 100%/ })).toBeDefined()

    await ui.input({ key: 'pin-percent', text: '10' })

    expect(await ui.find({ type: 'Text', text: /between 0 and 100%/ })).toBeUndefined()
    expect(await ui.findAll({ type: 'Text', text: /\b100%|must be/ })).toEqual([])
    await ui.unmount()
  })

  test(`mode select on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await chosen(ui, 'mode'))).toBe('warn')

    await ui.press({ key: 'mode-block' })

    expect((await storedConfig($)).mode).toBe('block')
    expect((await chosen(ui, 'mode'))).toBe('block')
    await ui.unmount()
  })

  test(`heads-up select on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await chosen(ui, 'heads-up'))).toBe('0.25')

    await ui.press({ key: 'heads-up-off' })
    expect(await storedConfig($)).toMatchObject({ headsUpEnabled: false, headsUpFraction: 0.25 })
    expect((await chosen(ui, 'heads-up'))).toBe('off')

    await ui.press({ key: 'heads-up-0.5' })
    expect(await storedConfig($)).toMatchObject({ headsUpEnabled: true, headsUpFraction: 0.5 })
    expect((await chosen(ui, 'heads-up'))).toBe('0.5')
    await ui.unmount()
  })

  test(`status style select on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await chosen(ui, 'status-style'))).toBe('B')

    await ui.press({ key: 'status-style-C' })

    expect((await storedConfig($)).statusStyle).toBe('C')
    await ui.unmount()
  })

  test(`snooze options on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ key: 'snooze-options' }))?.props.value).toBe('60')

    await ui.input({ key: 'snooze-options', text: '30, 60' })

    expect((await storedConfig($)).snoozeOptionsMin).toEqual([30, 60])
    expect((await ui.find({ key: 'snooze-options' }))?.props.value).toBe('30, 60')
    await ui.unmount()
  })

  test(`snooze options are deduped, in the order given, on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.input({ key: 'snooze-options', text: '60, 30, 60' })

    expect((await storedConfig($)).snoozeOptionsMin).toEqual([60, 30])
    await ui.unmount()
  })

  for (const text of ['x', '0.5', '0', '', '-30', '30, x', '30,, 60', '1e2']) {
    test(`bad snooze options "${text}" keep the config on ${surface}`, { plugins: [probe] }, async ($, on) => {
      engine(on, { store: { config: weekend10 } })
      const ui = await $.ui.mount({ ...PANE, surface })

      await ui.input({ key: 'snooze-options', text })

      const shown = await ui.find({ type: 'Text', text: /whole minutes/ })
      expect(shown?.text).toBe(BAD_SNOOZE)
      expect(shown?.props.color).toBe('error')
      expect(await stored($, 'config')).toEqual(weekend10)
      await ui.unmount()
    })
  }

  const switching = `compact off keeps the pane up and re-opens it in the full view on ${surface}`
  test(switching, { plugins: [probe] }, async ($, on) => {
    const { calls, clock, state } = engine(on, { surfaces: ['vscode'], store: { lastReading: reading(33) } })
    await start($, clock, 'vscode')
    expect(calls.opens).toEqual([{ id: 'compact', title: expect.any(String), rows: 4 }])
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await chosen(ui, 'compact-panel'))).toBe('on')

    await ui.press({ key: 'compact-panel-off' })

    expect((await storedConfig($)).showCompactPanel).toBe(false)
    expect(calls.closes).toEqual([])
    expect(state.panes.map(p => p.id)).toEqual(['compact'])
    expect(calls.opens).toHaveLength(2)
    expect(calls.opens.at(-1)).toMatchObject({ id: 'compact', rows: 18 })
    expect((await chosen(ui, 'compact-panel'))).toBe('off')

    await ui.press({ key: 'compact-panel-on' })

    expect((await storedConfig($)).showCompactPanel).toBe(true)
    expect(calls.closes).toEqual([])
    expect(calls.opens.at(-1)).toMatchObject({ id: 'compact', rows: 4 })
    await ui.unmount()
  })
}

test('the weekend, weekdays and each day pin what their names say', { plugins: [probe] }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const DAYS = [
    ['weekdays', [1, 2, 3, 4, 5]],
    ['mon', [1]],
    ['tue', [2]],
    ['wed', [3]],
    ['thu', [4]],
    ['fri', [5]],
    ['sat', [6]],
    ['sun', [0]],
  ] as const

  for (const [value, days] of DAYS) {
    await ui.press({ key: 'reset-plan' })
    await ui.press({ key: `pin-days-${value}` })
    await ui.input({ key: 'pin-percent', text: '1' })
    expect((await storedConfig($)).pins).toEqual([{ days, percent: 1 }])
  }
  await ui.unmount()
})

test('the days picked stay picked across redraws', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await chosen(ui, 'pin-days'))).toBe('weekend')

  await ui.press({ key: 'pin-days-thu' })
  await ui.press({ key: 'mode-rewarn' })

  expect((await chosen(ui, 'pin-days'))).toBe('thu')
  await ui.unmount()
})

test('the controls are labelled', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ key: 'pin-percent' }))?.props.label).toBe('% of the week')
  expect((await ui.find({ key: 'snooze-options' }))?.props.label).toBe('Snooze options (minutes, comma-separated)')
  expect(await choices(ui, 'mode')).toEqual([
    ['warn', 'Warn once'],
    ['rewarn', 'Every message'],
    ['block', 'Block'],
  ])
  expect(await choices(ui, 'heads-up')).toEqual([
    ['off', 'Off'],
    ['0.1', '10%'],
    ['0.25', '25%'],
    ['0.5', '50%'],
  ])
  expect(await choices(ui, 'status-style')).toEqual([
    ['A', 'Numbers'],
    ['B', 'Bar'],
    ['C', 'Minimal'],
  ])
  expect(await choices(ui, 'pin-days')).toEqual([
    ['weekend', 'Weekend'],
    ['weekdays', 'Weekdays'],
    ['mon', 'Mon'],
    ['tue', 'Tue'],
    ['wed', 'Wed'],
    ['thu', 'Thu'],
    ['fri', 'Fri'],
    ['sat', 'Sat'],
    ['sun', 'Sun'],
  ])
  expect(await choices(ui, 'compact-panel')).toEqual([
    ['on', 'On'],
    ['off', 'Off'],
  ])
  expect(await choices(ui, 'leftover')).toEqual([
    ['fixed', 'Fixed'],
    ['adaptive', 'Adaptive'],
  ])
  await ui.unmount()
})

test('a heads-up fraction the menu does not list selects nothing', async ($, on) => {
  engine(on, { store: { config: { ...DEFAULT_CONFIG, headsUpFraction: 0.3 } } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await chosen(ui, 'heads-up'))).toBeUndefined()
  await ui.unmount()
})

test('a button removes each pin, and says which', { plugins: [probe] }, async ($, on) => {
  const weekend5: Pin = { days: [6, 0], percent: 5 }
  const config = { ...DEFAULT_CONFIG, pins: [...weekdays95.pins, weekend5] }
  engine(on, { store: { config } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const labels = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.label])
  expect(labels).toContainEqual(['remove-pin-0', 'Remove Mon+Tue+Wed+Thu+Fri 95%'])
  expect(labels).toContainEqual(['remove-pin-1', 'Remove Sat+Sun 5%'])

  await ui.press({ key: 'remove-pin-0' })

  expect((await storedConfig($)).pins).toEqual([{ days: [6, 0], percent: 5 }])
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
    'Plan: Mon 19 · Tue 19 · Wed 19 · Thu 19 · Fri 19 · Sat 2.5 · Sun 2.5',
  )
  expect(await ui.find({ key: 'remove-pin-1' })).toBeUndefined()
  expect((await ui.find({ key: 'remove-pin-0' }))?.props.label).toBe('Remove Sat+Sun 5%')
  await ui.unmount()
})

test('a button removes the pin it drew, not what stands there now', { plugins: [probe, writer] }, async ($, on) => {
  const weekend5: Pin = { days: [6, 0], percent: 5 }
  engine(on, { store: { config: { ...DEFAULT_CONFIG, pins: [...weekdays95.pins, weekend5] } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Another session drops the weekdays pin after this pane drew its buttons.
  await run($, 'put', `config ${JSON.stringify({ ...DEFAULT_CONFIG, pins: [weekend5] })}`)
  await ui.press({ key: 'remove-pin-0' })

  expect((await storedConfig($)).pins).toEqual([weekend5])
  await ui.unmount()
})

test('reset plan drops every pin', { plugins: [probe] }, async ($, on) => {
  engine(on, { store: { config: weekdays95 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'reset-plan' })

  expect((await storedConfig($)).pins).toEqual([])
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
    'Plan: Mon 14.3 · Tue 14.3 · Wed 14.3 · Thu 14.3 · Fri 14.3 · Sat 14.3 · Sun 14.3',
  )
  expect(await ui.find({ type: 'Button', text: /Remove/ })).toBeUndefined()
  await ui.unmount()
})

test('pins that total 100 with days left over say those days get 0%', async ($, on) => {
  const NOTE = 'Days without a share get 0%.'
  const full: Config = { ...DEFAULT_CONFIG, pins: [{ days: [1, 2, 3, 4, 5], percent: 100 }] }
  engine(on, { store: { config: full } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /Days without/ }))?.text).toBe(NOTE)
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toBe(
    'Plan: Mon 20 · Tue 20 · Wed 20 · Thu 20 · Fri 20 · Sat 0 · Sun 0',
  )
  await ui.unmount()
})

test('no such note when every day has a share', async ($, on) => {
  const everyDay: Config = {
    ...DEFAULT_CONFIG,
    pins: [
      { days: [1, 2, 3, 4, 5], percent: 70 },
      { days: [6, 0], percent: 30 },
    ],
  }
  engine(on, { store: { config: everyDay } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Days without/ })).toBeUndefined()
  await ui.unmount()
})

test('no such note while the unpinned days still have a share to split', async ($, on) => {
  engine(on, { store: { config: weekdays95 } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /Days without/ })).toBeUndefined()
  await ui.unmount()
})

// ✕ closes the panel for the chat; only /budget brings it back.
test('switching the view does not reopen a pane the person closed', async ($, on) => {
  const { calls, clock, state } = engine(on, { surfaces: ['vscode'], store: { lastReading: reading(33) } })
  await start($, clock, 'vscode')
  expect(calls.opens.map(o => o.id)).toEqual(['compact'])
  state.panes = []
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'compact-panel-off' })
  await ui.press({ key: 'compact-panel-on' })

  expect(calls.opens.map(o => o.id)).toEqual(['compact'])
  expect(calls.closes).toEqual([])
  expect(state.panes).toEqual([])
  await ui.unmount()
})

test('switching the view with no pane up opens nothing', async ($, on) => {
  const { calls } = engine(on, { surfaces: ['vscode'] })
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'compact-panel-off' })

  expect(calls.opens).toEqual([])
  expect(calls.closes).toEqual([])
  await ui.unmount()
})

test('switching the panel on does not open one on the terminal', async ($, on) => {
  const { calls } = engine(on, { store: { config: { ...DEFAULT_CONFIG, showCompactPanel: false } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'compact-panel-on' })

  expect(calls.opens).toEqual([])
  await ui.unmount()
})

test('other changes do not close the compact pane', async ($, on) => {
  const { calls, clock } = engine(on, { surfaces: ['vscode'], store: { lastReading: reading(33) } })
  await start($, clock, 'vscode')
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  await ui.press({ key: 'mode-block' })
  await ui.input({ key: 'pin-percent', text: '10' })

  expect(calls.closes).toEqual([])
  await ui.unmount()
})

test('a new plan reaches the status line', async ($, on) => {
  const { calls } = engine(on, { store: { lastReading: reading(33) } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'pin-days-weekend' })
  await ui.input({ key: 'pin-percent', text: '10' })

  expect(calls.statuses.at(-1)).toContain('33% → 39%')
  await ui.unmount()
})

test('/budget-config opens the settings pane', async ($, on) => {
  const { calls } = engine(on)

  const result = await run($, 'budget-config')

  expect(result.text).toBe('Budget settings opened.')
  expect(calls.opens).toEqual([{ id: 'settings', title: 'Weekly budget settings', focus: true }])
})

test('the mobile app, which draws no field yet, is told where the settings are', async ($, on) => {
  engine(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })

  expect((await ui.find({ type: 'Text' }))?.text).toBe(
    'Open /budget-config in the terminal or VS Code to change the settings.',
  )
  expect(await ui.findAll({ type: 'Select' })).toEqual([])
  await ui.unmount()
})

test('the settings show what is stored, with no reading', async ($, on) => {
  engine(on, {
    store: {
      config: {
        ...DEFAULT_CONFIG,
        pins: [{ days: [6, 0], percent: 10 }],
        mode: 'rewarn',
        headsUpEnabled: false,
        statusStyle: 'A',
        snoozeOptionsMin: [15, 90],
        showCompactPanel: false,
      },
    },
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const values = async (...settings: string[]) => Promise.all(settings.map(setting => chosen(ui, setting)))
  expect(await values('mode', 'heads-up', 'status-style', 'compact-panel')).toEqual(['rewarn', 'off', 'A', 'off'])
  expect((await ui.find({ key: 'snooze-options' }))?.props.value).toBe('15, 90')
  expect((await ui.find({ type: 'Text', text: /Plan:/ }))?.text).toContain('Sat 5 · Sun 5')
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

// A config a later version of the plugin wrote may hold what this one cannot read:
// saving over it would lose that, so no change is saved until the plugin is updated.
const NEWER = 'These settings were saved by a newer version of weekly-budget. Update the plugin to change them.'
for (const surface of SURFACES) {
  test(`settings saved by a newer version are not overwritten on ${surface}`, { plugins: [probe] }, async ($, on) => {
    const newer = { ...weekend10, version: 2, futureField: 'kept' }
    engine(on, { store: { config: newer } })
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'mode-block' })

    const shown = await ui.find({ type: 'Text', text: /newer version/ })
    expect(shown?.text).toBe(NEWER)
    expect(shown?.props.color).toBe('error')
    expect(await stored($, 'config')).toEqual(newer)

    await ui.input({ key: 'pin-percent', text: '10' })
    await ui.press({ key: 'reset-plan' })
    expect(await stored($, 'config')).toEqual(newer)
    await ui.unmount()
  })
}

test('a config of this version, or with no version, is still saved', { plugins: [probe] }, async ($, on) => {
  const { version: _, ...unversioned } = weekend10
  engine(on, { store: { config: unversioned } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'mode-block' })

  expect((await storedConfig($)).mode).toBe('block')
  expect(await ui.find({ type: 'Text', text: /newer version/ })).toBeUndefined()
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`choices are plain buttons, the chosen one at full strength, on ${surface}`, async ($, on) => {
    engine(on, { store: { config: { ...DEFAULT_CONFIG, mode: 'block' } } })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.findAll({ type: 'Select' })).toEqual([])
    const modes = await choicesOf(ui, 'mode')
    expect(modes.every(b => b.props.plain === true)).toBe(true)
    expect(modes.map(b => [b.key, b.props.dimColor === true])).toEqual([
      ['mode-warn', true],
      ['mode-rewarn', true],
      ['mode-block', false],
    ])
    await ui.unmount()
  })
}

test('in the terminal a hint says how to use the keys', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /Tab/ }))?.text).toBe('Tab or arrows to move · Enter to choose · Esc to go back to the prompt')
  await ui.unmount()
})

test('VS Code, where a click does it, has no key hint', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect(await ui.find({ type: 'Text', text: /Tab or arrows/ })).toBeUndefined()
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`leftover choice on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await chosen(ui, 'leftover')).toBe('fixed')

    await ui.press({ key: 'leftover-adaptive' })

    expect((await storedConfig($)).leftover).toBe('adaptive')
    expect(await chosen(ui, 'leftover')).toBe('adaptive')
    await ui.unmount()
  })
}
