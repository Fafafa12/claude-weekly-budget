import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, SessionRateLimit, UsageUnit } from 'claude-code'

import { validatePins } from './lib/config'
import type { Config } from './lib/config'
import { paneTitle, staleMark, statusLine } from './lib/format'
import { computeBudget, readingFrom } from './lib/plan'
import type { Budget, Reading } from './lib/plan'
import {
  loadConfig,
  loadConfigVersion,
  loadLedger,
  loadSharedReading,
  loadSnooze,
  pickReading,
  saveConfig,
  saveLedger,
  saveSharedReading,
  saveSnooze,
  STALE_MS,
} from './lib/store'
import { fixedOffsetTz, systemTz } from './lib/tz'
import type { Tz } from './lib/tz'
import { dependsOnSurface, gatePrompt, isGated, measureToast, parseSnooze, toastText } from './lib/warnings'
import type { Gate, Toast } from './lib/warnings'

// This session's own state. The store is the truth shared by every session, and
// the panes draw from it; what is kept here is only this session's: the reading it
// measured itself (never one another session shared), and the settings pane's and
// the compact pane's own state.
export const readingAtom = atom({ plugin: 'weekly-budget', key: 'reading' } as const, null)
export const settingsErrorAtom = atom({ plugin: 'weekly-budget', key: 'settingsError' } as const, null)
export const pinDraftDaysAtom = atom({ plugin: 'weekly-budget', key: 'pinDraftDays' } as const, 'weekend')
export const compactOpenedAtom = atom({ plugin: 'weekly-budget', key: 'compactOpened' } as const, false)

const COMPACT = 'compact'
// Titled with the summary, marked "as of" when the reading is last known.
const compactPane = (v: { budget: Budget | null; staleSince: number | null; tz: Tz; now: number }) => ({
  id: COMPACT,
  title: paneTitle(v.budget, v.staleSince, v.tz, v.now),
  rows: 2,
})

const USAGE = 'Usage: /budget, /budget snooze 30m|1h|today|off'
const NEWER_CONFIG = 'These settings were saved by a newer version of weekly-budget. Update the plugin to change them.'

// UTC-14 to UTC+14 takes in every zone there is.
const MAX_OFFSET_MIN = 14 * 60

// The local zone: the machine's, unless the environment pins a fixed offset in
// whole minutes east of UTC, from -840 to 840 (WEEKLY_BUDGET_TZ_OFFSET_MIN=180 for
// UTC+3); anything else there is ignored. The engine ignores TZ=, so that is also
// how a test fixes the day.
export async function resolveTz($: EngineInterface): Promise<Tz> {
  const raw = (await $.env.get('WEEKLY_BUDGET_TZ_OFFSET_MIN'))?.trim()
  const offset = raw !== undefined && /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN
  return Math.abs(offset) <= MAX_OFFSET_MIN ? fixedOffsetTz(offset) : systemTz
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

// Where the budget stands, on the better of this session's own reading and the one
// any session shared (pickReading): a new chat has no reading of its own yet. With the zone and
// the time it was worked out for, which say when a last-known reading is from.
export async function currentBudget($: EngineInterface): Promise<{
  budget: Budget | null
  staleSince: number | null
  cfg: Config
  snoozedUntil: number | null
  tz: Tz
  now: number
}> {
  const { budget, staleSince, cfg, snoozedUntil, tz, now } = await loadView($)
  return { budget, staleSince, cfg, snoozedUntil, tz, now }
}

// Brings the status line and the drawn panes up to the store.
export async function refresh($: EngineInterface): Promise<void> {
  const view = await loadView($)
  const { now, tz, cfg, staleSince, budget } = view
  // The status line is the terminal's; the other surfaces have no such place.
  const hasTerminal = (await $.session.surfaces()).includes('terminal')
  await $.ui.status(hasTerminal ? statusLine(budget, cfg.statusStyle, staleSince, tz, now) : undefined)
  await syncCompact($, view)
  $.ui.invalidate('ui.render')
}

// The compact pane above the VS Code chat: the summary is its title, and the host
// draws that, so a changed title is a new open (which retitles). The panes the
// engine lists are the ones still up: one the person closed is not there, and
// stays closed. One the config now switches off is closed.
async function syncCompact(
  $: EngineInterface,
  view: { cfg: Config; budget: Budget | null; staleSince: number | null; tz: Tz; now: number },
): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === COMPACT)
  if (pane === undefined) return
  const wanted = compactPane(view)
  if (!view.cfg.showCompactPanel) await $.ui.close({ id: COMPACT })
  else if (pane.title !== wanted.title) await $.ui.open(wanted)
}

// Opens the compact pane the first time a session has somewhere to draw it: any
// surface but the terminal, which has the status line. Once a session has opened
// it, it never does again, so a pane the person closed stays closed.
export async function ensureCompact($: EngineInterface): Promise<void> {
  if (await read($, compactOpenedAtom)) return
  if (!(await $.session.surfaces()).some(s => s !== 'terminal')) return
  const view = await loadView($)
  if (!view.cfg.showCompactPanel) return
  await $.ui.open(compactPane(view))
  await update($, compactOpenedAtom, () => true)
}

// For a refresh nobody awaits (the session start, the minute tick): a failing
// store or a reload mid-refresh must not surface as an unhandled rejection, and
// the next tick tries again.
export async function refreshQuietly($: EngineInterface): Promise<void> {
  await refresh($).catch(() => {})
}

// A snooze set from a pane (null ends it): kept in the store for every session,
// then shown by the status line and the other panes.
export async function applySnooze($: EngineInterface, until: number | null): Promise<void> {
  await saveSnooze($, until)
  await refreshQuietly($)
}

// Atoms are written only on a change, because each write redraws whatever reads it.
const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b)

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

// A config set from the settings pane: kept in the store for every session, then
// shown by the status line and the panes. A config that fails its checks changes
// nothing but the error the pane shows, which is returned. So does any change over
// a config a newer version of the plugin saved: this one would lose what it added.
export async function applyConfig($: EngineInterface, next: Config): Promise<string | null> {
  const storedVersion = await loadConfigVersion($)
  const error = storedVersion !== null && storedVersion > 1 ? NEWER_CONFIG : validatePins(next.pins)
  if (error !== null) {
    await setSettingsError($, error)
    return error
  }

  await saveConfig($, next)
  await setSettingsError($, null)
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

// The reading a measure brings. Its rate limits are the last response's: a measure
// raised because only the context moved (no response came, so neither the limits
// nor the cost did) may carry figures from long ago. When they are those of this
// session's own last reading, that reading is kept with its time, not re-dated.
function measuredReading(own: Reading | null, measured: Reading, changed: readonly UsageUnit[]): Reading {
  const isRepeat =
    own !== null &&
    !changed.includes('rateLimits') &&
    !changed.includes('cost') &&
    own.percentUsed === measured.percentUsed &&
    own.resetsMs === measured.resetsMs
  return isRepeat ? own : measured
}

// A measure: keep a new reading, share it, toast if a fresh one calls for it, and
// redraw. One from a window that is over is no reading: it says nothing of the week
// now running, so it is not kept, shared, toasted on or let reset the ledger.
export async function onMeasure(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  changed: readonly UsageUnit[],
): Promise<void> {
  const now = await $.clock.now()
  const measured = readingFrom(rateLimits, now)
  if (measured !== null && measured.resetsMs > now) {
    const own = await read($, readingAtom)
    const reading = measuredReading(own, measured, changed)
    if (reading !== own) {
      await update($, readingAtom, () => reading)
      await saveSharedReading($, reading, now)
    }

    // The heads-up and the over toast go by a fresh reading only.
    if (now - reading.at <= STALE_MS) {
      const [cfg, ledger, snoozedUntil, tz] = await Promise.all([
        loadConfig($),
        loadLedger($),
        loadSnooze($),
        resolveTz($),
      ])
      const budget = computeBudget(reading, cfg, now, tz)
      const decided = measureToast(budget, cfg, ledger, snoozedUntil, now, tz)
      // The same ledger back means nothing changed; otherwise keep it, even with no
      // toast, because a new week resets it.
      if (decided.ledger !== ledger) await saveLedger($, decided.ledger)
      if (decided.toast !== null) await $.ui.toast(toastText(decided.toast, budget))
    }
  }
  await refresh($)
}

// What to do with a prompt about to be sent. Whether it is one to gate at all is
// decided first, so the prompts that pass untouched cost no store reads; only the
// kinds a script may be behind ask where the session draws. It decides on the
// shared reading, so the first message of a new chat is held back too.
export async function onPrompt($: EngineInterface, e: PromptSubmitInput): Promise<Gate> {
  const hasSurface = dependsOnSurface(e) && (await $.session.surfaces()).length > 0
  if (!isGated(e, hasSurface)) return null
  const { now, tz, cfg, snoozedUntil, budget, staleSince } = await loadView($)
  return gatePrompt(budget, cfg, snoozedUntil, now, staleMark(staleSince, tz, now))
}

// The toast a re-warn gate asks for, worded for where the budget stands now, and
// marked "as of" when that is a last-known reading.
export async function showToast($: EngineInterface, toast: Toast): Promise<void> {
  const { budget, staleSince, tz, now } = await currentBudget($)
  if (budget !== null) await $.ui.toast(toastText(toast, budget, staleMark(staleSince, tz, now)))
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
