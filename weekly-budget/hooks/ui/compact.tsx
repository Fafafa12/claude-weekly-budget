import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget } from '../controller'
import { NO_READING_TEXT, renderBar } from './shared'

// The body of the compact pane: the bar and nothing else. The host draws the
// summary as the pane's title, so there is no text to repeat, and no button: the
// pane is read at a glance and closed with the host's own mark.
export async function renderCompact($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { budget } = await currentBudget($)
  if (budget === null) {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{NO_READING_TEXT}</Text>
  }

  return renderBar($, e, budget)
}
