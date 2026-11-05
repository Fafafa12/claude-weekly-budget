import type { PromptOrigin, PromptSubmitInput } from 'claude-code'

import type { Config } from './config'
import { pct } from './format'
import type { Budget } from './plan'
import type { Tz } from './tz'

const MIN_MS = 60e3
const HOUR_MS = 60 * MIN_MS

export type Toast = 'headsUp' | 'over'

// Which local day each warning last fired on, for the week that resets at
// weekKey. A new week starts a fresh one.
export type Ledger = { weekKey: number; headsUpDay: string | null; overDay: string | null }

const isSnoozed = (snoozedUntil: number | null, now: number): boolean =>
  snoozedUntil !== null && snoozedUntil > now

// Whether to toast on this reading, and the ledger to keep. A warning fires at
// most once per local day, a snooze silences both, and being over (or at the
// limit) leaves no room for a heads-up. The ledger comes back even without a
// toast, because a new week may have reset it.
export function measureToast(
  b: Budget,
  cfg: Config,
  ledger: Ledger | null,
  snoozedUntil: number | null,
  now: number,
  tz: Tz,
): { toast: Toast | null; ledger: Ledger } {
  const current: Ledger =
    ledger === null || ledger.weekKey !== b.resetMs
      ? { weekKey: b.resetMs, headsUpDay: null, overDay: null }
      : ledger
  if (isSnoozed(snoozedUntil, now) || b.state === 'limit') return { toast: null, ledger: current }

  const today = tz.dayKey(now)
  if (b.state === 'over' && current.overDay !== today) {
    return { toast: 'over', ledger: { ...current, overDay: today } }
  }
  if (
    b.state === 'near' &&
    cfg.headsUpEnabled &&
    current.headsUpDay !== today &&
    current.overDay !== today
  ) {
    return { toast: 'headsUp', ledger: { ...current, headsUpDay: today } }
  }
  return { toast: null, ledger: current }
}

// The origins a person can be behind. How the VS Code panel stamps what is typed
// there is not documented, so sdk and unclassified count too: block must hold there.
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk', 'slack-ping', 'unclassified']

// Whether block and re-warn apply to a prompt: only to the person's own next
// message, sent while nothing runs. A meta prompt, a /budget command, a prompt
// delivered into a running turn (turnId), and one nobody typed (a notification, a
// schedule, another session, a plugin, any kind added later) pass untouched: such
// a prompt has no box to go back to, and a dropped one is lost.
export function isGated(e: Pick<PromptSubmitInput, 'isMeta' | 'command' | 'turnId'> & { origin?: PromptOrigin }): boolean {
  if (e.isMeta === true || (e.command?.name ?? '').startsWith('budget')) return false
  if (e.turnId !== undefined) return false
  return e.origin === undefined || PERSON_ORIGINS.includes(e.origin.kind)
}

// What to do with a prompt about to be sent: drop it with a reason, show the
// over toast again, or let it through. At the limit Claude stops on its own, so
// only 'over' is held back.
export type Gate = { drop: string } | { toast: 'over' } | null

export function gatePrompt(b: Budget | null, cfg: Config, snoozedUntil: number | null, now: number): Gate {
  if (b === null || isSnoozed(snoozedUntil, now) || b.state !== 'over') return null
  switch (cfg.mode) {
    case 'block':
      return { drop: blockReason(b) }
    case 'rewarn':
      return { toast: 'over' }
    case 'warn':
      return null
  }
}

export function toastText(t: Toast, b: Budget): string {
  switch (t) {
    case 'headsUp':
      return `Heads-up: ${pct(b.left)}% of today's budget left (${pct(b.used)}% of ${pct(b.allowed)}% used).`
    case 'over':
      return `Over today's budget: ${pct(b.used)}% used, ${pct(b.allowed)}% allowed by tonight. Snooze with /budget snooze 1h.`
  }
}

export function blockReason(b: Budget): string {
  return `Over today's budget (${pct(b.used)}% of ${pct(b.allowed)}% allowed by tonight). To continue: /budget snooze 1h`
}

// The argument of /budget snooze: 30m, 2h, today (until local midnight) or off.
export function parseSnooze(arg: string, now: number, tz: Tz): { until: number | null } | { error: string } {
  const span = /^\s*(\d+)\s*(m|h)\s*$/.exec(arg)
  if (span) return { until: now + Number(span[1]) * (span[2] === 'm' ? MIN_MS : HOUR_MS) }
  switch (arg.trim()) {
    case 'today':
      return { until: tz.midnightAfter(now) }
    case 'off':
      return { until: null }
    default:
      return { error: 'Use /budget snooze 30m, 1h, today or off.' }
  }
}
