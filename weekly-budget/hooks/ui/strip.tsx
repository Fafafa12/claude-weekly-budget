import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget, hideStrip, isStripHidden, openDetails } from '../controller'
import { renderBar, renderSummary } from './shared'

// The desktop app's strip above the message box (its AbovePrompt band): the summary
// line with a quiet Details link, which opens the details beside the conversation,
// a ✕ that hides the strip for this chat (/budget shows it again), and the bar under
// it. Every other surface, a survey that needs the band, and a closed strip get what
// is below this plugin instead.
export async function renderStrip(
  $: EngineInterface,
  e: RenderInput<'AbovePrompt'>,
  next: (e: RenderInput<'AbovePrompt'>) => Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.surface !== 'desktop' || e.props.hasSurvey || (await isStripHidden($))) return next(e)
  const { Box, Button } = $.ui.resolve(e)
  const view = await currentBudget($)
  const { budget, staleSince, tz, now } = view

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        {renderSummary($, e, view)}
        <Box flexDirection="row" gap={2}>
          <Button key="strip-details" label="▸ Details" plain dimColor onPress={() => openDetails($)} />
          <Button key="strip-close" label="✕" plain dimColor onPress={() => hideStrip($)} />
        </Box>
      </Box>
      {budget !== null && renderBar($, e, budget, { staleSince, tz, now })}
    </Box>
  )
}
