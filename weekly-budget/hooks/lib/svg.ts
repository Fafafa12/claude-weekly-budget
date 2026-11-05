import { DAY_NAMES } from './config'
import type { Weekday } from './config'
import type { Budget } from './plan'
import type { Tz } from './tz'

// Claude's own look, soft enough to read on a dark and a light theme: an SVG
// shown as an image can't follow the theme.
export const COLORS = {
  claude: '#D97757', // today's highlight and label, and the "allowed by tonight" marker
  track: '#B1ADA1', // the track and the ticks between days
  ok: '#8CB88A',
  near: '#E0B562',
  over: '#E08A7A',
  overDeep: '#C4553F', // use past the marker
  label: '#9A958A',
}

const HEIGHT = 34
const MIN_LABEL_WIDTH = 24

// Coordinates to at most one decimal, which is plenty for a bar a few hundred px wide.
const n1 = (n: number): string => String(Math.round(n * 10) / 10)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

type Segment = { weekday: Weekday; x: number; w: number; today: boolean }

// The bar measures the week in %, and each day's segment is as wide as its
// share of the plan: a 18% weekday is wide, a 5% weekend day thin. The marker
// lands at the end of today's segment, where the plan's "allowed by tonight" is.
// The piece weekdays are already in the caller's zone, so tz isn't needed here.
export function barSvg(b: Budget, width: number, _tz: Tz): string {
  const sumShares = b.pieces.reduce((a, p) => a + p.share, 0)
  // Positions share one scale, so used against allowed reads true even when a
  // plan pins every day and adds up to less than 100%.
  const scale = width / (sumShares > 0 ? sumShares : 100)

  const segments: Segment[] = []
  let sharesBefore = 0
  b.pieces.forEach((p, i) => {
    if (p.share <= 0) return // a 0% day has no segment
    segments.push({ weekday: p.weekday, x: sharesBefore * scale, w: p.share * scale, today: i === b.todayIndex })
    sharesBefore += p.share
  })

  const allowedX = clamp(b.allowed * scale, 0, width)
  const usedX = clamp(b.used * scale, 0, width)
  const fillColor = b.state === 'ok' ? COLORS.ok : b.state === 'near' ? COLORS.near : COLORS.over

  const rect = (x: number, y: number, w: number, h: number, rx: number, fill: string, opacity?: number): string =>
    `<rect x="${n1(x)}" y="${y}" width="${n1(w)}" height="${h}" rx="${rx}" fill="${fill}"` +
    (opacity === undefined ? '' : ` fill-opacity="${opacity}"`) +
    '/>'

  const parts: string[] = []

  const today = segments.find(s => s.today)
  if (today) parts.push(rect(today.x, 0, today.w, 20, 3, COLORS.claude, 0.14))

  parts.push(rect(0, 6, width, 8, 4, COLORS.track, 0.32))
  if (Math.min(usedX, allowedX) > 0) parts.push(rect(0, 6, Math.min(usedX, allowedX), 8, 4, fillColor))
  if (usedX > allowedX) parts.push(rect(allowedX, 6, usedX - allowedX, 8, 2, COLORS.overDeep))

  const ticks = segments.slice(1).map(s => `<line x1="${n1(s.x)}" y1="3" x2="${n1(s.x)}" y2="17"/>`)
  if (ticks.length > 0) parts.push(`<g stroke="${COLORS.track}" stroke-opacity="0.55">${ticks.join('')}</g>`)

  const labels = segments
    .filter(s => s.w >= MIN_LABEL_WIDTH)
    .map(s => {
      const x = n1(s.x + s.w / 2)
      const name = DAY_NAMES[s.weekday]
      return s.today
        ? `<text x="${x}" y="31" fill="${COLORS.claude}" font-weight="700">${name}</text>`
        : `<text x="${x}" y="31">${name}</text>`
    })
  if (labels.length > 0) {
    parts.push(`<g font-size="10" text-anchor="middle" fill="${COLORS.label}">${labels.join('')}</g>`)
  }

  parts.push(
    `<line x1="${n1(allowedX)}" y1="1" x2="${n1(allowedX)}" y2="19" stroke="${COLORS.claude}" stroke-width="2.5" stroke-linecap="round"/>`,
  )

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n1(width)}" height="${HEIGHT}" viewBox="0 0 ${n1(width)} ${HEIGHT}" ` +
    `font-family="system-ui, -apple-system, Segoe UI, sans-serif">${parts.join('')}</svg>`
  )
}
