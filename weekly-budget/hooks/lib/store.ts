import type { EngineInterface } from 'claude-code'

import { normalizeConfig } from './config'
import type { Config } from './config'
import type { Reading } from './plan'
import type { Ledger } from './warnings'

// The store is shared by every session, and anything in it may be missing or
// written by another version of this plugin. A value that is not the shape
// expected counts as absent.
//
// `$` is only ever passed to these top-level functions, as the validator requires.

// A reading older than this is shown as last known, and gets no toasts.
export const STALE_MS = 15 * 60e3

const KEY = {
  config: 'config',
  snooze: 'snooze',
  ledger: 'ledger',
  reading: 'lastReading',
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

export async function loadConfig($: EngineInterface): Promise<Config> {
  return normalizeConfig(await $.store.get(KEY.config))
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

export async function loadSharedReading($: EngineInterface): Promise<Reading | null> {
  const v = await $.store.get(KEY.reading)
  if (!isRecord(v) || !isNum(v.percentUsed) || !isNum(v.resetsMs) || !isNum(v.at)) return null
  return { percentUsed: v.percentUsed, resetsMs: v.resetsMs, at: v.at }
}

// Writes when nothing is stored, when this reading is for another window, or when
// it is newer than the stored one. Re-reads first because other sessions write too.
export async function saveSharedReading($: EngineInterface, r: Reading): Promise<void> {
  const stored = await loadSharedReading($)
  if (stored === null || stored.resetsMs !== r.resetsMs || r.at > stored.at) {
    await $.store.set(KEY.reading, r)
  }
}

// Which of this session's reading and the shared one to trust. A window that is
// over is no use; between two live readings, the later window wins, and within
// one window the later reading (usage only goes up, so it is the better bound).
export function pickReading(
  session: Reading | null,
  shared: Reading | null,
  now: number,
): { reading: Reading | null; staleSince: number | null } {
  const live = [session, shared].filter((r): r is Reading => r !== null && r.resetsMs > now)
  const reading = live.reduce<Reading | null>((best, r) => {
    if (best === null) return r
    if (r.resetsMs !== best.resetsMs) return r.resetsMs > best.resetsMs ? r : best
    return r.at > best.at ? r : best
  }, null)
  const staleSince = reading !== null && now - reading.at > STALE_MS ? reading.at : null
  return { reading, staleSince }
}
