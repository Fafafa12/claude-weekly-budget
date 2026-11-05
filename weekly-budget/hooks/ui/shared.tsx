import type { EngineInterface, RenderElement, RenderInput, ThemeKey } from 'claude-code'

import { DAY_NAMES, dayShares } from '../lib/config'
import type { Config, Weekday } from '../lib/config'
import { paneTitle, pct, stateLabel, textBar } from '../lib/format'
import type { Budget, BudgetState } from '../lib/plan'
import { barSvg } from '../lib/svg'
import type { Tz } from '../lib/tz'

const BAR_HEIGHT = 34

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

  // The bar is as wide as the body (about 8px a column, less the frame), within what reads well.
  const width = Math.min(560, Math.max(200, e.props.bodyColumns * 8 - 24))
  const { Svg } = els
  const source = barSvg(budget, width, tz)
  return <Svg source={source} alt={paneTitle(budget, staleSince, tz, now)} width={width} height={BAR_HEIGHT} />
}

// Where the budget stands, in a word in the state's theme colour: "On track",
// "Running low", "Over today", "Weekly limit reached".
export function renderStateLabel($: EngineInterface, e: RenderInput<'Pane'>, budget: Budget): RenderElement {
  const { Text } = $.ui.resolve(e)
  return (
    <Text color={STATE_COLORS[budget.state]} bold>
      {stateLabel(budget.state)}
    </Text>
  )
}
