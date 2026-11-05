// The plugin's contract: self-contained, so that the validator accepts it. The
// hooks modules import these types from here (hooks/lib/config.ts and plan.ts
// re-export them).

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6 // Date.getDay(): 0 is Sunday
export type Pin = { days: Weekday[]; percent: number } // a group's share, split evenly over its days
export type Mode = 'warn' | 'rewarn' | 'block'
export type StatusStyle = 'A' | 'B' | 'C'
export type Config = {
  version: 1
  pins: Pin[]
  mode: Mode
  headsUpEnabled: boolean
  headsUpFraction: number // of today's share still left when the heads-up starts
  statusStyle: StatusStyle
  snoozeOptionsMin: number[]
  showCompactPanel: boolean
}
export type Reading = { percentUsed: number; resetsMs: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'weekly-budget': {
      reading: Reading | null // this session's own measured reading; the store holds the shared one
      settingsError: string | null
      pinDraftDays: string
      compactOpened: boolean // this session has opened the compact pane, so it never reopens one the person closed
    }
  }
}
