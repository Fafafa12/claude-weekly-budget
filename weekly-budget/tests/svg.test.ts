import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { computeBudget } from '../hooks/lib/plan'
import { COLORS, MIN_LABEL_SHARE, barSegments, barSvg } from '../hooks/lib/svg'
import { fixedOffsetTz } from '../hooks/lib/tz'

const tz = fixedOffsetTz(180)
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local

// Thu 15:00: the pieces are Tue 3%, Wed 18, Thu 18, Fri 18, Sat 5, Sun 5, Mon 18, Tue 15.
const budgetAt = (used: number, config: Config = cfg) =>
  computeBudget({ percentUsed: used, resetsMs: reset, at: now }, config, now, tz)
const svgAt = (used: number, config: Config = cfg): string => barSvg(budgetAt(used, config))

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

test("colours are Claude's", async () => {
  expect(COLORS).toEqual({
    claude: '#D97757',
    track: '#B1ADA1',
    ok: '#8CB88A',
    near: '#E0B562',
    over: '#E08A7A',
    overDeep: '#C4553F',
    label: '#9A958A',
  })
})

// Drawn on a 1000-wide grid (10 a percent) that stretches to whatever the panel is
// wide, so nothing in it may be text: the weekday labels are drawn beside it.
test('a root element that stretches to the width it is given', async () => {
  const svg = svgAt(33)
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(svg).toContain('width="1000" height="20" viewBox="0 0 1000 20" preserveAspectRatio="none"')
  expect(svg).not.toContain('<text')
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(svg.length).toBeLessThan(131072)
})

test("today's segment is highlighted", async () => {
  expect(svgAt(33)).toContain('<rect x="210" y="0" width="180" height="20" rx="3" fill="#D97757" fill-opacity="0.14"/>')
})

test('the track and the ticks between segments, which stay one pixel when stretched', async () => {
  const svg = svgAt(33)
  expect(svg).toContain('<rect x="0" y="6" width="1000" height="8" rx="4" fill="#B1ADA1" fill-opacity="0.32"/>')
  expect(svg).toContain('stroke="#B1ADA1" stroke-opacity="0.55"')
  // Seven boundaries between eight segments.
  expect(count(svg, 'y1="3" x2="')).toBe(7)
  expect(svg).toContain('<line x1="30" y1="3" x2="30" y2="17" vector-effect="non-scaling-stroke"/>')
  expect(svg).toContain('<line x1="850" y1="3" x2="850" y2="17" vector-effect="non-scaling-stroke"/>')
})

test('the marker sits where the plan allows by tonight', async () => {
  expect(svgAt(33)).toContain(
    '<line x1="390" y1="1" x2="390" y2="19" stroke="#D97757" stroke-width="2.5" stroke-linecap="round" vector-effect="non-scaling-stroke"/>',
  )
})

test('the fill follows the state', async () => {
  const ok = svgAt(33)
  expect(ok).toContain('<rect x="0" y="6" width="330" height="8" rx="4" fill="#8CB88A"/>')
  expect(ok).not.toContain('#C4553F')

  expect(svgAt(37)).toContain('<rect x="0" y="6" width="370" height="8" rx="4" fill="#E0B562"/>')

  // Past the marker the use shows in the deeper colour.
  const over = svgAt(43)
  expect(over).toContain('<rect x="0" y="6" width="390" height="8" rx="4" fill="#E08A7A"/>')
  expect(over).toContain('<rect x="390" y="6" width="40" height="8" rx="2" fill="#C4553F"/>')
  expect(over).not.toContain('#8CB88A')
})

test('the limit fills the whole bar', async () => {
  const svg = svgAt(100)
  expect(svg).toContain('<rect x="0" y="6" width="390" height="8" rx="4" fill="#E08A7A"/>')
  expect(svg).toContain('<rect x="390" y="6" width="610" height="8" rx="2" fill="#C4553F"/>')
})

test('a day with no share has no segment or tick', async () => {
  // Seven segments left, so six ticks.
  expect(count(svgAt(33, { ...cfg, pins: [{ days: [6], percent: 0 }] }), 'y1="3" x2="')).toBe(6)
})

test('an empty week draws a bar and no segments', async () => {
  const svg = svgAt(0, { ...cfg, pins: [{ days: [0, 1, 2, 3, 4, 5, 6], percent: 0 }] })
  expect(svg).toContain('width="1000" height="8"')
  expect(count(svg, 'y1="3" x2="')).toBe(0)
})

// The segments the labels under the bar line up with: each as wide, in % of the bar,
// as its share, today marked, a 0% day left out.
test('barSegments gives each day its share of the bar', async () => {
  expect(barSegments(budgetAt(33)).map(s => [s.weekday, Math.round(s.width * 1e6) / 1e6, s.isToday])).toEqual([
    [2, 3, false],
    [3, 18, false],
    [4, 18, true],
    [5, 18, false],
    [6, 5, false],
    [0, 5, false],
    [1, 18, false],
    [2, 15, false],
  ])
  expect(barSegments(budgetAt(33, { ...cfg, pins: [{ days: [6], percent: 0 }] })).map(s => s.weekday)).not.toContain(6)
})

test('only segments wide enough carry a label', async () => {
  // The first Tue (3%) is too narrow; the 5% weekend days are not.
  expect(MIN_LABEL_SHARE).toBeGreaterThan(3)
  expect(MIN_LABEL_SHARE).toBeLessThan(5)
})
