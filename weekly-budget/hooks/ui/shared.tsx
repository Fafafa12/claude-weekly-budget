import type { EngineInterface, RenderElement, RenderInput, ThemeKey } from 'claude-code'

import { DAY_NAMES, dayShares } from '../lib/config'
import type { Config, Weekday } from '../lib/config'
import { paneTitle, pct, stateLabel, textBar } from '../lib/format'
import type { Budget, BudgetState } from '../lib/plan'
import { MIN_LABEL_SHARE, barSegments, barSvg } from '../lib/svg'
import type { Tz } from '../lib/tz'

const BAR_HEIGHT = 20

// Theme keys, so that the state follows Claude's theme on each surface.
export const STATE_COLORS: Record<BudgetState, ThemeKey> = { ok: 'success', near: 'warning', over: 'error', limit: 'error' }

export const NO_READING_TEXT = 'No weekly reading yet — send a message.'

const MON_TO_SUN: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0]

// "Plan: Mon 18 · Tue 18 · … · Sun 5": each weekday's share of the week, in week order.
export function planLine(cfg: Config): string {
  const shares = dayShares(cfg.pins)
  return `Plan: ${MON_TO_SUN.map(day => `${DAY_NAMES[day]} ${pct(shares[day] ?? 0)}`).join(' · ')}`
}

// The budget bar both panes draw: the share-sized Svg where the surface has one, the
// text bar where it has not. The Svg's alt is the compact pane's title, "as of" mark included.
export function renderBar(
  $: EngineInterface,
  e: RenderInput<'Pane'>,
  budget: Budget,
  { staleSince, tz, now }: { staleSince: number | null; tz: Tz; now: number },
): RenderElement {
  const els = $.ui.resolve(e)

  // The terminal's table names `Svg` too (the kit's does), yet refuses a tree that draws one.
  if (e.surface === 'terminal' || !('Svg' in els)) {
    const { Text } = els
    return <Text mono>{textBar(budget.used, budget.allowed)}</Text>
  }

  // No width: the bar takes the body's, whatever it is (the surface gives its width
  // only in cells), and the weekday labels under it share that width out as the
  // segments do, the narrow ones unlabelled, today's in Claude's colour.
  const { Box, Svg, Text } = els
  const segments = barSegments(budget)
  const widths = wholeWidths(segments)
  return (
    <Box flexDirection="column">
      <Svg source={barSvg(budget)} alt={paneTitle(budget, staleSince, tz, now)} height={BAR_HEIGHT} />
      <Box flexDirection="row">
        {segments.map((segment, i) => (
          <Box key={`day-${i}`} width={`${widths[i] ?? 0}%`} justifyContent="center">
            {segment.width >= MIN_LABEL_SHARE &&
              (segment.isToday ? (
                <Text size="caption" color="claude" weight="semibold">
                  {DAY_NAMES[segment.weekday]}
                </Text>
              ) : (
                <Text size="caption" dimColor>
                  {DAY_NAMES[segment.weekday]}
                </Text>
              ))}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

// The host takes a Box width only as a whole percentage, so the segments' widths
// are rounded at each boundary: they still add up to 100, and no label sits more than
// half a percent off its segment.
function wholeWidths(segments: readonly { width: number }[]): number[] {
  let edge = 0
  let total = 0
  return segments.map(segment => {
    total += segment.width
    const next = Math.round(total)
    const width = next - edge
    edge = next
    return width
  })
}

// Where the budget stands, in a word in the state's theme colour: "On track",
// "Running low", "Over today", "Weekly limit reached".
export function renderStateLabel($: EngineInterface, e: RenderInput<'Pane'>, budget: Budget): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text color={STATE_COLORS[budget.state]} weight="semibold">
      {stateLabel(budget.state)}
    </Text>
  )
}
