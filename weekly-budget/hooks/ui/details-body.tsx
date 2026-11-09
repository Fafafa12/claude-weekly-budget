import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { applySnooze, resolveTz } from '../controller'
import type { currentBudget } from '../controller'
import { DAY_NAMES } from '../lib/config'
import type { PaceLine } from '../lib/forecast'
import { asOf, countdown, LEFTOVER_LABELS, MODE_LABELS, pct, todayText, weekBasisText } from '../lib/format'
import { planLine, STATE_COLORS } from './shared'

const MIN_MS = 60_000

// Where the budget stands, as `currentBudget` has it.
export type BudgetView = Awaited<ReturnType<typeof currentBudget>>

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

// "Pace today: 2% an hour → today's share runs out around 18:00", the outcome in
// the colour it calls for; a line with no pace to tell, dim.
function renderPace($: EngineInterface, e: RenderInput<'Pane'>, name: string, line: PaceLine): RenderElement {
  const { Text } = $.ui.resolve(e)
  if (line.outcome === null) return <Text dimColor>{`${name}: ${line.lead}`}</Text>
  return (
    <Text>
      <Text>{`${name}: ${line.lead} → `}</Text>
      <Text color={line.tone ?? undefined}>{line.outcome}</Text>
    </Text>
  )
}

// The details of the weekly budget, which the details pane and the VS Code panel
// both show under the bar: the numbers (marked last known when the reading is
// stale), where the pace leads, when the week resets, the plan, the mode, and the
// snooze with its buttons. The plan, the mode and the snooze come from the config and the store,
// so they show with no reading too.
export function renderDetailsBody(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  { budget, staleSince, cfg, snoozedUntil, tz, now, label, pace, basis, surface }: BudgetView,
): RenderElement {
  const { Box, Button, Text } = $.ui.resolve(e)
  const isSnoozed = snoozedUntil !== null && snoozedUntil > now

  return (
    <Box flexDirection="column" gap={1}>
      {(label !== null || basis !== null) && (
        <Box flexDirection="column">
          {label !== null && <Text dimColor>{`Account: ${label}`}</Text>}
          {basis !== null && <Text dimColor>{weekBasisText(basis, surface)}</Text>}
        </Box>
      )}
      {budget !== null && (
        <Box flexDirection="column">
          {staleSince !== null && <Text dimColor>{`Last known, as of ${asOf(staleSince, tz, now)}`}</Text>}
          <Text>{`Used ${pct(budget.used)}%`}</Text>
          <Text>{`Allowed by tonight ${pct(budget.allowed)}%`}</Text>
          {budget.state !== 'limit' && <Text color={STATE_COLORS[budget.state]}>{todayText(budget)}</Text>}
        </Box>
      )}
      {pace !== null && (pace.today !== null || pace.week !== null) && (
        <Box flexDirection="column">
          {pace.today !== null && renderPace($, e, 'Pace today', pace.today)}
          {pace.week !== null && renderPace($, e, 'Pace week', pace.week)}
        </Box>
      )}
      {budget !== null && (
        <Text color="claude">
          {`Resets ${DAY_NAMES[tz.weekday(budget.resetMs)]} ${tz.hhmm(budget.resetMs)} (in ${countdown(budget.resetMs - now)})`}
        </Text>
      )}
      <Box flexDirection="column">
        <Text>{planLine(cfg)}</Text>
        <Text>{`Mode: ${MODE_LABELS[cfg.mode]}`}</Text>
        <Text>{`Leftover: ${LEFTOVER_LABELS[cfg.leftover]}`}</Text>
      </Box>
      <Box flexDirection="column">
        <Text>{isSnoozed ? `Warnings snoozed until ${tz.hhmm(snoozedUntil)}` : 'Warnings on'}</Text>
        <Box flexWrap="wrap" gap={1}>
          {cfg.snoozeOptionsMin.map(minutes => (
            <Button key={`snooze-${minutes}`} label={snoozeLabel(minutes)} variant="secondary" onPress={() => snoozeFor($, minutes)} />
          ))}
          <Button key="snooze-today" label="Snooze today" variant="secondary" onPress={() => snoozeFor($, 'today')} />
          {isSnoozed && <Button key="resume" label="Resume" variant="secondary" onPress={() => snoozeFor($, null)} />}
        </Box>
      </Box>
    </Box>
  )
}
