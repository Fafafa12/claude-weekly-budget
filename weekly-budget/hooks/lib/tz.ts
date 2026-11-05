import type { Weekday } from './config'

// Everything that depends on "which local day is it" goes through a Tz, so the
// plan math stays pure and a test can pick the zone.
export type Tz = {
  midnightAfter(ms: number): number // the first local midnight after ms
  weekday(ms: number): Weekday
  dayKey(ms: number): string // YYYY-MM-DD, local
  hhmm(ms: number): string // HH:MM, local
}

const MIN_MS = 60_000
const DAY_MS = 24 * 60 * MIN_MS

const two = (n: number): string => String(n).padStart(2, '0')

// The machine's zone, through the Date local-time methods.
export const systemTz: Tz = {
  midnightAfter(ms) {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
  },
  weekday: ms => new Date(ms).getDay() as Weekday,
  dayKey(ms) {
    const d = new Date(ms)
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
  },
  hhmm(ms) {
    const d = new Date(ms)
    return `${two(d.getHours())}:${two(d.getMinutes())}`
  },
}

// A zone that never changes its offset, for tests. offsetMin 180 is UTC+3.
export function fixedOffsetTz(offsetMin: number): Tz {
  const shift = offsetMin * MIN_MS
  const local = (ms: number): Date => new Date(ms + shift)
  return {
    midnightAfter: ms => (Math.floor((ms + shift) / DAY_MS) + 1) * DAY_MS - shift,
    weekday: ms => local(ms).getUTCDay() as Weekday,
    dayKey: ms => local(ms).toISOString().slice(0, 10),
    hhmm: ms => local(ms).toISOString().slice(11, 16),
  }
}
