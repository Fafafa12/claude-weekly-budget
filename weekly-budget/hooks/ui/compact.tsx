import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { currentBudget, getDetailsExpanded, toggleDetails } from '../controller'
import { renderDetailsBody } from './details-body'
import { NO_READING_TEXT, renderBar, renderStateLabel } from './shared'

// The body of VS Code's one panel: the bar, and the details under it. The host draws
// the summary as the pane's title, so there is none to repeat. Under the bar, the
// state in a word; in the compact view the details are behind a quiet toggle beside it, which opens them below it and closes them
// again; in the full view they are always there, and there is no toggle.
export async function renderCompact($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement> {
  const { Box, Button, Text } = $.ui.resolve(e)
  const [view, isExpanded] = await Promise.all([currentBudget($), getDetailsExpanded($)])
  const { budget, staleSince, cfg, tz, now } = view
  const isCompact = cfg.showCompactPanel

  return (
    <Box flexDirection="column" gap={1}>
      {budget === null ? <Text dimColor>{NO_READING_TEXT}</Text> : renderBar($, e, budget, { staleSince, tz, now })}
      {(budget !== null || isCompact) && (
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
          {budget !== null && renderStateLabel($, e, budget)}
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
      )}
      {(!isCompact || isExpanded) && renderDetailsBody($, e, view)}
    </Box>
  )
}
