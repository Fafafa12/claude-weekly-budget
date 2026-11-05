import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import {
  applyCompactPanel,
  applyConfig,
  getPinDraftDays,
  getSettingsError,
  setPinDraftDays,
  setSettingsError,
} from '../controller'
import { DAY_NAMES } from '../lib/config'
import type { Config, Mode, Pin, StatusStyle, Weekday } from '../lib/config'
import { pct } from '../lib/format'
import { loadConfig } from '../lib/store'
import { planLine } from './shared'

type Choice<V extends string = string> = { value: V; label: string }

// What a Select is given: the value and the label alone, whatever else a table keeps.
const optionsOf = (choices: readonly Choice[]): Choice[] => choices.map(({ value, label }) => ({ value, label }))

// What a pin can be for: a group of days, or one.
type PinGroup = Choice & { days: Weekday[] }
const WEEKEND: PinGroup = { value: 'weekend', label: 'Weekend (Sat+Sun)', days: [6, 0] }
const PIN_GROUPS: readonly PinGroup[] = [
  WEEKEND,
  { value: 'weekdays', label: 'Weekdays (Mon-Fri)', days: [1, 2, 3, 4, 5] },
  { value: 'mon', label: 'Monday', days: [1] },
  { value: 'tue', label: 'Tuesday', days: [2] },
  { value: 'wed', label: 'Wednesday', days: [3] },
  { value: 'thu', label: 'Thursday', days: [4] },
  { value: 'fri', label: 'Friday', days: [5] },
  { value: 'sat', label: 'Saturday', days: [6] },
  { value: 'sun', label: 'Sunday', days: [0] },
]

const MODES: readonly Choice<Mode>[] = [
  { value: 'warn', label: 'Warn once' },
  { value: 'rewarn', label: 'Warn on every message' },
  { value: 'block', label: 'Block next message' },
]

// The heads-up is on at one of these fractions of today's share still left, or off.
const HEADS_UPS: readonly (Choice & { fraction: number | null })[] = [
  { value: 'off', label: 'Off', fraction: null },
  { value: '0.1', label: '10% of today left', fraction: 0.1 },
  { value: '0.25', label: '25% of today left', fraction: 0.25 },
  { value: '0.5', label: '50% of today left', fraction: 0.5 },
]

const STYLES: readonly Choice<StatusStyle>[] = [
  { value: 'A', label: 'Numbers' },
  { value: 'B', label: 'Bar' },
  { value: 'C', label: 'Minimal' },
]

const PANEL: readonly Choice[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

// The group a draft names; the weekend when it names none.
const pinGroup = (value: string): PinGroup => PIN_GROUPS.find(group => group.value === value) ?? WEEKEND

const BAD_SNOOZE_OPTIONS = 'Snooze options must be whole minutes, like 30, 60.'
const SUM_SLACK = 1e-9 // as validatePins has it: shares that add up to 100 may be off by rounding

// "10", "10%" and "7.5" are a percent of the week; anything else is not. It is not
// checked to be between 0 and 100: the plan's own checks say that.
export function parsePercent(s: string): number | null {
  const digits = /^(\d+(?:\.\d+)?)\s*%?$/.exec(s.trim())?.[1]
  return digits === undefined ? null : Number(digits)
}

// "30, 60, 30" is 30 and 60: whole minutes, each once, in the order given. Anything
// else, an empty one included, is not a list.
function parseSnoozeOptions(s: string): number[] | null {
  const parts = s.split(',').map(part => part.trim())
  if (!parts.every(part => /^\d+$/.test(part))) return null
  const minutes = parts.map(Number)
  if (!minutes.every(m => Number.isSafeInteger(m) && m > 0)) return null
  return [...new Set(minutes)]
}

// "Sat+Sun": the days a pin is for.
const daysLabel = (days: Weekday[]): string => days.map(day => DAY_NAMES[day]).join('+')

// The stored config with a change, which goes through the plan's checks like any other.
async function change($: EngineInterface, patch: Partial<Config>): Promise<void> {
  await applyConfig($, { ...(await loadConfig($)), ...patch })
}

// Pins the picked days at the percent, in place of any pin that shares a day with them.
async function addPin($: EngineInterface, text: string): Promise<void> {
  const [cfg, picked] = await Promise.all([loadConfig($), getPinDraftDays($)])
  const { days } = pinGroup(picked)
  const rest = cfg.pins.filter(pin => !pin.days.some(day => days.includes(day)))
  // NaN is no share: the plan's checks refuse it with the words for a bad percent.
  const pin: Pin = { days: [...days], percent: parsePercent(text) ?? NaN }
  await applyConfig($, { ...cfg, pins: [...rest, pin] })
}

// By what the pin is rather than where it stands: another session may have changed
// the list since this one drew its buttons.
async function removePin($: EngineInterface, gone: Pin): Promise<void> {
  const cfg = await loadConfig($)
  const isGone = (pin: Pin) => pin.percent === gone.percent && pin.days.join() === gone.days.join()
  await applyConfig($, { ...cfg, pins: cfg.pins.filter(pin => !isGone(pin)) })
}

async function pickMode($: EngineInterface, value: string): Promise<void> {
  const mode = MODES.find(m => m.value === value)
  if (mode !== undefined) await change($, { mode: mode.value })
}

async function pickHeadsUp($: EngineInterface, value: string): Promise<void> {
  const headsUp = HEADS_UPS.find(h => h.value === value)
  if (headsUp === undefined) return
  const { fraction } = headsUp
  await change($, fraction === null ? { headsUpEnabled: false } : { headsUpEnabled: true, headsUpFraction: fraction })
}

async function pickStyle($: EngineInterface, value: string): Promise<void> {
  const style = STYLES.find(s => s.value === value)
  if (style !== undefined) await change($, { statusStyle: style.value })
}

async function setSnoozeOptions($: EngineInterface, text: string): Promise<void> {
  const minutes = parseSnoozeOptions(text)
  if (minutes === null) await setSettingsError($, BAD_SNOOZE_OPTIONS)
  else await change($, { snoozeOptionsMin: minutes })
}

// The heads-up's choice for the config; none when it holds a fraction the menu has no entry for.
const headsUpValue = (cfg: Config): string | undefined =>
  cfg.headsUpEnabled ? HEADS_UPS.find(h => h.fraction === cfg.headsUpFraction)?.value : 'off'

// Pins that add up to the whole week leave the other days nothing.
function leavesDaysEmpty(pins: Pin[]): boolean {
  const total = pins.reduce((sum, pin) => sum + pin.percent, 0)
  const pinnedDays = new Set(pins.flatMap(pin => pin.days))
  return Math.abs(total - 100) <= SUM_SLACK && pinnedDays.size < 7
}

// The body of the settings pane, which /budget-config opens: the plan (pins and the
// shares they make), the warnings, and what is drawn. Every control applies on its
// own, through the plan's checks; what a check refuses is shown in red and changes nothing.
export async function renderSettings($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  // The mobile app draws no field yet.
  if (e.surface === 'mobile') {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Open /budget-config in the terminal or VS Code to change the settings.</Text>
  }
  const { Box, Button, Input, Select, Text } = $.ui.resolve(e)
  const [cfg, picked, error] = await Promise.all([loadConfig($), getPinDraftDays($), getSettingsError($)])

  return (
    <Box flexDirection="column" gap={1}>
      {error !== null && <Text color="error">{error}</Text>}
      <Box flexDirection="column">
        <Select
          key="pin-days"
          label="Pin"
          options={optionsOf(PIN_GROUPS)}
          value={pinGroup(picked).value}
          onSelect={days => setPinDraftDays($, days)}
        />
        <Input key="pin-percent" label="% of the week" placeholder="10" onSubmit={text => addPin($, text)} />
      </Box>
      <Box flexDirection="column">
        <Text>{planLine(cfg)}</Text>
        {leavesDaysEmpty(cfg.pins) && <Text dimColor>Days without a share get 0%.</Text>}
      </Box>
      <Box flexWrap="wrap" gap={1}>
        {cfg.pins.map((pin, i) => (
          <Button
            key={`remove-pin-${i}`}
            label={`Remove ${daysLabel(pin.days)} ${pct(pin.percent)}%`}
            onPress={() => removePin($, pin)}
          />
        ))}
        <Button key="reset-plan" label="Reset plan" onPress={() => change($, { pins: [] })} />
      </Box>
      <Box flexDirection="column">
        <Select
          key="mode"
          label="Mode"
          options={optionsOf(MODES)}
          value={cfg.mode}
          onSelect={value => pickMode($, value)}
        />
        <Select
          key="heads-up"
          label="Heads-up"
          options={optionsOf(HEADS_UPS)}
          value={headsUpValue(cfg)}
          onSelect={value => pickHeadsUp($, value)}
        />
        <Input
          key="snooze-options"
          label="Snooze options (minutes, comma-separated)"
          value={cfg.snoozeOptionsMin.join(', ')}
          onSubmit={text => setSnoozeOptions($, text)}
        />
      </Box>
      <Box flexDirection="column">
        <Select
          key="status-style"
          label="Status line"
          options={optionsOf(STYLES)}
          value={cfg.statusStyle}
          onSelect={value => pickStyle($, value)}
        />
        <Select
          key="compact-panel"
          label="Compact panel (VS Code)"
          options={optionsOf(PANEL)}
          value={cfg.showCompactPanel ? 'on' : 'off'}
          onSelect={value => applyCompactPanel($, value === 'on')}
        />
      </Box>
    </Box>
  )
}
