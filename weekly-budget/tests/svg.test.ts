import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/lib/config'
import type { Config } from '../hooks/lib/config'
import { computeBudget } from '../hooks/lib/plan'
import { COLORS, barSvg } from '../hooks/lib/svg'
import { fixedOffsetTz } from '../hooks/lib/tz'

const tz = fixedOffsetTz(180)
const cfg: Config = { ...DEFAULT_CONFIG, pins: [{ days: [6, 0], percent: 10 }] }
const reset = Date.parse('2026-11-10T17:00:00Z') // Tue 20:00 local
const now = Date.parse('2026-11-05T12:00:00Z') // Thu 15:00 local
const width = 520

// Thu 15:00: the pieces are Tue 3%, Wed 18, Thu 18, Fri 18, Sat 5, Sun 5, Mon 18, Tue 15.
const svgAt = (used: number, config: Config = cfg): string =>
  barSvg(computeBudget({ percentUsed: used, resetsMs: reset, at: now }, config, now, tz), width, tz)

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

test('a root element that stands alone as an image', async () => {
  const svg = svgAt(33)
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
  expect(svg).toContain('width="520" height="34" viewBox="0 0 520 34"')
  expect(svg.endsWith('</svg>')).toBe(true)
  expect(svg.length).toBeLessThan(131072)
})

test('labels only the segments wide enough', async () => {
  const svg = svgAt(33)
  // The first Tue is 15.6px wide, so only the last one (78px) is labelled.
  expect(count(svg, '>Tue<')).toBe(1)
  expect(svg).toContain('<text x="481" y="31"')
  // Sat and Sun are 26px each, over the 24px floor.
  for (const day of ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']) expect(count(svg, `>${day}<`)).toBe(1)
})

test("today's label is Claude orange and bold, the rest are not", async () => {
  const svg = svgAt(33)
  expect(svg).toContain('<text x="156" y="31" fill="#D97757" font-weight="700">Thu</text>')
  expect(count(svg, 'font-weight="700"')).toBe(1)
  expect(svg).toContain('fill="#9A958A"')
})

test("today's segment is highlighted", async () => {
  expect(svgAt(33)).toContain('<rect x="109.2" y="0" width="93.6" height="20" rx="3" fill="#D97757" fill-opacity="0.14"/>')
})

test('the track and the ticks between segments', async () => {
  const svg = svgAt(33)
  expect(svg).toContain('<rect x="0" y="6" width="520" height="8" rx="4" fill="#B1ADA1" fill-opacity="0.32"/>')
  expect(svg).toContain('stroke="#B1ADA1" stroke-opacity="0.55"')
  // Seven boundaries between eight segments.
  expect(count(svg, 'y1="3" x2="')).toBe(7)
  expect(svg).toContain('<line x1="15.6" y1="3" x2="15.6" y2="17"/>')
  expect(svg).toContain('<line x1="442" y1="3" x2="442" y2="17"/>')
})

test('the marker sits where the plan allows by tonight', async () => {
  const svg = svgAt(33)
  expect(svg).toContain(
    '<line x1="202.8" y1="1" x2="202.8" y2="19" stroke="#D97757" stroke-width="2.5" stroke-linecap="round"/>',
  )
})

test('the fill follows the state', async () => {
  const ok = svgAt(33)
  expect(ok).toContain('<rect x="0" y="6" width="171.6" height="8" rx="4" fill="#8CB88A"/>')
  expect(ok).not.toContain('#C4553F')

  const near = svgAt(37)
  expect(near).toContain('<rect x="0" y="6" width="192.4" height="8" rx="4" fill="#E0B562"/>')

  // Past the marker the use shows in the deeper colour.
  const over = svgAt(43)
  expect(over).toContain('<rect x="0" y="6" width="202.8" height="8" rx="4" fill="#E08A7A"/>')
  expect(over).toContain('<rect x="202.8" y="6" width="20.8" height="8" rx="2" fill="#C4553F"/>')
  expect(over).not.toContain('#8CB88A')
})

test('the limit fills the whole bar', async () => {
  const svg = svgAt(100)
  expect(svg).toContain('<rect x="0" y="6" width="202.8" height="8" rx="4" fill="#E08A7A"/>')
  expect(svg).toContain('<rect x="202.8" y="6" width="317.2" height="8" rx="2" fill="#C4553F"/>')
})

test('a day with no share has no segment, tick or label', async () => {
  const svg = svgAt(33, { ...cfg, pins: [{ days: [6], percent: 0 }] })
  expect(svg).not.toContain('>Sat<')
  // Seven segments left, so six ticks.
  expect(count(svg, 'y1="3" x2="')).toBe(6)
})

test('an empty week draws a bar and no segments', async () => {
  const svg = svgAt(0, { ...cfg, pins: [{ days: [0, 1, 2, 3, 4, 5, 6], percent: 0 }] })
  expect(svg).toContain('width="520" height="8"')
  expect(count(svg, '<text')).toBe(0)
  expect(count(svg, 'y1="3" x2="')).toBe(0)
})
