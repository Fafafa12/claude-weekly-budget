import { expect, test } from 'claude-code/testing'

import { PROBE_ARGV, parseUsageWeek, probedReading, shouldProbe } from '../hooks/lib/probe'

// What `claude -p "/usage"` printed on 2026-11-06 (trimmed).
const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 30% used · resets Nov 6, 2:39pm (Indian/Antananarivo)
Current week (all models): 48% used · resets Nov 10, 8pm (Indian/Antananarivo)

What's contributing to your usage?`

const reset = Date.parse('2026-11-10T17:00:00Z')
const now = Date.parse('2026-11-06T08:00:00Z')
const MIN = 60_000

test('the probe runs /usage in print mode, unsaved and with no MCP servers', async () => {
  expect(PROBE_ARGV).toEqual(['claude', '-p', '--no-session-persistence', '--strict-mcp-config', '/usage'])
})

test("parseUsageWeek reads the week's figure for all models", async () => {
  expect(parseUsageWeek(USAGE)).toBe(48)
  expect(parseUsageWeek('Current week (all models): 47.5% used · resets Nov 10')).toBe(47.5)
  // The session's figure and a per-model week are not the one.
  expect(parseUsageWeek('Current session: 30% used\nCurrent week (Sonnet only): 12% used')).toBeNull()
  expect(parseUsageWeek('')).toBeNull()
  expect(parseUsageWeek('Current week (all models): 140% used')).toBeNull()
})

// The probe's reset time is too vague to place a week by, so it only moves the figure
// of a week a reading already knows.
test('probedReading updates a known week, now', async () => {
  const base = { percentUsed: 45, resetsMs: reset, at: now - 60 * MIN }
  expect(probedReading(base, 48, now)).toEqual({ percentUsed: 48, resetsMs: reset, at: now })
  // Whole percents only: a known 47.3 is not taken down to 47, but is now fresh.
  expect(probedReading({ ...base, percentUsed: 47.3 }, 47, now)).toEqual({ percentUsed: 47.3, resetsMs: reset, at: now })
  expect(probedReading(null, 48, now)).toBeNull()
  expect(probedReading({ ...base, resetsMs: now - MIN }, 48, now)).toBeNull()
})

test('shouldProbe: at most every 10 minutes, or every 30 seconds when asked for', async () => {
  expect(shouldProbe(null, now, false)).toBe(true)
  expect(shouldProbe(now - 5 * MIN, now, false)).toBe(false)
  expect(shouldProbe(now - 10 * MIN, now, false)).toBe(true)
  expect(shouldProbe(now - 20_000, now, true)).toBe(false)
  expect(shouldProbe(now - 30_000, now, true)).toBe(true)
})
