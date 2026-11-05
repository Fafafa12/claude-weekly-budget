import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget } from '../controller'
import { renderDetailsBody } from './details-body'
import { NO_READING_TEXT, renderBar } from './shared'

// The body of the details pane, which /budget opens in a terminal (and any surface
// that asks for it): the bar, then the details.
export async function renderDetails($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Text } = $.ui.resolve(e)
  const view = await currentBudget($)
  const { budget, staleSince, tz, now } = view

  return (
    <Box flexDirection="column" gap={1}>
      {budget === null ? <Text dimColor>{NO_READING_TEXT}</Text> : renderBar($, e, budget, { staleSince, tz, now })}
      {renderDetailsBody($, e, view)}
    </Box>
  )
}
