import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget, openDetails } from '../controller'
import { renderBar, renderSummary } from './shared'

// The desktop app's strip above the message box (its AbovePrompt band): the summary
// line with a quiet Details link, which opens the details beside the conversation,
// and the bar under it. Every other surface, and a survey that needs the band, gets
// what is below this plugin instead.
export async function renderStrip(
  $: EngineInterface,
  e: RenderInput<'AbovePrompt'>,
  next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.surface !== 'desktop' || e.props.hasSurvey) return next(e)
  const { Box, Button } = $.ui.resolve(e)
  const view = await currentBudget($)
  const { budget, staleSince, tz, now } = view

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        {renderSummary($, e, view)}
        <Button key="strip-details" label="▸ Details" plain dimColor onPress={() => openDetails($)} />
      </Box>
      {budget !== null && renderBar($, e, budget, { staleSince, tz, now })}
    </Box>
  )
}
