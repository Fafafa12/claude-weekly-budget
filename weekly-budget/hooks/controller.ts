import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, SessionRateLimit } from 'claude-code'

import { DEFAULT_CONFIG, validatePins } from './lib/config'
import type { Config } from './lib/config'
import { paneTitle, statusLine } from './lib/format'
import { computeBudget, readingFrom } from './lib/plan'
import type { Budget } from './lib/plan'
import {
  loadConfig,
  loadLedger,
  loadSharedReading,
  loadSnooze,
  pickReading,
  saveConfig,
  saveLedger,
  saveSharedReading,
  saveSnooze,
} from './lib/store'
import { fixedOffsetTz, systemTz } from './lib/tz'
import type { Tz } from './lib/tz'
import { gatePrompt, isGated, measureToast, parseSnooze, toastText } from './lib/warnings'
import type { Gate, Toast } from './lib/warnings'

// This session's view of the plugin's state, for the panes to draw from. The
// store is the truth, shared by every session; `refresh` copies it here.
export const readingAtom = atom({ plugin: 'weekly-budget', key: 'reading' } as const, null)
export const configAtom = atom({ plugin: 'weekly-budget', key: 'config' } as const, DEFAULT_CONFIG)
export const snoozedUntilAtom = atom({ plugin: 'weekly-budget', key: 'snoozedUntil' } as const, null)
export const settingsErrorAtom = atom({ plugin: 'weekly-budget', key: 'settingsError' } as const, null)
export const pinDraftDaysAtom = atom({ plugin: 'weekly-budget', key: 'pinDraftDays' } as const, 'weekend')
export const compactOpenedAtom = atom({ plugin: 'weekly-budget', key: 'compactOpened' } as const, false)

const COMPACT = 'compact'
const compactPane = (budget: Budget | null) => ({ id: COMPACT, title: paneTitle(budget), rows: 2 })

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
  await syncCompact($, cfg, budget)
  $.ui.invalidate('ui.render')
}

// The compact pane above the VS Code chat: the summary is its title, and the host
// draws that, so a changed title is a new open (which retitles). The panes the
// engine lists are the ones still up: one the person closed is not there, and
// stays closed. One the config now switches off is closed.
async function syncCompact($: EngineInterface, cfg: Config, budget: Budget | null): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === COMPACT)
  if (pane === undefined) return
  const wanted = compactPane(budget)
  if (!cfg.showCompactPanel) await $.ui.close({ id: COMPACT })
  else if (pane.title !== wanted.title) await $.ui.open(wanted)
}

// Opens the compact pane the first time a session has somewhere to draw it: any
// surface but the terminal, which has the status line. Once a session has opened
// it, it never does again, so a pane the person closed stays closed.
export async function ensureCompact($: EngineInterface): Promise<void> {
  if (await read($, compactOpenedAtom)) return
  if (!(await $.session.surfaces()).some(s => s !== 'terminal')) return
  const { budget, cfg } = await currentBudget($)
  if (!cfg.showCompactPanel) return
  await $.ui.open(compactPane(budget))
  await update($, compactOpenedAtom, () => true)
}

// For a refresh nobody awaits (the session start, the minute tick): a failing
// store or a reload mid-refresh must not surface as an unhandled rejection, and
// the next tick tries again.
export async function refreshQuietly($: EngineInterface): Promise<void> {
  await refresh($).catch(() => {})
}

// A snooze set from a pane (null ends it): kept in the store for every session,
// then in this session's atom, then shown by the status line and the other panes.
export async function applySnooze($: EngineInterface, until: number | null): Promise<void> {
  await saveSnooze($, until)
  await update($, snoozedUntilAtom, () => until)
  await refreshQuietly($)
}

// The settings pane's own state, read and written here with the atoms: the days the
// next pin is for, and what is wrong with the last change (null when nothing is).
export async function getPinDraftDays($: EngineInterface): Promise<string> {
  return read($, pinDraftDaysAtom)
}

export async function getSettingsError($: EngineInterface): Promise<string | null> {
  return read($, settingsErrorAtom)
}

export async function setPinDraftDays($: EngineInterface, days: string): Promise<void> {
  if (differs(await read($, pinDraftDaysAtom), days)) await update($, pinDraftDaysAtom, () => days)
}

export async function setSettingsError($: EngineInterface, message: string | null): Promise<void> {
  if (differs(await read($, settingsErrorAtom), message)) await update($, settingsErrorAtom, () => message)
}

// A config set from the settings pane: kept in the store for every session, then in
// this session's atom, then shown by the status line and the panes. A config that
// fails its checks changes nothing but the error the pane shows, which is returned.
export async function applyConfig($: EngineInterface, next: Config): Promise<string | null> {
  const error = validatePins(next.pins)
  if (error !== null) {
    await setSettingsError($, error)
    return error
  }

  await saveConfig($, next)
  await setSettingsError($, null)
  await update($, configAtom, () => next)
  await refreshQuietly($)
  return null
}

// The compact pane's switch: off closes the pane, on opens it again even if it was
// closed earlier this session, which is why that is forgotten first.
export async function applyCompactPanel($: EngineInterface, isOn: boolean): Promise<void> {
  // Closed before the refresh, so that it finds no pane left to close.
  if (!isOn) await $.ui.close({ id: COMPACT })
  const error = await applyConfig($, { ...(await loadConfig($)), showCompactPanel: isOn })
  if (!isOn || error !== null) return
  await update($, compactOpenedAtom, () => false)
  await ensureCompact($)
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

// What to do with a prompt about to be sent. Whether it is one to gate at all is
// decided first, so the prompts that pass untouched cost no store reads. It
// decides on the shared reading, so the first message of a new chat is held back too.
export async function onPrompt($: EngineInterface, e: PromptSubmitInput): Promise<Gate> {
  if (!isGated(e)) return null
  const { now, cfg, snoozedUntil, budget } = await loadView($)
  return gatePrompt(budget, cfg, snoozedUntil, now)
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
