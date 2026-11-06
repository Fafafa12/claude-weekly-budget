import type { Register } from 'claude-code'

import {
  ensureCompact,
  onAttach,
  onMeasure,
  onPrompt,
  openSettings,
  probeUsageQuietly,
  refreshQuietly,
  runBudgetCommand,
  setInteractive,
  setSurface,
  showToast,
  tickQuietly,
} from './controller'
import { renderCompact } from './ui/compact'
import { renderDetails } from './ui/details'
import { renderSettings } from './ui/settings'
import { renderStrip } from './ui/strip'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'budget',
      description: 'Show your weekly Claude budget (or: /budget snooze 1h)',
    })
    await $.command.register({
      name: 'budget-config',
      description: 'Set your weekly Claude budget plan and warnings',
    })
    await setInteractive($, e.isInteractive)
    await setSurface($, e.surface)
    $.clock.every(60_000, () => void tickQuietly($))
    void refreshQuietly($)
    void ensureCompact($).catch(() => {})
    // A fresh figure for the chat that starts, without waiting for its first reply.
    void probeUsageQuietly($, false)

    return next(e)
  })

  // The surface that attached may be the first to draw, or the terminal; in the
  // desktop app, it is the first sign that someone is there.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await onAttach($, e.surface).catch(() => {})
    await refreshQuietly($)
    await ensureCompact($).catch(() => {})

    return attached
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, e.rateLimits, e.changed)

    return next(e)
  })

  // A guard: if it fails, the message goes through.
  on('prompt.submit', async ($, e, next) => {
    const gate = await onPrompt($, e)
    if (gate !== null && 'drop' in gate) return { drop: gate.drop }
    if (gate !== null) await showToast($, gate.toast)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'compact' }, async ($, e) => renderCompact($, e))

  // The desktop app's strip above the message box; other surfaces pass through.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => renderStrip($, e, next))

  on('ui.render', { component: 'Pane', requestId: 'details' }, async ($, e) => renderDetails($, e))

  on('ui.render', { component: 'Pane', requestId: 'settings' }, async ($, e) => renderSettings($, e))

  on('command.run', { command: 'budget' }, async ($, e) => ({
    text: await runBudgetCommand($, e.args),
  }))

  on('command.run', { command: 'budget-config' }, async $ => {
    await openSettings($)

    return { text: 'Budget settings opened.' }
  })
}
