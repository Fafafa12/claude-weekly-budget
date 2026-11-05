import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, SessionRateLimit } from 'claude-code'

import { DEFAULT_CONFIG } from './lib/config'
import type { Config } from './lib/config'
import { statusLine } from './lib/format'
import { computeBudget, readingFrom } from './lib/plan'
import type { Budget } from './lib/plan'
import {
  loadConfig,
  loadLedger,
  loadSharedReading,
  loadSnooze,
  pickReading,
  saveLedger,
  saveSharedReading,
  saveSnooze,
} from './lib/store'
import { fixedOffsetTz, systemTz } from './lib/tz'
import type { Tz } from './lib/tz'
import { gatePrompt, measureToast, parseSnooze, toastText } from './lib/warnings'
import type { Gate, Toast } from './lib/warnings'

// This session's view of the plugin's state, for the panes to draw from. The
// store is the truth, shared by every session; `refresh` copies it here.
export const readingAtom = atom({ plugin: 'weekly-budget', key: 'reading' } as const, null)
export const configAtom = atom({ plugin: 'weekly-budget', key: 'config' } as const, DEFAULT_CONFIG)
export const snoozedUntilAtom = atom({ plugin: 'weekly-budget', key: 'snoozedUntil' } as const, null)
export const settingsErrorAtom = atom({ plugin: 'weekly-budget', key: 'settingsError' } as const, null)
export const pinDraftDaysAtom = atom({ plugin: 'weekly-budget', key: 'pinDraftDays' } as const, 'weekend')

const USAGE = 'Usage: /budget, /budget snooze 30m|1h|today|off'

// The local zone: the machine's, unless the environment pins a fixed offset in
// minutes (WEEKLY_BUDGET_TZ_OFFSET_MIN=180 for UTC+3). The engine ignores TZ=, so
// that is also how a test fixes the day.
export async function resolveTz($: EngineInterface): Promise<Tz> {
  const raw = (await $.env.get('WEEKLY_BUDGET_TZ_OFFSET_MIN'))?.trim()
  return raw !== undefined && /^[+-]?\d+$/.test(raw) ? fixedOffsetTz(Number(raw)) : systemTz
}

// The store read into everything a decision or a display needs, at one `now`.
async function loadView($: EngineInterface) {
  const [now, tz, cfg, snoozedUntil, own, shared] = await Promise.all([
    $.clock.now(),
    resolveTz($),
    loadConfig($),
    loadSnooze($),
    read($, readingAtom),
    loadSharedReading($),
  ])
  const { reading, staleSince } = pickReading(own, shared, now)
  const budget = reading === null ? null : computeBudget(reading, cfg, now, tz)
  return { now, tz, cfg, snoozedUntil, reading, staleSince, budget }
}

// Where the budget stands, on the later of this session's reading and the one
// any session shared: a new chat has no reading of its own yet.
export async function currentBudget(
  $: EngineInterface,
): Promise<{ budget: Budget | null; staleSince: number | null; cfg: Config; snoozedUntil: number | null }> {
  const { budget, staleSince, cfg, snoozedUntil } = await loadView($)
  return { budget, staleSince, cfg, snoozedUntil }
}

// Atoms are written only on a change, because each write redraws whatever reads it.
const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

// Brings this session's atoms, the status line and the drawn panes up to the store.
export async function refresh($: EngineInterface): Promise<void> {
  const { now, tz, cfg, snoozedUntil, reading, staleSince, budget } = await loadView($)
  if (differs(await read($, readingAtom), reading)) await update($, readingAtom, () => reading)
  if (differs(await read($, configAtom), cfg)) await update($, configAtom, () => cfg)
  if (differs(await read($, snoozedUntilAtom), snoozedUntil)) await update($, snoozedUntilAtom, () => snoozedUntil)

  // The status line is the terminal's; the other surfaces have no such place.
  const hasTerminal = (await $.session.surfaces()).includes('terminal')
  await $.ui.status(hasTerminal ? statusLine(budget, cfg.statusStyle, staleSince, tz, now) : undefined)
  $.ui.invalidate('ui.render')
}

// A new reading: keep it, share it, toast if it calls for one, and redraw.
export async function onMeasure($: EngineInterface, rateLimits: readonly SessionRateLimit[]): Promise<void> {
  const now = await $.clock.now()
  const fresh = readingFrom(rateLimits, now)
  if (fresh !== null) {
    await update($, readingAtom, () => fresh)
    await saveSharedReading($, fresh)

    const [cfg, ledger, snoozedUntil, tz] = await Promise.all([
      loadConfig($),
      loadLedger($),
      loadSnooze($),
      resolveTz($),
    ])
    const budget = computeBudget(fresh, cfg, now, tz)
    const decided = measureToast(budget, cfg, ledger, snoozedUntil, now, tz)
    // The same ledger back means nothing changed; otherwise keep it, even with no
    // toast, because a new week resets it.
    if (decided.ledger !== ledger) await saveLedger($, decided.ledger)
    if (decided.toast !== null) await $.ui.toast(toastText(decided.toast, budget))
  }
  await refresh($)
}

// What to do with a prompt about to be sent. It decides on the shared reading, so
// the first message of a new chat is held back too.
export async function onPrompt($: EngineInterface, e: PromptSubmitInput): Promise<Gate> {
  const isExempt = e.isMeta === true || (e.command?.name ?? '').startsWith('budget')
  const { now, cfg, snoozedUntil, budget } = await loadView($)
  return gatePrompt(budget, cfg, snoozedUntil, now, isExempt)
}

// The toast a re-warn gate asks for, worded for where the budget stands now.
export async function showToast($: EngineInterface, toast: Toast): Promise<void> {
  const { budget } = await currentBudget($)
  if (budget !== null) await $.ui.toast(toastText(toast, budget))
}

// /budget opens the details; /budget snooze <span> silences warnings and lets
// messages through. The reply is what the command prints.
export async function runBudgetCommand($: EngineInterface, args: string): Promise<string> {
  const text = args.trim().toLowerCase()
  if (text === '') {
    await $.ui.open({ id: 'details', title: 'Weekly budget' })
    return 'Budget details opened.'
  }
  if (text === 'snooze' || text.startsWith('snooze ')) {
    const [now, tz] = await Promise.all([$.clock.now(), resolveTz($)])
    const snooze = parseSnooze(text.slice('snooze'.length), now, tz)
    if ('error' in snooze) return snooze.error
    await saveSnooze($, snooze.until)
    await refresh($)
    return snooze.until === null ? 'Warnings resumed.' : `Snoozed until ${tz.hhmm(snooze.until)}.`
  }
  return USAGE
}
