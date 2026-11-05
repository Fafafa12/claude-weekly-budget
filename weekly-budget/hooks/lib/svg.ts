import type { Weekday } from './config'
import type { Budget } from './plan'

// Claude's own look, soft enough to read on a dark and a light theme: an SVG
// shown as an image can't follow the theme.
export const COLORS = {
  claude: '#D97757', // today's highlight and the "allowed by tonight" marker
  track: '#B1ADA1', // the track and the ticks between days
  ok: '#8CB88A',
  near: '#E0B562',
  over: '#E08A7A',
  overDeep: '#C4553F', // use past the marker
  label: '#9A958A',
}

// The bar is drawn on a grid 1000 wide (10 a percent) and stretched, unevenly, to
// whatever width the panel gives it: VS Code tells a plugin its panel's width only
// in code-font cells, not pixels. So nothing in it may be text, which would stretch
// too; the weekday labels are drawn under it, as wide as the segments (barSegments).
const GRID = 1000
const HEIGHT = 20

// A segment narrower than this, in % of the bar, has no room for its label: about
// 24px of a 520px bar.
export const MIN_LABEL_SHARE = 4.6

// Coordinates to at most one decimal.
const n1 = (n: number): string => String(Math.round(n * 10) / 10)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

// Lines keep their width however far the bar is stretched.
const KEEP_STROKE = 'vector-effect="non-scaling-stroke"'

export type BarSegment = { weekday: Weekday; width: number; isToday: boolean }

// The bar measures the week in %, and each day's segment is as wide as its share of
// the plan: a 18% weekday is wide, a 5% weekend day thin. Widths are in % of the bar,
// on one scale with used and allowed, so they read true even when a plan pins every
// day and adds up to less than 100%. A 0% day has no segment.
export function barSegments(b: Budget): BarSegment[] {
  const sum = b.pieces.reduce((a, p) => a + p.share, 0)
  const scale = 100 / (sum > 0 ? sum : 100)
  return b.pieces.flatMap((p, i) =>
    p.share > 0 ? [{ weekday: p.weekday, width: p.share * scale, isToday: i === b.todayIndex }] : [],
  )
}

// The marker lands at the end of today's segment, where the plan's "allowed by
// tonight" is.
export function barSvg(b: Budget): string {
  const sum = b.pieces.reduce((a, p) => a + p.share, 0)
  const scale = GRID / (sum > 0 ? sum : 100)
  const segments = barSegments(b)

  const allowedX = clamp(b.allowed * scale, 0, GRID)
  const usedX = clamp(b.used * scale, 0, GRID)
  const fillColor = b.state === 'ok' ? COLORS.ok : b.state === 'near' ? COLORS.near : COLORS.over

  const rect = (x: number, y: number, w: number, h: number, rx: number, fill: string, opacity?: number): string =>
    `<rect x="${n1(x)}" y="${y}" width="${n1(w)}" height="${h}" rx="${rx}" fill="${fill}"` +
    (opacity === undefined ? '' : ` fill-opacity="${opacity}"`) +
    '/>'

  // Where each segment starts, on the grid.
  const starts: number[] = []
  segments.reduce((x, s) => (starts.push(x), x + (s.width * GRID) / 100), 0)

  const parts: string[] = []

  const today = segments.findIndex(s => s.isToday)
  const todaySegment = segments[today]
  if (todaySegment !== undefined) {
    parts.push(rect(starts[today] ?? 0, 0, (todaySegment.width * GRID) / 100, HEIGHT, 3, COLORS.claude, 0.14))
  }

  parts.push(rect(0, 6, GRID, 8, 4, COLORS.track, 0.32))
  if (Math.min(usedX, allowedX) > 0) parts.push(rect(0, 6, Math.min(usedX, allowedX), 8, 4, fillColor))
  if (usedX > allowedX) parts.push(rect(allowedX, 6, usedX - allowedX, 8, 2, COLORS.overDeep))

  const ticks = starts.slice(1).map(x => `<line x1="${n1(x)}" y1="3" x2="${n1(x)}" y2="17" ${KEEP_STROKE}/>`)
  if (ticks.length > 0) parts.push(`<g stroke="${COLORS.track}" stroke-opacity="0.55">${ticks.join('')}</g>`)

  parts.push(
    `<line x1="${n1(allowedX)}" y1="1" x2="${n1(allowedX)}" y2="19" stroke="${COLORS.claude}" stroke-width="2.5" stroke-linecap="round" ${KEEP_STROKE}/>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${GRID}" height="${HEIGHT}" viewBox="0 0 ${GRID} ${HEIGHT}" preserveAspectRatio="none">` +
    `${parts.join('')}</svg>`
  )
}
