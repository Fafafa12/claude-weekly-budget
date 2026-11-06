import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget, getDetailsExpanded, toggleDetails } from '../controller'
import { renderDetailsBody } from './details-body'
import { renderBar, renderSummary } from './shared'

// The body of VS Code's one panel. The host draws the header in plain text, so the
// summary is the first line here instead: what was used and today's balance in the
// state's theme colour, the rest plain, an "as of" mark dim; beside it, in the compact
// view, a quiet toggle for the details. Then the bar, and the details when they are
// open (always, in the full view).
export async function renderCompact($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [view, isExpanded] = await Promise.all([currentBudget($), getDetailsExpanded($)])
  const { budget, staleSince, cfg, tz, now } = view
  const isCompact = cfg.showCompactPanel

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        {renderSummary($, e, view)}
        {isCompact && (
          <Button
            key="details-toggle"
            label={isExpanded ? '▾ Details' : '▸ Details'}
            plain
            dimColor
            onPress={() => toggleDetails($)}
          />
        )}
      </Box>
      {budget !== null && renderBar($, e, budget, { staleSince, tz, now })}
      {(!isCompact || isExpanded) && renderDetailsBody($, e, view)}
    </Box>
  )
}
