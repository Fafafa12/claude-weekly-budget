// Draws the README's pictures of weekly-budget, from the plugin's own code: its bar,
// its status line, its /budget reply and its pace wording, on one made-up week. No
// real account appears. Run from the repository root:
//
//   npx tsx scripts/screens.ts
//
// and commit what changed in assets/screens/.

import { mkdirSync, writeFileSync } from 'node:fs'

import { DAY_NAMES, DEFAULT_CONFIG, dayShares } from '../weekly-budget/hooks/lib/config'
import type { Config, Weekday } from '../weekly-budget/hooks/lib/config'
import { todayForecast, todayPaceLine, weekForecast, weekPaceLine } from '../weekly-budget/hooks/lib/forecast'
import type { PaceLine } from '../weekly-budget/hooks/lib/forecast'
import { budgetReply, countdown, pct, stateLabel, statusLine, todayText } from '../weekly-budget/hooks/lib/format'
import { computeBudget } from '../weekly-budget/hooks/lib/plan'
import { barSegments, barSvg, COLORS, MIN_LABEL_SHARE } from '../weekly-budget/hooks/lib/svg'
import { fixedOffsetTz } from '../weekly-budget/hooks/lib/tz'

// ── The week shown: Thursday 15:00, the weekend pinned at 10%, 24% used, using
// about 3% an hour since lunch.
const HOUR_MS = 3600e3
const tz = fixedOffsetTz(180)
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const budget = computeBudget({ percentUsed: 24, resetsMs: reset, at: now }, cfg, now, tz)
const samples = [
  { at: now - 2 * HOUR_MS, percentUsed: 18 },
  { at: now - HOUR_MS, percentUsed: 21 },
  { at: now, percentUsed: 24 },
]
const ACCOUNT = 'Acme (you@acme.dev)'
const today = todayForecast(budget, samples, now, tz)
const week = weekForecast(budget, now)
const paceToday = today === null ? null : todayPaceLine(today, tz)
const paceWeek = week === null ? null : weekPaceLine(week, tz, now)
const reply = `${budgetReply(budget, null, tz, now)} · ${ACCOUNT}`
const status = statusLine(budget, 'B', null, tz, now)
const MON_TO_SUN: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 0]
const shares = dayShares(cfg.pins)
const plan = `Plan: ${MON_TO_SUN.map(d => `${DAY_NAMES[d]} ${pct(shares[d] ?? 0)}`).join(' · ')}`
const resets = `Resets ${DAY_NAMES[tz.weekday(reset)]} ${tz.hhmm(reset)} (in ${countdown(reset - now)})`

// ── Claude's dark theme, as the apps draw it.
const C = {
  window: '#1f1e1d',
  chrome: '#2b2a27',
  panel: '#262624',
  card: '#2c2b28',
  field: '#30302e',
  border: '#3d3c38',
  text: '#ece9e0',
  dim: '#9a958a',
  faint: '#6f6b63',
  claude: COLORS.claude,
  success: COLORS.ok,
  warning: COLORS.near,
  error: COLORS.over,
}
const STATE: Record<string, string> = { ok: C.success, near: C.warning, over: C.error, limit: C.error }
const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace"
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', Roboto, 'Helvetica Neue', Arial, sans-serif"

// ── Drawing helpers.
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
type Run = { t: string; fill?: string; weight?: number }
type TextOpts = { size?: number; font?: string; anchor?: 'start' | 'middle' | 'end'; fill?: string; weight?: number }

function text(x: number, y: number, runs: Run[] | string, o: TextOpts = {}): string {
  const list = typeof runs === 'string' ? [{ t: runs }] : runs
  const spans = list
    .map(r => `<tspan${r.fill ? ` fill="${r.fill}"` : ''}${r.weight ? ` font-weight="${r.weight}"` : ''}>${esc(r.t)}</tspan>`)
    .join('')
  return (
    `<text x="${x}" y="${y}" font-family="${o.font ?? SANS}" font-size="${o.size ?? 14}" fill="${o.fill ?? C.text}"` +
    `${o.weight ? ` font-weight="${o.weight}"` : ''} text-anchor="${o.anchor ?? 'start'}" xml:space="preserve">${spans}</text>`
  )
}

const rect = (x: number, y: number, w: number, h: number, rx: number, fill: string, stroke?: string): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}"` : ''}/>`

// A picture, its contents kept inside its rounded corners.
function svgDoc(w: number, h: number, title: string, body: string, rx = 14): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    `<defs><clipPath id="corners"><rect width="${w}" height="${h}" rx="${rx}"/></clipPath></defs>` +
    `<g clip-path="url(#corners)">${body}</g></svg>\n`
  )
}

// A window with its title bar: three dots and a title.
function windowFrame(w: number, h: number, title: string): string {
  return (
    rect(0.5, 0.5, w - 1, h - 1, 14, C.window, C.border) +
    `<path d="M14.5 0.5 H${w - 14.5} A14 14 0 0 1 ${w - 0.5} 14.5 V40 H0.5 V14.5 A14 14 0 0 1 14.5 0.5 Z" fill="${C.chrome}"/>` +
    `<line x1="0.5" y1="40" x2="${w - 0.5}" y2="40" stroke="${C.border}"/>` +
    [0, 1, 2].map(i => `<circle cx="${22 + i * 20}" cy="20" r="6" fill="${['#ec6a5e', '#f4bf4f', '#61c554'][i]}"/>`).join('') +
    text(w / 2, 25, title, { size: 13, anchor: 'middle', fill: C.dim })
  )
}

// The plugin's own bar, nested at a place and width, with its weekday labels under it
// as the panel draws them: today's in Claude's colour, the narrow ones unlabelled.
function bar(x: number, y: number, w: number): string {
  const inner = barSvg(budget).replace(/^<svg [^>]*>/, `<svg x="${x}" y="${y}" width="${w}" height="20" viewBox="0 0 1000 20" preserveAspectRatio="none">`)
  let edge = 0
  const labels = barSegments(budget)
    .map(s => {
      const mid = x + ((edge + s.width / 2) / 100) * w
      edge += s.width
      if (s.width < MIN_LABEL_SHARE) return ''
      return text(mid, y + 38, DAY_NAMES[s.weekday] ?? '', {
        size: 11,
        anchor: 'middle',
        fill: s.isToday ? C.claude : C.dim,
        weight: s.isToday ? 600 : undefined,
      })
    })
    .join('')
  return inner + labels
}

// "24% of 39% · 15% left today", the used figure and today's balance in the state's colour.
const summaryRuns = (): Run[] => [
  { t: `${pct(budget.used)}%`, fill: STATE[budget.state] },
  { t: ` of ${pct(budget.allowed)}% · ` },
  { t: todayText(budget), fill: STATE[budget.state] },
]

const TONE: Record<string, string> = { warning: C.warning, success: C.success }
const paceRuns = (name: string, line: PaceLine): Run[] =>
  line.outcome === null
    ? [{ t: `${name}: ${line.lead}`, fill: C.dim }]
    : [{ t: `${name}: ${line.lead} → ` }, { t: line.outcome, fill: line.tone === null ? undefined : TONE[line.tone] }]

// A secondary button: a quiet rounded box with its label.
function button(x: number, y: number, label: string, o: { size?: number; font?: string; charW?: number } = {}): { svg: string; w: number } {
  const w = Math.round(label.length * (o.charW ?? 7.4) + 24)
  return { svg: rect(x, y, w, 28, 7, C.field, C.border) + text(x + w / 2, y + 19, label, { size: o.size ?? 13, anchor: 'middle', font: o.font }), w }
}

// Breaks a line into lines of at most `width` characters, at spaces.
function wrap(s: string, width: number): string[] {
  const lines: string[] = []
  let cur = ''
  for (const word of s.split(' ')) {
    if (cur !== '' && (cur + ' ' + word).length > width) {
      lines.push(cur)
      cur = word
    } else cur = cur === '' ? word : `${cur} ${word}`
  }
  if (cur !== '') lines.push(cur)
  return lines
}

// ── The terminal: a short chat, /budget's reply, the details pane docked on the
// right, and the status line under the prompt.
function terminal(): string {
  const W = 1180
  const H = 560
  const M = { size: 13, font: MONO }
  const L = 28
  const R = 640
  let s = windowFrame(W, H, 'claude — ~/projects/acme-app')
  s += `<line x1="${R - 24}" y1="40" x2="${R - 24}" y2="${H - 92}" stroke="${C.border}"/>`

  // The chat.
  let y = 82
  s += text(L, y, [{ t: '> ', fill: C.dim }, { t: 'split the invoice parser into steps, keep the tests green' }], M)
  y += 30
  s += text(L, y, [{ t: '● ', fill: C.claude }, { t: 'Done: parse() is now read → validate → total. 42 tests pass.' }], M)
  y += 40
  s += text(L, y, [{ t: '> ', fill: C.dim }, { t: '/budget', fill: C.claude }], M)
  y += 26
  wrap(`weekly-budget: ${reply}`, 70).forEach((line, i) => {
    s += text(L, y + i * 20, [{ t: i === 0 ? '  └ ' : '    ', fill: C.dim }, { t: line, fill: C.dim }], M)
  })

  // The details pane.
  let py = 72
  const P = R
  const lines: Run[][] = [
    [{ t: 'Weekly budget', weight: 700 }],
    [{ t: stateLabel(budget.state), fill: STATE[budget.state], weight: 600 }],
    [{ t: `Account: ${ACCOUNT}`, fill: C.dim }],
    [],
    [{ t: `Used ${pct(budget.used)}%` }],
    [{ t: `Allowed by tonight ${pct(budget.allowed)}%` }],
    [{ t: todayText(budget), fill: STATE[budget.state] }],
    [],
    paceToday === null ? [] : paceRuns('Pace today', paceToday),
    paceWeek === null ? [] : paceRuns('Pace week', paceWeek),
    [],
    [{ t: resets, fill: C.claude }],
    [],
    [{ t: plan }],
    [{ t: 'Mode: warn' }],
    [{ t: 'Leftover: fixed' }],
    [],
    [{ t: 'Warnings on' }],
  ]
  for (const runs of lines) {
    if (runs.length > 0) s += text(P, py, runs, { ...M, size: 12.5 })
    py += runs.length > 0 ? 20 : 10
  }
  s += text(P, py + 4, [{ t: '[ Snooze 1h ]', fill: C.text }, { t: '  ' }, { t: '[ Snooze today ]', fill: C.text }], { ...M, size: 12.5 })

  // The prompt and the status line under it.
  s += `<line x1="0.5" y1="${H - 92}" x2="${W - 0.5}" y2="${H - 92}" stroke="${C.border}"/>`
  s += text(L, H - 62, [{ t: '> ', fill: C.text }, { t: '▌', fill: C.dim }], M)
  s += `<line x1="0.5" y1="${H - 44}" x2="${W - 0.5}" y2="${H - 44}" stroke="${C.border}"/>`
  s += text(L, H - 18, [{ t: '⚠ weekly-budget: ', fill: C.warning }, { t: status }], M)
  return svgDoc(W, H, 'weekly-budget in the terminal: the status line, the /budget reply and the details pane', s)
}

// ── VS Code: the Claude panel with the budget panel on top, details open.
function vscode(): string {
  const W = 1180
  const H = 640
  const SIDE = 600 // where the Claude panel starts
  let s = windowFrame(W, H, 'invoice-parser.ts — acme-app — Visual Studio Code')
  // An editor on the left, for context.
  s += rect(1, 41, 48, H - 42, 0, '#232220')
  ;[70, 118, 166, 214].forEach(y => (s += rect(14, y, 22, 22, 5, C.faint)))
  const code = [
    [{ t: 'export ', fill: '#c48bd6' }, { t: 'function ', fill: '#c48bd6' }, { t: 'parse', fill: '#7fb3e0' }, { t: '(raw: ' }, { t: 'string', fill: '#8cc5a6' }, { t: ') {' }],
    [{ t: '  const ', fill: '#c48bd6' }, { t: 'rows = ' }, { t: 'read', fill: '#7fb3e0' }, { t: '(raw)' }],
    [{ t: '  const ', fill: '#c48bd6' }, { t: 'valid = ' }, { t: 'validate', fill: '#7fb3e0' }, { t: '(rows)' }],
    [{ t: '  return ', fill: '#c48bd6' }, { t: 'total', fill: '#7fb3e0' }, { t: '(valid)' }],
    [{ t: '}' }],
  ]
  code.forEach((runs, i) => {
    s += text(72, 84 + i * 22, [{ t: String(i + 1).padStart(2, ' ') + '   ', fill: C.faint }, ...runs], { size: 13, font: MONO })
  })
  s += `<line x1="${SIDE}" y1="40" x2="${SIDE}" y2="${H - 1}" stroke="${C.border}"/>`
  s += rect(SIDE + 0.5, 40.5, W - SIDE - 1.5, H - 42, 0, C.panel)
  s += text(SIDE + 20, 66, 'CLAUDE CODE', { size: 11, fill: C.dim, weight: 600 })

  // The budget panel: the host's title, then the plugin's body.
  const X = SIDE + 20
  const PW = W - SIDE - 40
  s += rect(X, 82, PW, 470, 10, C.card, C.border)
  s += text(X + 16, 108, 'Weekly budget', { size: 13, weight: 600 })
  s += text(X + PW - 16, 108, '×', { size: 16, anchor: 'end', fill: C.dim })
  s += `<line x1="${X}" y1="120" x2="${X + PW}" y2="120" stroke="${C.border}"/>`
  const BX = X + 16
  const BW = PW - 32
  s += text(BX, 148, summaryRuns(), { size: 14 })
  s += text(BX + BW, 148, '▾ Details', { size: 13, anchor: 'end', fill: C.dim })
  s += bar(BX, 162, BW)
  let y = 232
  const add = (runs: Run[] | string, o: TextOpts = {}, gap = 21) => {
    s += text(BX, y, runs, { size: 13, ...o })
    y += gap
  }
  add(`Account: ${ACCOUNT}`, { fill: C.dim }, 30)
  add(`Used ${pct(budget.used)}%`)
  add(`Allowed by tonight ${pct(budget.allowed)}%`)
  add(todayText(budget), { fill: STATE[budget.state] }, 30)
  if (paceToday !== null) add(paceRuns('Pace today', paceToday))
  if (paceWeek !== null) add(paceRuns('Pace week', paceWeek), {}, 30)
  add(resets, { fill: C.claude }, 30)
  add(plan)
  add('Mode: warn')
  add('Leftover: fixed', {}, 30)
  add('Warnings on', {}, 12)
  const b1 = button(BX, y, 'Snooze 1h')
  const b2 = button(BX + b1.w + 8, y, 'Snooze today')
  s += b1.svg + b2.svg

  // The chat box under it.
  s += rect(X, H - 70, PW, 46, 10, C.field, C.border)
  s += text(X + 16, H - 41, 'Queue another message…', { size: 13, fill: C.faint })
  return svgDoc(W, H, 'weekly-budget in VS Code: the budget panel with its details open', s)
}

// ── The desktop app: the strip above the message box.
function desktop(): string {
  const W = 1180
  const H = 420
  let s = windowFrame(W, H, 'Claude')
  s += rect(1, 41, 240, H - 42, 0, '#232220')
  ;['New', 'Search', 'Artifacts', 'Customize'].forEach((t, i) => (s += text(28, 80 + i * 32, t, { size: 13, fill: C.dim })))
  s += rect(14, 220, 212, 30, 8, C.field)
  s += text(28, 240, 'Invoice parser', { size: 13 })
  const X = 300
  const CW = 820
  s += text(X, 92, 'Done. parse() is now three steps, read, validate and total, and all 42 tests pass.', { size: 15 })
  s += text(X, 120, 'Want me to add a test for the empty-file case too?', { size: 15 })

  // The strip.
  const SY = 190
  s += rect(X, SY, CW, 92, 12, C.card, C.border)
  s += text(X + 16, SY + 26, summaryRuns(), { size: 14 })
  s += text(X + CW - 16, SY + 26, [{ t: '▸ Details' }, { t: '      ⚙' }, { t: '      ✕' }], { size: 13, anchor: 'end', fill: C.dim })
  s += bar(X + 16, SY + 40, CW - 32)

  // The message box.
  s += rect(X, SY + 104, CW, 52, 14, C.field, C.border)
  s += text(X + 20, SY + 136, '+', { size: 20, fill: C.dim })
  s += text(X + 50, SY + 135, 'Type / for commands', { size: 15, fill: C.faint })
  return svgDoc(W, H, 'weekly-budget in the Claude desktop app: a strip above the message box', s)
}

// ── The settings, as VS Code and the desktop app draw them.
function settings(): string {
  const W = 760
  const H = 470
  let s = rect(0.5, 0.5, W - 1, H - 1, 14, C.panel, C.border)
  s += text(24, 34, 'Weekly budget settings', { size: 14, weight: 600 })
  s += text(W - 24, 34, '×', { size: 18, anchor: 'end', fill: C.dim })
  s += `<line x1="0.5" y1="50" x2="${W - 0.5}" y2="50" stroke="${C.border}"/>`
  let y = 84
  s += text(24, y, `Settings for ${ACCOUNT}`, { size: 14, weight: 600 })
  y += 36
  const row = (label: string, choices: string[], chosen: string, gap = 30) => {
    const runs: Run[] = [{ t: `${label}   ` }]
    choices.forEach((c, i) => {
      if (i > 0) runs.push({ t: '  ·  ', fill: C.faint })
      runs.push(c === chosen ? { t: c, fill: C.claude, weight: 600 } : { t: c, fill: C.dim })
    })
    s += text(24, y, runs, { size: 13.5 })
    y += gap
  }
  const field = (label: string, value: string, gap = 36) => {
    s += text(24, y, label, { size: 13.5 })
    const fx = 24 + label.length * 7.3 + 14
    s += rect(fx, y - 19, 150, 28, 7, C.field, C.border) + text(fx + 12, y, value, { size: 13.5 })
    y += gap
  }
  row('Pin', ['Weekend', 'Weekdays', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], 'Weekend', 36)
  field('% of the week', '10')
  s += text(24, y, plan, { size: 13.5, fill: C.dim })
  y += 30
  row('Leftover', ['Fixed', 'Adaptive'], 'Fixed', 20)
  const b1 = button(24, y, 'Remove Sat+Sun 10%')
  const b2 = button(24 + b1.w + 8, y, 'Reset plan')
  s += b1.svg + b2.svg
  y += 62
  row('Mode', ['Warn once', 'Every message', 'Block'], 'Warn once')
  row('Heads-up (of today left)', ['Off', '10%', '25%', '50%'], '25%', 36)
  field('Snooze options (minutes, comma-separated)', '60', 40)
  row('Status line (terminal)', ['Numbers', 'Bar', 'Minimal'], 'Bar')
  row('Compact panel (VS Code)', ['On', 'Off'], 'On')
  return svgDoc(W, H, 'The weekly-budget settings: the plan, the leftover, the warnings and the display', s)
}

// ── A phone driving the session with Remote Control: the reply is what shows.
function phone(): string {
  const W = 400
  const H = 520
  let s = rect(0.5, 0.5, W - 1, H - 1, 44, '#151514', C.border)
  s += rect(14, 14, W - 28, H - 28, 34, C.window)
  s += rect(W / 2 - 50, 26, 100, 22, 11, '#151514')
  s += text(W / 2, 82, 'Remote Control · acme-app', { size: 12, anchor: 'middle', fill: C.dim })
  s += `<line x1="14" y1="96" x2="${W - 14}" y2="96" stroke="${C.border}"/>`
  // The person's message, then the reply.
  s += rect(W - 132, 120, 100, 36, 18, C.field)
  s += text(W - 82, 143, '/budget', { size: 14, anchor: 'middle', fill: C.claude })
  wrap(`weekly-budget: ${reply}`, 36).forEach((line, i) => {
    s += text(36, 196 + i * 22, line, { size: 14 })
  })
  s += text(36, 300, 'Panels and the strip draw on the computer;', { size: 12, fill: C.dim })
  s += text(36, 318, 'on the phone, the reply is the budget.', { size: 12, fill: C.dim })
  s += rect(30, H - 92, W - 60, 46, 23, C.field, C.border)
  s += text(52, H - 63, 'Reply…', { size: 14, fill: C.faint })
  return svgDoc(W, H, "weekly-budget on a phone through Remote Control: /budget's reply", s, 44)
}

mkdirSync('assets/screens', { recursive: true })
const pictures: Record<string, string> = { terminal: terminal(), vscode: vscode(), desktop: desktop(), settings: settings(), phone: phone() }
for (const [name, svg] of Object.entries(pictures)) writeFileSync(`assets/screens/${name}.svg`, svg)
console.log(`Drew ${Object.keys(pictures).length} pictures into assets/screens/:`)
console.log(`  status line  ${status}`)
console.log(`  reply        ${reply}`)
console.log(`  pace today   ${paceToday?.lead} → ${paceToday?.outcome}`)
console.log(`  pace week    ${paceWeek?.lead} → ${paceWeek?.outcome}`)
