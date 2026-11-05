import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { textBar } from '../hooks/lib/format'

const HOUR_MS = 3600e3
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local, with WEEKLY_BUDGET_TZ_OFFSET_MIN=180
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local

// Thu 15:00 with a weekend pin of 10%: the plan allows 39% by tonight and 18% of
// it is today's, so 33% is ok (6% left) and 43% is over (4% over).
const pinned: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reading = (percentUsed: number, at = now) => ({ percentUsed, resetsMs: reset, at })

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
const stored = async ($: Engine, key: string): Promise<unknown> =>
  JSON.parse(
    (
      await $.command.run({
        command: 'probe',
        args: key,
        origin: { kind: 'composer' },
        presentation: { isFullscreen: false, columns: 80 },
      })
    ).text ?? 'null',
  )

// Everything beneath the plugin: the clock, environment and store, and the engine
// calls a refresh makes (it redraws the status line and the other panes).
function engine(on: On, options: { store?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const calls = { invalidated: [] as string[] }
  mock.clock(on, { now })
  mock.env(on, options.env ?? { WEEKLY_BUDGET_TZ_OFFSET_MIN: '180' })
  mock.store(on, options.store ?? { config: pinned, lastReading: reading(33) })

  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.invalidate', (_, e, next) => {
    calls.invalidated.push(e.event)
    return next(e)
  })
  return calls
}

const PANE = {
  plugin: 'weekly-budget',
  component: 'Pane',
  requestId: 'details',
  props: {
    title: 'Weekly budget',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'vscode'] as const

for (const surface of SURFACES) {
  test(`details shows numbers on ${surface}`, async ($, on) => {
    engine(on)

    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Used 33%/ }))?.text).toBe('Used 33%')
    expect((await ui.find({ type: 'Text', text: /Allowed by tonight 39%/ }))?.text).toBe('Allowed by tonight 39%')
    expect((await ui.find({ type: 'Text', text: /6% left today/ }))?.text).toBe('6% left today')
    expect((await ui.find({ type: 'Text', text: /Resets/ }))?.text).toBe('Resets Tue 20:00 (in 5d 5h)')
    expect((await ui.find({ type: 'Text', text: /Sat 5 · Sun 5/ }))?.text).toBe(
      'Plan: Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5',
    )
    expect((await ui.find({ type: 'Text', text: /Mode/ }))?.text).toBe('Mode: warn')
    expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings on')
    await ui.unmount()
  })

  test(`snooze button snoozes on ${surface}`, { plugins: [probe] }, async ($, on) => {
    const calls = engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'resume' })).toBeUndefined()
    const drawn = calls.invalidated.length

    await ui.press({ key: 'snooze-60' })

    expect(await stored($, 'snooze')).toEqual({ until: now + HOUR_MS })
    expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings snoozed until 16:00')
    expect((await ui.find({ key: 'resume' }))?.props.label).toBe('Resume')
    // The status line and the other panes are brought up to it.
    expect(calls.invalidated.length).toBeGreaterThan(drawn)

    await ui.press({ key: 'resume' })

    expect(await stored($, 'snooze')).toEqual({ until: null })
    expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings on')
    expect(await ui.find({ key: 'resume' })).toBeUndefined()
    await ui.unmount()
  })

  test(`snooze today on ${surface}`, { plugins: [probe] }, async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ ...PANE, surface })

    await ui.press({ key: 'snooze-today' })

    expect(await stored($, 'snooze')).toEqual({ until: Date.parse('2026-11-05T21:00:00Z') })
    expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings snoozed until 00:00')
    await ui.unmount()
  })
}

// The panes follow Claude's theme through its colour keys, not fixed colours.
const STATE_COLORS = [
  { used: 33, color: 'success', text: '6% left today' },
  { used: 37, color: 'warning', text: '2% left today' },
  { used: 43, color: 'error', text: '4% over today' },
] as const
for (const surface of SURFACES) {
  for (const { used, color, text } of STATE_COLORS) {
    test(`today's line is ${color} at ${used}% on ${surface}`, async ($, on) => {
      engine(on, { store: { config: pinned, lastReading: reading(used) } })

      const ui = await $.ui.mount({ ...PANE, surface })

      const today = await ui.find({ type: 'Text', text: /left today|over today|limit reached/ })
      expect(today?.text).toBe(text)
      expect(today?.props.color).toBe(color)
      await ui.unmount()
    })
  }

  test(`the reset line is accented in Claude's colour on ${surface}`, async ($, on) => {
    engine(on)

    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Resets/ }))?.props.color).toBe('claude')
    await ui.unmount()
  })
}

for (const surface of SURFACES) {
  test(`a stale reading is marked last known on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned, lastReading: reading(33, now - HOUR_MS) } })

    const ui = await $.ui.mount({ ...PANE, surface })

    const mark = await ui.find({ type: 'Text', text: /Last known/ })
    expect(mark?.text).toBe('Last known, as of 14:00')
    expect(mark?.props.dimColor).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Used/ }))?.text).toBe('Used 33%')
    await ui.unmount()
  })

  test(`a fresh reading has no last-known mark on ${surface}`, async ($, on) => {
    engine(on)

    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /Last known|as of/ })).toBeUndefined()
    await ui.unmount()
  })
}

test('a reading from yesterday is last known with its weekday', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33, now - 24 * HOUR_MS) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  expect((await ui.find({ type: 'Text', text: /Last known/ }))?.text).toBe('Last known, as of Wed 15:00')
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toEndWith(' · as of Wed 15:00')
  await ui.unmount()
})

// The one panel of VS Code carries the toggle; the details pane is all details.
for (const surface of SURFACES) {
  test(`the details pane has no Details toggle on ${surface}`, async ($, on) => {
    engine(on)

    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ key: 'details-toggle' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /Used 33%/ }))?.text).toBe('Used 33%')
    await ui.unmount()
  })
}

test('terminal has no Svg', async ($, on) => {
  engine(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  const bar = await ui.find({ type: 'Text', text: /│/ })
  expect(bar?.text).toBe(textBar(33, 39))
  expect(bar?.props.mono).toBe(true)
  await ui.unmount()
})

test('vscode draws the bar as an Svg, not as text', async ($, on) => {
  engine(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  const bars = await ui.findAll({ type: 'Svg' })
  expect(bars).toHaveLength(1)
  expect(bars[0]?.props).toMatchObject({ alt: '33% of 39% · 6% left today', width: 456, height: 34 })
  expect(String(bars[0]?.props.source)).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"')
  expect(await ui.find({ type: 'Text', text: /│/ })).toBeUndefined()
  await ui.unmount()
})

test('a button for each snooze option, labelled by its length', async ($, on) => {
  engine(on, { store: { config: { ...pinned, snoozeOptionsMin: [15, 60, 90, 120] }, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const buttons = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.props.label])
  expect(buttons).toEqual([
    ['snooze-15', 'Snooze 15m'],
    ['snooze-60', 'Snooze 1h'],
    ['snooze-90', 'Snooze 1h 30m'],
    ['snooze-120', 'Snooze 2h'],
    ['snooze-today', 'Snooze today'],
  ])
  await ui.unmount()
})

test('a snooze that is running shows when it ends, and Resume', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33), snooze: { until: now + 90 * 60e3 } } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings snoozed until 16:30')
  expect((await ui.find({ key: 'resume' }))?.props.label).toBe('Resume')
  await ui.unmount()
})

test('a snooze that has run out counts as off', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(33), snooze: { until: now - 1 } } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /Warnings/ }))?.text).toBe('Warnings on')
  expect(await ui.find({ key: 'resume' })).toBeUndefined()
  await ui.unmount()
})

const MODE_TEXT = { warn: 'Mode: warn', rewarn: 'Mode: re-warn', block: 'Mode: block' } as const
for (const mode of ['warn', 'rewarn', 'block'] as const) {
  test(`the ${mode} mode is shown as ${MODE_TEXT[mode]}`, async ($, on) => {
    engine(on, { store: { config: { ...pinned, mode }, lastReading: reading(33) } })

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    expect((await ui.find({ type: 'Text', text: /Mode/ }))?.text).toBe(MODE_TEXT[mode])
    await ui.unmount()
  })
}

test('over today says so', async ($, on) => {
  engine(on, { store: { config: pinned, lastReading: reading(43) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /over today/ }))?.text).toBe('4% over today')
  expect((await ui.find({ type: 'Text', text: /Used/ }))?.text).toBe('Used 43%')
  await ui.unmount()
})

test('an unpinned plan shares the week evenly', async ($, on) => {
  engine(on, { store: { lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await ui.find({ type: 'Text', text: /Plan/ }))?.text).toBe(
    'Plan: Mon 14.3 · Tue 14.3 · Wed 14.3 · Thu 14.3 · Fri 14.3 · Sat 14.3 · Sun 14.3',
  )
  await ui.unmount()
})

test('times are in the configured zone', { plugins: [probe] }, async ($, on) => {
  // UTC-5: now is Thu 07:00 and the reset Tue 12:00.
  engine(on, { env: { WEEKLY_BUDGET_TZ_OFFSET_MIN: '-300' }, store: { config: pinned, lastReading: reading(33) } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Resets/ }))?.text).toBe('Resets Tue 12:00 (in 5d 5h)')

  await ui.press({ key: 'snooze-today' })
  expect(await stored($, 'snooze')).toEqual({ until: Date.parse('2026-11-06T05:00:00Z') })
  await ui.unmount()
})

for (const surface of SURFACES) {
  test(`with no reading: the text and the plan, no bar, on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned } })

    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /No weekly reading yet/ }))?.text).toBe(
      'No weekly reading yet — send a message.',
    )
    expect((await ui.find({ type: 'Text', text: /Sat 5 · Sun 5/ }))?.text).toBe(
      'Plan: Mon 18 · Tue 18 · Wed 18 · Thu 18 · Fri 18 · Sat 5 · Sun 5',
    )
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Used|Allowed|Resets/ })).toBeUndefined()
    await ui.unmount()
  })
}

// The state reads as a word in Claude's theme colour, not as a coloured dot.
const STATE_LABELS = [
  [33, 'On track', 'success'],
  [37, 'Running low', 'warning'],
  [43, 'Over today', 'error'],
  [100, 'Weekly limit reached', 'error'],
] as const
for (const surface of SURFACES) {
  for (const [used, label, color] of STATE_LABELS) {
    test(`at ${used}% the state reads "${label}" in ${color} on ${surface}`, async ($, on) => {
      engine(on, { store: { config: pinned, lastReading: reading(used) } })
      const ui = await $.ui.mount({ ...PANE, surface })

      expect((await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) }))?.props).toMatchObject({ color, bold: true })
      await ui.unmount()
    })
  }

  test(`the snooze buttons are secondary, not primary, on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned, lastReading: reading(33), snooze: { until: now + HOUR_MS } } })
    const ui = await $.ui.mount({ ...PANE, surface })

    for (const key of ['snooze-60', 'snooze-today', 'resume']) {
      expect((await ui.find({ key }))?.props.variant).toBe('secondary')
    }
    await ui.unmount()
  })

  test(`with no reading there is no state label on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned } })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: /^(On track|Running low|Over today|Weekly limit reached)$/ })).toBeUndefined()
    await ui.unmount()
  })
}

// At the limit the label says it; there is no today line repeating it.
for (const surface of SURFACES) {
  test(`at the weekly limit the state is said once on ${surface}`, async ($, on) => {
    engine(on, { store: { config: pinned, lastReading: reading(100) } })
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.findAll({ type: 'Text', text: /limit reached/i })).toHaveLength(1)
    await ui.unmount()
  })
}
