import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { resolveTz } from '../controller'
import { paneTitle, textBar } from '../lib/format'
import type { Budget } from '../lib/plan'
import { barSvg } from '../lib/svg'

const BAR_HEIGHT = 34

export const NO_READING_TEXT = 'No weekly reading yet — send a message.'

// The budget bar both panes draw: the share-sized Svg where the surface has one, the
// text bar where it has not.
export async function renderBar($: EngineInterface, e: RenderInput<'Pane'>, budget: Budget): Promise<RenderElement> {
  const els = $.ui.resolve(e)

  // The terminal's table names `Svg` too (the kit's does), yet refuses a tree that draws one.
  if (e.surface === 'terminal' || !('Svg' in els)) {
    const { Text } = els
    return <Text mono>{textBar(budget.used, budget.allowed)}</Text>
  }

  // The bar is as wide as the body (about 8px a column, less the frame), within what reads well.
  const width = Math.min(560, Math.max(200, e.props.bodyColumns * 8 - 24))
  const { Svg } = els
  const source = barSvg(budget, width, await resolveTz($))
  return <Svg source={source} alt={paneTitle(budget)} width={width} height={BAR_HEIGHT} />
}
