import type { Register } from 'claude-code'

import { onMeasure, onPrompt, refresh, runBudgetCommand, showToast } from './controller'

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
    $.clock.every(60_000, () => void refresh($))
    void refresh($)

    return next(e)
  })

  // The surface that attached may be the first to draw, or the terminal.
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await refresh($)

    return attached
  })

  on('session.measure', async ($, e, next) => {
    await onMeasure($, e.rateLimits)

    return next(e)
  })

  // A guard: if it fails, the message goes through.
  on('prompt.submit', async ($, e, next) => {
    const gate = await onPrompt($, e)
    if (gate !== null && 'drop' in gate) return { drop: gate.drop }
    if (gate !== null) await showToast($, gate.toast)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'budget' }, async ($, e) => ({
    text: await runBudgetCommand($, e.args),
  }))
}
