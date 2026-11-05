import type { EngineInterface, RenderElement, RenderInput, ThemeKey } from 'claude-code'

import { applySnooze, currentBudget, resolveTz } from '../controller'
import { DAY_NAMES } from '../lib/config'
import type { Config } from '../lib/config'
import { asOf, countdown, pct, todayText } from '../lib/format'
import type { BudgetState } from '../lib/plan'
import { NO_READING_TEXT, planLine, renderBar } from './shared'

const MIN_MS = 60_000

// Theme keys, so that the state follows Claude's theme on each surface.
const STATE_COLORS: Record<BudgetState, ThemeKey> = { ok: 'success', near: 'warning', over: 'error', limit: 'error' }
const MODE_NAMES: Record<Config['mode'], string> = { warn: 'warn', rewarn: 're-warn', block: 'block' }

// 15 -> "Snooze 15m", 60 -> "Snooze 1h", 90 -> "Snooze 1h 30m".
function snoozeLabel(minutes: number): string {
  if (minutes < 60) return `Snooze ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `Snooze ${hours}h` : `Snooze ${hours}h ${rest}m`
}

// How long to silence warnings for: minutes from now, the rest of the local day, or not at all.
type Span = number | 'today' | null

// Snoozes for the span, from now.
async function snoozeFor($: EngineInterface, span: Span): Promise<void> {
  const [now, tz] = await Promise.all([$.clock.now(), resolveTz($)])
  await applySnooze($, span === null ? null : span === 'today' ? tz.midnightAfter(now) : now + span * MIN_MS)
}

// The body of the details pane, which /budget opens: the numbers (marked last known
// when the reading is stale), when the week resets, the plan, the mode, and the
// snooze with its buttons. The plan, the mode
// and the snooze come from the config and the store, so they show with no reading too.
export async function renderDetails($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const { budget, staleSince, cfg, snoozedUntil, tz, now } = await currentBudget($)
  const isSnoozed = snoozedUntil !== null && snoozedUntil > now

  const reading =
    budget === null ? (
      <Text dimColor>{NO_READING_TEXT}</Text>
    ) : (
      <Box flexDirection="column" gap={1}>
        {renderBar($, e, budget, { staleSince, tz, now })}
        <Box flexDirection="column">
          {staleSince !== null && <Text dimColor>{`Last known, as of ${asOf(staleSince, tz, now)}`}</Text>}
          <Text>{`Used ${pct(budget.used)}%`}</Text>
          <Text>{`Allowed by tonight ${pct(budget.allowed)}%`}</Text>
          <Text color={STATE_COLORS[budget.state]}>{todayText(budget)}</Text>
        </Box>
        <Text color="claude">
          {`Resets ${DAY_NAMES[tz.weekday(budget.resetMs)]} ${tz.hhmm(budget.resetMs)} (in ${countdown(budget.resetMs - now)})`}
        </Text>
      </Box>
    )

  return (
    <Box flexDirection="column" gap={1}>
      {reading}
      <Box flexDirection="column">
        <Text>{planLine(cfg)}</Text>
        <Text>{`Mode: ${MODE_NAMES[cfg.mode]}`}</Text>
      </Box>
      <Box flexDirection="column">
        <Text>{isSnoozed ? `Warnings snoozed until ${tz.hhmm(snoozedUntil)}` : 'Warnings on'}</Text>
        <Box flexWrap="wrap" gap={1}>
          {cfg.snoozeOptionsMin.map(minutes => (
            <Button key={`snooze-${minutes}`} label={snoozeLabel(minutes)} onPress={() => snoozeFor($, minutes)} />
          ))}
          <Button key="snooze-today" label="Snooze today" onPress={() => snoozeFor($, 'today')} />
          {isSnoozed && <Button key="resume" label="Resume" onPress={() => snoozeFor($, null)} />}
        </Box>
      </Box>
    </Box>
  )
}
