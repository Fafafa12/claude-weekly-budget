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

export async function loadSnooze($: EngineInterface): Promise<number | null> {
  const v = await $.store.get(KEY.snooze)
  return isRecord(v) && isNum(v.until) ? v.until : null
}

export async function saveSnooze($: EngineInterface, until: number | null): Promise<void> {
  await $.store.set(KEY.snooze, { until })
}

export async function loadLedger($: EngineInterface): Promise<Ledger | null> {
  const v = await $.store.get(KEY.ledger)
  if (!isRecord(v) || !isNum(v.weekKey)) return null
  if (!isStrOrNull(v.headsUpDay) || !isStrOrNull(v.overDay)) return null
  return { weekKey: v.weekKey, headsUpDay: v.headsUpDay, overDay: v.overDay }
}

export async function saveLedger($: EngineInterface, l: Ledger): Promise<void> {
  await $.store.set(KEY.ledger, l)
}

// What today began with in this week (the adaptive leftover's starting point), shared
// by every session: the first to see a day records it.
export async function loadDayStart($: EngineInterface): Promise<DayStart | null> {
  const v = await $.store.get(KEY.dayStart)
  if (!isRecord(v) || !isNum(v.weekKey) || typeof v.dayKey !== 'string' || !isNum(v.percentUsed)) return null
  return { weekKey: v.weekKey, dayKey: v.dayKey, percentUsed: v.percentUsed }
}

export async function saveDayStart($: EngineInterface, d: DayStart): Promise<void> {
  await $.store.set(KEY.dayStart, d)
}

export async function loadSharedReading($: EngineInterface): Promise<Reading | null> {
  const v = await $.store.get(KEY.reading)
  if (!isRecord(v) || !isNum(v.percentUsed) || !isNum(v.resetsMs) || !isNum(v.at)) return null
  return { percentUsed: v.percentUsed, resetsMs: v.resetsMs, at: v.at }
}

// Whether r is a better bound than the other reading: the later window, and within
// one window the higher figure (usage only goes up), then the later reading.
function isBetter(r: Reading, than: Reading): boolean {
  if (r.resetsMs !== than.resetsMs) return r.resetsMs > than.resetsMs
  if (r.percentUsed !== than.percentUsed) return r.percentUsed > than.percentUsed
  return r.at > than.at
}

// Writes a reading whose window is still running when nothing is stored or when it
// is the better bound (isBetter). Re-reads first because other sessions write too.
export async function saveSharedReading($: EngineInterface, r: Reading, now: number): Promise<void> {
  if (r.resetsMs <= now) return
  const stored = await loadSharedReading($)
  if (stored === null || isBetter(r, stored)) await $.store.set(KEY.reading, r)
}

// Which of this session's reading and the shared one to trust: a window that is
// over is no use, and of two live readings the better bound (isBetter).
export function pickReading(
  session: Reading | null,
  shared: Reading | null,
  now: number,
): { reading: Reading | null; staleSince: number | null } {
  const live = [session, shared].filter((r): r is Reading => r !== null && r.resetsMs > now)
  const reading = live.reduce<Reading | null>((best, r) => (best === null || isBetter(r, best) ? r : best), null)
  const staleSince = reading !== null && now - reading.at > STALE_MS ? reading.at : null
  return { reading, staleSince }
}
