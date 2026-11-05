import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget, resolveTz } from '../controller'
import { paneTitle, textBar } from '../lib/format'
import { barSvg } from '../lib/svg'

const BAR_HEIGHT = 34

// The body of the compact pane: the bar and nothing else. The host draws the
// summary as the pane's title, so there is no text to repeat, and no button: the
// pane is read at a glance and closed with the host's own mark.
export async function renderCompact($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Text } = els
  const { budget } = await currentBudget($)
  if (budget === null) return <Text dimColor>No weekly reading yet — send a message.</Text>

  // The terminal's table names `Svg` too (the kit's does), yet refuses a tree that draws one.
  if (e.surface === 'terminal' || !('Svg' in els)) {
    return <Text mono>{textBar(budget.used, budget.allowed)}</Text>
  }

  // The bar is as wide as the body (about 8px a column, less the frame), within what reads well.
  const width = Math.min(560, Math.max(200, e.props.bodyColumns * 8 - 24))
  const { Svg } = els
  const source = barSvg(budget, width, await resolveTz($))
  return <Svg source={source} alt={paneTitle(budget)} width={width} height={BAR_HEIGHT} />
}
