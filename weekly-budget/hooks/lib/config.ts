import type { Config, Mode, Pin, StatusStyle, Weekday } from '../../types'

// The types live in the plugin's contract, types/index.d.ts.
export type { Config, Mode, Pin, StatusStyle, Weekday }

export const DEFAULT_CONFIG: Config = {
  version: 1,
  pins: [],
  mode: 'warn',
  headsUpEnabled: true,
  headsUpFraction: 0.25,
  statusStyle: 'B',
  snoozeOptionsMin: [60],
  showCompactPanel: true,
}

const MODES: readonly Mode[] = ['warn', 'rewarn', 'block']
const STYLES: readonly StatusStyle[] = ['A', 'B', 'C']
const SUM_SLACK = 1e-9

// Each weekday's share of the week, by Weekday. Pinned days split their group's
// percent evenly; the rest share what is left of 100, and get 0 when nothing is.
export function dayShares(pins: Pin[]): number[] {
  const shares: (number | null)[] = Array(7).fill(null)
  let pinned = 0
  for (const pin of pins) {
    pinned += pin.percent
    for (const day of pin.days) shares[day] = pin.percent / pin.days.length
  }
  const unpinned = shares.filter(s => s === null).length
  const rest = unpinned === 0 ? 0 : Math.max(0, 100 - pinned) / unpinned
  return shares.map(s => s ?? rest)
}

export function validatePins(pins: Pin[]): string | null {
  if (pins.some(pin => pin.days.length === 0)) return 'A group needs at least one day.'
  const seen = new Set<Weekday>()
  for (const pin of pins) {
    for (const day of pin.days) {
      if (seen.has(day)) return 'Each day can only be in one group.'
      seen.add(day)
    }
  }
  // Written so that NaN fails the check too.
  if (pins.some(pin => !(pin.percent >= 0 && pin.percent <= 100))) {
    return 'A share must be between 0 and 100%.'
  }
  if (pins.reduce((total, pin) => total + pin.percent, 0) > 100 + SUM_SLACK) {
    return 'Pinned shares add up to more than 100%.'
  }
  return null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isWeekday(v: unknown): v is Weekday {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6
}

function readPins(v: unknown): Pin[] {
  if (!Array.isArray(v)) return []
  const pins: Pin[] = []
  for (const item of v) {
    if (!isRecord(item) || !Array.isArray(item.days) || !item.days.every(isWeekday)) return []
    if (typeof item.percent !== 'number') return []
    pins.push({ days: [...item.days], percent: item.percent })
  }
  return validatePins(pins) === null ? pins : []
}

function readFraction(v: unknown): number {
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : DEFAULT_CONFIG.headsUpFraction
}

function readSnoozeOptions(v: unknown): number[] {
  const ok = Array.isArray(v) && v.every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
  return ok ? [...v] : [...DEFAULT_CONFIG.snoozeOptionsMin]
}

function readBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function readOneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find(a => a === v) ?? fallback
}

// Whatever came out of the store (or an older version of this plugin) becomes a
// usable Config: a field that is missing or wrong falls back to its default.
export function normalizeConfig(raw: unknown): Config {
  const r = isRecord(raw) ? raw : {}
  return {
    version: 1,
    pins: readPins(r.pins),
    mode: readOneOf(r.mode, MODES, DEFAULT_CONFIG.mode),
    headsUpEnabled: readBool(r.headsUpEnabled, DEFAULT_CONFIG.headsUpEnabled),
    headsUpFraction: readFraction(r.headsUpFraction),
    statusStyle: readOneOf(r.statusStyle, STYLES, DEFAULT_CONFIG.statusStyle),
    snoozeOptionsMin: readSnoozeOptions(r.snoozeOptionsMin),
    showCompactPanel: readBool(r.showCompactPanel, DEFAULT_CONFIG.showCompactPanel),
  }
}
