import type { Reading } from './plan'
import type { Tz } from './tz'

// A fresh weekly figure without waiting for a reply: Claude Code's own /usage, run in
// print mode. It makes no model request; it is not kept as a session, and starts no
// MCP server. It reads text written for people, so a wording that changes only means
// no figure: the plugin goes back to waiting for replies.
export const PROBE_ARGV: readonly string[] = [
  'claude',
  '-p',
  '--no-session-persistence',
  '--strict-mcp-config',
  '/usage',
]

// Set in the probe's own environment: the Claude Code it starts loads this plugin
// too, which must not probe in turn.
export const PROBE_ENV = 'WEEKLY_BUDGET_PROBE'

const MIN_MS = 60_000
const EVERY_MS = 10 * MIN_MS // on its own: a start, a stale reading
const ASKED_EVERY_MS = 30_000 // when /budget asks for it

const WEEK_LINE = /^Current week \(all models\):\s*(\d+(?:\.\d+)?)%\s*used/m

// "Current week (all models): 48% used · resets …" → 48.
export function parseUsageWeek(text: string): number | null {
  const digits = WEEK_LINE.exec(text)?.[1]
  if (digits === undefined) return null
  const percent = Number(digits)
  return percent >= 0 && percent <= 100 ? percent : null
}

// The probe's figure on the week a reading already knows, as of now. Its reset time is
// too vague to place a week by ("7:59pm", then "8pm"), so with no known week, or one
// that is over, it gives nothing. It counts whole percents: a known 47.3 stays.
export function probedReading(known: Reading | null, percent: number, now: number): Reading | null {
  if (known === null || known.resetsMs <= now) return null
  return { percentUsed: Math.max(known.percentUsed, percent), resetsMs: known.resetsMs, at: now }
}

// Whether to probe now, after the last one (in any session) at lastAt.
export function shouldProbe(lastAt: number | null, now: number, isAsked: boolean): boolean {
  return lastAt === null || now - lastAt >= (isAsked ? ASKED_EVERY_MS : EVERY_MS)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const RESET = /^Current week \(all models\):.*?resets\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/im
const MATCH_MIN = 90

// The local wall time of an instant, as minutes, comparable with a parsed one.
function wallMinutes(ms: number, tz: Tz): number {
  return Date.parse(`${tz.dayKey(ms)}T${tz.hhmm(ms)}:00Z`) / 60_000
}

// Which known week /usage is about: the one whose reset, in local time, is within an
// hour and a half of the reset it names ("resets Nov 10, 8pm", "7:59pm", "12:00 PM").
// /usage runs with the terminal's login, which may be another account than the chat's;
// none known, or no reset to read, gives none.
export function matchWeek(text: string, weekKeys: readonly number[], tz: Tz): number | null {
  const m = RESET.exec(text)
  if (m === null) return null
  const month = MONTHS.indexOf((m[1] ?? '').toLowerCase())
  if (month === -1) return null
  const day = Number(m[2])
  const hour12 = Number(m[3]) % 12
  const hour = (m[5] ?? '').toLowerCase() === 'pm' ? hour12 + 12 : hour12
  const minute = Number(m[4] ?? 0)
  const best = weekKeys
    .map(key => {
      const year = Number(tz.dayKey(key).slice(0, 4))
      const named = Date.UTC(year, month, day, hour, minute) / 60_000
      return { key, off: Math.abs(named - wallMinutes(key, tz)) }
    })
    .filter(w => w.off <= MATCH_MIN)
    .sort((a, b) => a.off - b.off)[0]
  return best?.key ?? null
}
