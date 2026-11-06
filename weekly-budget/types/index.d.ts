// The plugin's contract: self-contained, so that the validator accepts it. The
// hooks modules import these types from here (hooks/lib/config.ts and plan.ts
// re-export them).

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6 // Date.getDay(): 0 is Sunday
export type Pin = { days: Weekday[]; percent: number } // a group's share, split evenly over its days
export type Mode = 'warn' | 'rewarn' | 'block'
export type StatusStyle = 'A' | 'B' | 'C'
// What becomes of what a day did not use, or used past its share: fixed lands it all
// on the next day; adaptive shares it over the unpinned days still ahead.
export type Leftover = 'fixed' | 'adaptive'
export type Config = {
  version: 1
  pins: Pin[]
  mode: Mode
  headsUpEnabled: boolean
  headsUpFraction: number // of today's share still left when the heads-up starts
  statusStyle: StatusStyle
  snoozeOptionsMin: number[]
  showCompactPanel: boolean
  leftover: Leftover
}
export type Reading = { percentUsed: number; resetsMs: number; at: number }
// What had been used when a local day of a week began, as the first reading of that day knew it.
export type DayStart = { weekKey: number; dayKey: string; percentUsed: number }

declare module 'claude-code' {
  interface PluginState {
    'weekly-budget': {
      reading: Reading | null // this session's own measured reading; the store holds the shared one
      settingsError: string | null
      pinDraftDays: string
      compactOpened: boolean // this session has opened VS Code's panel, so it never reopens one the person closed
      detailsExpanded: boolean // the panel's compact view shows its details under the bar (the toggle's state)
      compactRows: number | null // the rows the panel was last opened with: the engine's pane list has no rows
      stripHidden: boolean // the desktop strip was closed with its ✕ in this chat; /budget shows it again
      interactive: boolean // a session a person drives: only those run the /usage probe
      surface: string | null // the surface the session started on: each may be signed in to its own account
    }
  }
}
