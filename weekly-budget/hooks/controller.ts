import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, SessionRateLimit, UsageUnit } from 'claude-code'

import { accountSlot, pickConfig, validatePins } from './lib/config'
import type { Config } from './lib/config'
import { budgetReply, staleMark, statusLine } from './lib/format'
import { computeBudget, nextDayStart, readingFrom, usageAtDayStart } from './lib/plan'
import { matchWeek, PROBE_ARGV, PROBE_ENV, parseUsageWeek, probedReading, shouldProbe } from './lib/probe'
import type { Budget, Reading } from './lib/plan'
import {
  STALE_MS,
  loadConfigVersionFor,
  loadConfigs,
  loadLegacyConfig,
  loadProbeAt,
  loadSnooze,
  loadSurfaceWeeks,
  loadWeeks,
  pickWeek,
  saveAccountConfig,
  saveConfig,
  saveProbeAt,
  saveSnooze,
  saveSurfaceWeek,
  saveWeekDayStart,
  saveWeekLedger,
  saveWeekReading,
} from './lib/store'
import { fixedOffsetTz, systemTz } from './lib/tz'
import type { Tz } from './lib/tz'
import { dependsOnSurface, gatePrompt, isGated, measureToast, parseSnooze, toastText } from './lib/warnings'
import type { Gate, Toast } from './lib/warnings'

// This session's own state. The store is the truth shared by every session, and
// the panes draw from it; what is kept here is only this session's: the reading it
// measured itself (never one another session shared), and the settings pane's and
// the panel's own state.
export const readingAtom = atom({ plugin: 'weekly-budget', key: 'reading' } as const, null)
export const settingsErrorAtom = atom({ plugin: 'weekly-budget', key: 'settingsError' } as const, null)
export const pinDraftDaysAtom = atom({ plugin: 'weekly-budget', key: 'pinDraftDays' } as const, 'weekend')
export const compactOpenedAtom = atom({ plugin: 'weekly-budget', key: 'compactOpened' } as const, false)
export const detailsExpandedAtom = atom({ plugin: 'weekly-budget', key: 'detailsExpanded' } as const, false)
export const compactRowsAtom = atom({ plugin: 'weekly-budget', key: 'compactRows' } as const, null)
export const stripHiddenAtom = atom({ plugin: 'weekly-budget', key: 'stripHidden' } as const, false)
export const interactiveAtom = atom({ plugin: 'weekly-budget', key: 'interactive' } as const, false)
export const surfaceAtom = atom({ plugin: 'weekly-budget', key: 'surface' } as const, null)

// VS Code's one panel. Its height is what it is asked for, in rows: the bar and the
// toggle row while the compact view is collapsed, the bar with the details otherwise.
// Counted from the layout (the bar is 2 rows, the toggle 1, the details about 12, and
// a gap between each, the details now with the leftover line); to be tuned by eye in VS Code.
const COMPACT = 'compact'
const COLLAPSED_ROWS = 4
const EXPANDED_ROWS = 18

// The host draws a pane's title in plain text, so the panel's only names it: the
// summary, coloured by the state, is the panel's own first line.
const COMPACT_TITLE = 'Weekly budget'

// The panel as an open request. The compact view (showCompactPanel) keeps its
// details behind the toggle; the full view always shows them.
const compactPane = (
  v: { cfg: Config; budget: Budget | null; staleSince: number | null; tz: Tz; now: number },
  isExpanded: boolean,
) => ({
  id: COMPACT,
  title: COMPACT_TITLE,
  rows: v.cfg.showCompactPanel && !isExpanded ? COLLAPSED_ROWS : EXPANDED_ROWS,
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
  const [now, tz, configs, legacy, snoozedUntil, own, weeks, surfaceWeeks, surface] = await Promise.all([
    $.clock.now(),
    resolveTz($),
    loadConfigs($),
    loadLegacyConfig($),
    loadSnooze($),
    read($, readingAtom),
    loadWeeks($),
    loadSurfaceWeeks($),
    read($, surfaceAtom),
  ])
  // This chat's account's week: its own replies say which; before the first, the one
  // its surface last saw, else the one read last (pickWeek). Its settings are that
  // account's (pickConfig).
  const surfaceWeek = surface === null ? null : (surfaceWeeks[surface] ?? null)
  const { entry, reading, staleSince } = pickWeek(own, weeks, surfaceWeek, now)
  const accountWeek = reading?.resetsMs ?? null
  const cfg = pickConfig(configs, legacy, accountWeek, surfaceWeek)
  const budget =
    reading === null
      ? null
      : computeBudget(reading, cfg, now, tz, usageAtDayStart(reading, entry?.dayStart ?? null, now, tz))
  return { now, tz, cfg, snoozedUntil, reading, staleSince, budget, accountWeek }
}

// The settings a chat shows and changes: its account's, and which account that is
// (the week it shows; null with no account seen yet).
export async function currentSettings($: EngineInterface): Promise<{ cfg: Config; accountWeek: number | null; tz: Tz }> {
  const { cfg, accountWeek, tz } = await loadView($)
  return { cfg, accountWeek, tz }
}

// Where the budget stands, on the better of this session's own reading and the one
// any session kept for its week (pickWeek): a new chat has no reading of its own yet. With the zone and
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

// The panel above the VS Code chat, re-opened only for a changed height (or a title
// that is not its own): the view may have been switched by another session, and the
// engine's pane list has no rows, which is why the rows last asked for are kept. A
// budget that moves only redraws it. The panes the engine lists
// are the ones still up: one the person closed is not there, and stays closed.
// Neither view closes it.
async function syncCompact(
  $: EngineInterface,
  view: { cfg: Config; budget: Budget | null; staleSince: number | null; tz: Tz; now: number },
): Promise<void> {
  const pane = (await $.ui.panes()).find(p => p.id === COMPACT)
  if (pane === undefined) return
  const wanted = compactPane(view, await read($, detailsExpandedAtom))
  const isRowsKept = (await read($, compactRowsAtom)) === wanted.rows
  if (pane.title !== wanted.title || !isRowsKept) await openPane($, wanted)
}

// Opens the panel as asked, and keeps the rows it was asked for.
async function openPane($: EngineInterface, pane: ReturnType<typeof compactPane>): Promise<void> {
  await $.ui.open(pane)
  if (differs(await read($, compactRowsAtom), pane.rows)) await update($, compactRowsAtom, () => pane.rows)
}

// The panel as the store, the view and the toggle have it now.
async function currentCompactPane($: EngineInterface) {
  const [view, isExpanded] = await Promise.all([loadView($), read($, detailsExpandedAtom)])
  return compactPane(view, isExpanded)
}

// Opens the panel, and notes that this session has.
async function openCompact($: EngineInterface, pane: ReturnType<typeof compactPane>): Promise<void> {
  await openPane($, pane)
  await update($, compactOpenedAtom, () => true)
}

// Opens the panel the first time a session has somewhere to draw it: any surface
// but the terminal, which has the status line. In either view. Once a session has
// opened it, it never does again, so a pane the person closed stays closed; only
// /budget brings it back.
// The surfaces that show the budget in the compact panel: those with no place of
// their own for it. The terminal has its status line, and the desktop app its strip
// above the message box (the AbovePrompt band, ui/strip.tsx).
const hasPanelSurface = (surfaces: readonly string[]): boolean =>
  surfaces.some(s => s !== 'terminal' && s !== 'desktop')

export async function ensureCompact($: EngineInterface): Promise<void> {
  if (await read($, compactOpenedAtom)) return
  if (!hasPanelSurface(await $.session.surfaces())) return
  await openCompact($, await currentCompactPane($))
}

// The Details toggle of the compact view: opens or closes the details under the bar.
// The panel, if it is still up (it may have been closed since the press), is asked
// again for the rows the new state needs, under the title it has.
export async function toggleDetails($: EngineInterface): Promise<void> {
  const isExpanded = await update($, detailsExpandedAtom, was => !was)
  if (!(await $.ui.panes()).some(p => p.id === COMPACT)) return
  await openPane($, compactPane(await loadView($), isExpanded))
}

// The desktop strip, closed with its ✕ for this chat (the session's state), and shown
// again by /budget.
export async function isStripHidden($: EngineInterface): Promise<boolean> {
  return read($, stripHiddenAtom)
}

export async function hideStrip($: EngineInterface): Promise<void> {
  await update($, stripHiddenAtom, () => true)
  $.ui.invalidate('ui.render')
}

export async function getDetailsExpanded($: EngineInterface): Promise<boolean> {
  return read($, detailsExpandedAtom)
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
  // Kept for the account the chat shows; with none seen yet, for every account.
  const { accountWeek } = await loadView($)
  const slot = accountWeek === null ? null : accountSlot(accountWeek)
  const storedVersion = await loadConfigVersionFor($, slot)
  const error = storedVersion !== null && storedVersion > 1 ? NEWER_CONFIG : validatePins(next.pins)
  if (error !== null) {
    await setSettingsError($, error)
    return error
  }

  if (slot === null) await saveConfig($, next)
  else await saveAccountConfig($, slot, next)
  await setSettingsError($, null)
  await refreshQuietly($)
  return null
}

// The panel's switch between its two views: compact (on) or full (off). It closes
// nothing and opens nothing the person closed; the refresh that follows the change
// asks a panel that is up again, for the rows of the view it is in now. What the
// toggle opened stays opened.
export async function applyCompactPanel($: EngineInterface, isCompact: boolean): Promise<void> {
  await applyConfig($, { ...(await loadView($)).cfg, showCompactPanel: isCompact })
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

// A new reading, kept in the record of its week (its account's): what today began with
// (the first fresh reading of a day records it, from the last one of the days before,
// as the week's record still has it), the reading itself, and today's warnings. One of
// this session's own (a reply's) also becomes its reading, and tells which week its
// surface is on. A toast is for the week this chat shows only.
async function acceptReading($: EngineInterface, reading: Reading, now: number, isOwn: boolean): Promise<void> {
  const tz = await resolveTz($)
  const week = (await loadWeeks($)).find(w => w.reading.resetsMs === reading.resetsMs)
  const storedDayStart = week?.dayStart ?? null
  const dayStart = nextDayStart(storedDayStart, week?.reading ?? null, reading, now, tz)
  await saveWeekReading($, reading, now)
  if (dayStart !== storedDayStart) await saveWeekDayStart($, dayStart, now)
  const [configs, legacy, surfaceWeeks, surface] = await Promise.all([
    loadConfigs($),
    loadLegacyConfig($),
    loadSurfaceWeeks($),
    read($, surfaceAtom),
  ])
  const surfaceWeek = surface === null ? null : (surfaceWeeks[surface] ?? null)
  const cfg = pickConfig(configs, legacy, reading.resetsMs, surfaceWeek)
  if (isOwn) {
    if (reading !== (await read($, readingAtom))) await update($, readingAtom, () => reading)
    // An account seen for the first time starts with the settings last used here.
    const slot = accountSlot(reading.resetsMs)
    if (configs[slot] === undefined) await saveAccountConfig($, slot, cfg)
    if (surface !== null) await saveSurfaceWeek($, surface, reading.resetsMs)
  }

  // The heads-up and the over toast go by a fresh reading only.
  if (now - reading.at > STALE_MS) return
  if (!isOwn && (await loadView($)).reading?.resetsMs !== reading.resetsMs) return
  const snoozedUntil = await loadSnooze($)
  const ledger = week?.ledger ?? null
  const budget = computeBudget(reading, cfg, now, tz, usageAtDayStart(reading, dayStart, now, tz))
  const decided = measureToast(budget, cfg, ledger, snoozedUntil, now, tz)
  // The same ledger back means nothing changed; otherwise keep it, even with no
  // toast, because a new week resets it.
  if (decided.ledger !== ledger) await saveWeekLedger($, decided.ledger, now)
  if (decided.toast !== null) await $.ui.toast(toastText(decided.toast, budget))
}

// A measure: a reading the last reply brought, then a redraw. One from a window that
// is over is no reading: it says nothing of the week now running, so it is not kept,
// shared, toasted on or let reset the ledger.
export async function onMeasure(
  $: EngineInterface,
  rateLimits: readonly SessionRateLimit[],
  changed: readonly UsageUnit[],
): Promise<void> {
  const now = await $.clock.now()
  const measured = readingFrom(rateLimits, now)
  if (measured !== null && measured.resetsMs > now) {
    await acceptReading($, measuredReading(await read($, readingAtom), measured, changed), now, true)
  }
  await refresh($)
}

// Whether a person drives this session (session.start says): only those probe.
export async function setInteractive($: EngineInterface, isInteractive: boolean): Promise<void> {
  if (differs(await read($, interactiveAtom), isInteractive)) await update($, interactiveAtom, () => isInteractive)
}

// The surface the session started on (terminal, VS Code, the desktop app), whose
// account its week is.
export async function setSurface($: EngineInterface, surface: string | null): Promise<void> {
  if (differs(await read($, surfaceAtom), surface)) await update($, surfaceAtom, () => surface)
}

// A fresh figure without waiting for a reply: Claude Code's own /usage, run in the
// background (lib/probe.ts), at most every 10 minutes across all chats on its own and
// every 30 seconds when /budget asks. Never in the Claude Code a probe starts, nor in
// a session no one drives; never without a week a reading already knows. Its figure
// is taken as this session's own reading.
export async function probeUsage($: EngineInterface, isAsked: boolean): Promise<void> {
  if ((await $.env.get('WEEKLY_BUDGET_PROBE')) !== undefined) return
  if (!(await read($, interactiveAtom))) return
  const [now, tz, weeks, lastAt] = await Promise.all([$.clock.now(), resolveTz($), loadWeeks($), loadProbeAt($)])
  const live = weeks.filter(w => w.reading.resetsMs > now)
  if (live.length === 0 || !shouldProbe(lastAt, now, isAsked)) return
  await saveProbeAt($, now)
  const ran = await $.process.run(PROBE_ARGV, { env: { [PROBE_ENV]: '1' }, timeoutMs: 20_000 })
  if (ran.exitCode !== 0) return
  // /usage runs with the terminal's login: its figure is for the week whose reset it
  // names, which may be another account's than this chat's.
  const percent = parseUsageWeek(ran.stdout)
  const weekKey = matchWeek(ran.stdout, live.map(w => w.reading.resetsMs), tz)
  const week = live.find(w => w.reading.resetsMs === weekKey)
  if (percent === null || week === undefined) return
  const probed = probedReading(week.reading, percent, await $.clock.now())
  if (probed === null) return
  await acceptReading($, probed, probed.at, false)
  await refresh($)
}

export async function probeUsageQuietly($: EngineInterface, isAsked: boolean): Promise<void> {
  await probeUsage($, isAsked).catch(() => {})
}

// The minute tick: bring the displays up to the store, and probe once what they show
// has gone stale.
export async function tick($: EngineInterface): Promise<void> {
  await refreshQuietly($)
  const { staleSince } = await loadView($)
  if (staleSince !== null) await probeUsageQuietly($, false)
}

export async function tickQuietly($: EngineInterface): Promise<void> {
  await tick($).catch(() => {})
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

// /budget opens the panel where there is one (any surface but the terminal), even
// after the person closed it, and the details pane in a terminal; /budget snooze
// <span> silences warnings and lets messages through. The reply is what the
// command prints.
// The details pane: where /budget answers in the terminal, and what the desktop
// strip's Details link opens (beside the conversation there).
export async function openDetails($: EngineInterface): Promise<void> {
  await $.ui.open({ id: 'details', title: 'Weekly budget' })
}

// The settings pane, for /budget-config and the desktop strip's ⚙. Focused, so that
// the terminal's keys reach the settings at once.
export async function openSettings($: EngineInterface): Promise<void> {
  await $.ui.open({ id: 'settings', title: 'Weekly budget settings', focus: true })
}

// What /budget shows, as each surface has it: VS Code's panel (opened even if it was
// closed), the desktop app's strip (brought back if it was hidden), the terminal's
// details pane. Says what it did, for a reply when the numbers can't be read.
async function showBudget($: EngineInterface): Promise<string> {
  const surfaces = await $.session.surfaces()
  if (hasPanelSurface(surfaces)) {
    // The panel is how /budget answers here, so a store that cannot be read still
    // opens it, plainly titled and collapsed.
    const plain = { id: COMPACT, title: COMPACT_TITLE, rows: COLLAPSED_ROWS }
    await openCompact($, await currentCompactPane($).catch(() => plain))
    return 'Budget panel opened.'
  }
  if (surfaces.includes('desktop')) {
    if (await read($, stripHiddenAtom)) {
      await update($, stripHiddenAtom, () => false)
      $.ui.invalidate('ui.render')
    }
    return 'Budget strip shown.'
  }
  await openDetails($)
  return 'Budget details opened.'
}

export async function runBudgetCommand($: EngineInterface, args: string): Promise<string> {
  const text = args.trim().toLowerCase()
  if (text === '') {
    const done = await showBudget($)
    // A fresh figure for the reply, without waiting for a reply of Claude's.
    await probeUsageQuietly($, true)
    try {
      const { budget, staleSince, tz, now } = await loadView($)
      return budgetReply(budget, staleSince, tz, now)
    } catch {
      return done
    }
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
