import type { EngineInterface } from 'claude-code'

import { normalizeConfig } from './config'
import type { Config } from './config'
import type { DayStart, Reading } from './plan'
import type { Ledger } from './warnings'

// The store is shared by every session, and anything in it may be missing or
// written by another version of this plugin. A value that is not the shape
// expected counts as absent.
//
// `$` is only ever passed to these top-level functions, as the validator requires.

// A reading older than this is shown as last known. The heads-up and over toasts a
// measure raises need a fresh reading; re-warn may toast on the shared reading
// however old, since a last-known "over" is a lower bound on being over.
export const STALE_MS = 15 * 60e3

const KEY = {
  config: 'config',
  snooze: 'snooze',
  ledger: 'ledger',
  reading: 'lastReading',
  dayStart: 'dayStart',
  probeAt: 'probeAt',
  weeks: 'weeks',
  surfaceWeeks: 'surfaceWeeks',
  configs: 'configs',
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

export async function loadConfig($: EngineInterface): Promise<Config> {
  return normalizeConfig(await $.store.get(KEY.config))
}

// The version the stored config says it is, before it is read as this version's:
// null when it says none.
export async function loadConfigVersion($: EngineInterface): Promise<number | null> {
  const v = await $.store.get(KEY.config)
  return isRecord(v) && isNum(v.version) ? v.version : null
}

export async function saveConfig($: EngineInterface, c: Config): Promise<void> {
  await $.store.set(KEY.config, c)
}

// The single config an older version kept, for every account: null when there is none.
export async function loadLegacyConfig($: EngineInterface): Promise<Config | null> {
  const v = await $.store.get(KEY.config)
  return isRecord(v) ? normalizeConfig(v) : null
}

// The settings of each account, by its weekly slot (accountSlot).
export async function loadConfigs($: EngineInterface): Promise<Record<string, Config>> {
  const v = await $.store.get(KEY.configs)
  if (!isRecord(v)) return {}
  return Object.fromEntries(Object.entries(v).filter(e => isRecord(e[1])).map(([slot, c]) => [slot, normalizeConfig(c)]))
}

// The version an account's stored settings say they are (or the single config's, for
// no account), before they are read as this version's: null when they say none.
export async function loadConfigVersionFor($: EngineInterface, slot: string | null): Promise<number | null> {
  const v = slot === null ? await $.store.get(KEY.config) : (await $.store.get(KEY.configs) as Record<string, unknown> | undefined)?.[slot]
  return isRecord(v) && isNum(v.version) ? v.version : null
}

export async function saveAccountConfig($: EngineInterface, slot: string, c: Config): Promise<void> {
  const v = await $.store.get(KEY.configs)
  await $.store.set(KEY.configs, { ...(isRecord(v) ? v : {}), [slot]: c })
}

export async function loadSnooze($: EngineInterface): Promise<number | null> {
  const v = await $.store.get(KEY.snooze)
  return isRecord(v) && isNum(v.until) ? v.until : null
}

export async function saveSnooze($: EngineInterface, until: number | null): Promise<void> {
  await $.store.set(KEY.snooze, { until })
}

// When the last /usage probe ran, in any session: so that chats don't each run one.
export async function loadProbeAt($: EngineInterface): Promise<number | null> {
  const v = await $.store.get(KEY.probeAt)
  return isRecord(v) && isNum(v.at) ? v.at : null
}

export async function saveProbeAt($: EngineInterface, at: number): Promise<void> {
  await $.store.set(KEY.probeAt, { at })
}

// Every account on this machine has its own weekly limit, and no session can tell
// which account another is signed in to, but each week resets at its own time. So
// the store keeps a record per week (an account's week), told apart by its reset time:
// the best reading of it, what today began with, and today's warnings.
export type WeekEntry = { reading: Reading; dayStart: DayStart | null; ledger: Ledger | null }

const readingOf = (v: unknown): Reading | null =>
  isRecord(v) && isNum(v.percentUsed) && isNum(v.resetsMs) && isNum(v.at)
    ? { percentUsed: v.percentUsed, resetsMs: v.resetsMs, at: v.at }
    : null

const dayStartOf = (v: unknown, weekKey: number): DayStart | null =>
  isRecord(v) && v.weekKey === weekKey && typeof v.dayKey === 'string' && isNum(v.percentUsed)
    ? { weekKey, dayKey: v.dayKey, percentUsed: v.percentUsed }
    : null

const ledgerOf = (v: unknown, weekKey: number): Ledger | null =>
  isRecord(v) && v.weekKey === weekKey && isStrOrNull(v.headsUpDay) && isStrOrNull(v.overDay)
    ? { weekKey, headsUpDay: v.headsUpDay, overDay: v.overDay }
    : null

// The weeks as stored, those that are not the shape expected left out. Before there
// were weeks there was one reading, one start of day and one record: those are read
// as the one week they were, until a week is written.
export async function loadWeeks($: EngineInterface): Promise<WeekEntry[]> {
  const stored = await $.store.get(KEY.weeks)
  if (Array.isArray(stored)) {
    return stored.flatMap(v => {
      const reading = isRecord(v) ? readingOf(v.reading) : null
      if (reading === null || !isRecord(v)) return []
      return [{ reading, dayStart: dayStartOf(v.dayStart, reading.resetsMs), ledger: ledgerOf(v.ledger, reading.resetsMs) }]
    })
  }
  const [reading, dayStart, ledger] = await Promise.all([
    $.store.get(KEY.reading),
    $.store.get(KEY.dayStart),
    $.store.get(KEY.ledger),
  ])
  const old = readingOf(reading)
  if (old === null) return []
  return [{ reading: old, dayStart: dayStartOf(dayStart, old.resetsMs), ledger: ledgerOf(ledger, old.resetsMs) }]
}

// Re-reads (other sessions write too), changes one week, drops the weeks that are
// over, and writes the rest.
async function changeWeek(
  $: EngineInterface,
  weekKey: number,
  now: number,
  change: (week: WeekEntry | undefined) => WeekEntry | undefined,
): Promise<void> {
  const weeks = await loadWeeks($)
  const changed = change(weeks.find(w => w.reading.resetsMs === weekKey))
  const others = weeks.filter(w => w.reading.resetsMs !== weekKey)
  const kept = (changed === undefined ? others : [...others, changed]).filter(w => w.reading.resetsMs > now)
  // In the order they were first seen.
  const order = (w: WeekEntry) => weeks.findIndex(o => o.reading.resetsMs === w.reading.resetsMs)
  kept.sort((a, b) => (order(a) === -1 ? 1 : order(b) === -1 ? -1 : order(a) - order(b)))
  await $.store.set(KEY.weeks, kept)
}

// Within one week the higher figure is the better bound (usage only goes up), then
// the later reading.
const isBetterInWeek = (r: Reading, than: Reading): boolean =>
  r.percentUsed !== than.percentUsed ? r.percentUsed > than.percentUsed : r.at > than.at

// Keeps a reading of a week still running, when it is the better bound in its week.
export async function saveWeekReading($: EngineInterface, r: Reading, now: number): Promise<void> {
  if (r.resetsMs <= now) return
  await changeWeek($, r.resetsMs, now, week => {
    if (week === undefined) return { reading: r, dayStart: null, ledger: null }
    return isBetterInWeek(r, week.reading) ? { ...week, reading: r } : week
  })
}

export async function saveWeekDayStart($: EngineInterface, d: DayStart, now = 0): Promise<void> {
  await changeWeek($, d.weekKey, now, week => (week === undefined ? undefined : { ...week, dayStart: d }))
}

export async function saveWeekLedger($: EngineInterface, l: Ledger, now = 0): Promise<void> {
  await changeWeek($, l.weekKey, now, week => (week === undefined ? undefined : { ...week, ledger: l }))
}

// The week each surface (terminal, VS Code, the desktop app) last had a reading of its
// own from: each may be signed in to its own account, and a new chat on it shows that
// week until its first reply says.
export async function loadSurfaceWeeks($: EngineInterface): Promise<Record<string, number>> {
  const v = await $.store.get(KEY.surfaceWeeks)
  if (!isRecord(v)) return {}
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => isNum(e[1])))
}

export async function saveSurfaceWeek($: EngineInterface, surface: string, weekKey: number): Promise<void> {
  const weeks = await loadSurfaceWeeks($)
  if (weeks[surface] !== weekKey) await $.store.set(KEY.surfaceWeeks, { ...weeks, [surface]: weekKey })
}

// Which week to show, of the weeks still running: the session's own (its replies say
// which), with the better of its own reading and the stored one; without one, the week
// its surface last saw; else the one read last.
export function pickWeek(
  own: Reading | null,
  weeks: readonly WeekEntry[],
  preferred: number | null,
  now: number,
): { entry: WeekEntry | null; reading: Reading | null; staleSince: number | null } {
  const live = weeks.filter(w => w.reading.resetsMs > now)
  let entry: WeekEntry | null
  let reading: Reading | null
  if (own !== null && own.resetsMs > now) {
    entry = live.find(w => w.reading.resetsMs === own.resetsMs) ?? null
    reading = entry === null || isBetterInWeek(own, entry.reading) ? own : entry.reading
  } else {
    entry =
      live.find(w => w.reading.resetsMs === preferred) ??
      live.reduce<WeekEntry | null>((last, w) => (last === null || w.reading.at > last.reading.at ? w : last), null)
    reading = entry?.reading ?? null
  }
  const staleSince = reading !== null && now - reading.at > STALE_MS ? reading.at : null
  return { entry, reading, staleSince }
}
