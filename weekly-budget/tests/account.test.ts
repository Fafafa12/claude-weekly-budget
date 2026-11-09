import { expect, test } from 'claude-code/testing'

import { accountLabel, parseProfile, parseUsageApi } from '../hooks/lib/account'

// The shapes Anthropic's account addresses answered on 2026-11-06 (trimmed, made up).
const PROFILE = {
  account: { uuid: 'acc-1', full_name: 'Alex R', display_name: 'Alex', email: 'you@acme.dev' },
  organization: { uuid: 'org-1', name: 'Acme', organization_type: 'claude_team' },
}
const PERSONAL = {
  account: { uuid: 'acc-2', display_name: 'Alex', email: 'you@example.com' },
  organization: { uuid: 'org-2', name: "you@example.com's Organization", organization_type: 'claude_pro' },
}
const USAGE = {
  five_hour: { utilization: 12, resets_at: '2026-11-06T13:00:00+00:00' },
  seven_day: { utilization: 54, resets_at: '2026-11-10T17:00:00.460074+00:00' },
}
const now = Date.parse('2026-11-06T09:00:00Z')

test('parseProfile reads who the chat is signed in as', async () => {
  expect(parseProfile(PROFILE)).toEqual({
    id: 'acc-1',
    email: 'you@acme.dev',
    name: 'Alex',
    organization: 'Acme',
    organizationType: 'claude_team',
  })
  expect(parseProfile({ account: { email: 'x@y' } })).toBeNull() // no id
  expect(parseProfile('nope')).toBeNull()
})

test('accountLabel names a team account by its organization, and any by its email', async () => {
  expect(accountLabel(parseProfile(PROFILE))).toBe('Acme (you@acme.dev)')
  expect(accountLabel(parseProfile(PERSONAL))).toBe('you@example.com')
  expect(accountLabel(null)).toBeNull()
})

test('parseUsageApi reads the week, with its exact reset', async () => {
  // The reset is taken to the nearest minute, as a reply's is, so both name the same
  // week: the address may give it a moment before the minute or after.
  expect(parseUsageApi(USAGE, now)).toEqual({ percentUsed: 54, resetsMs: Date.parse('2026-11-10T17:00:00Z'), at: now })
  expect(parseUsageApi({ seven_day: { utilization: 54, resets_at: '2026-11-10T16:59:59.723+00:00' } }, now)?.resetsMs).toBe(
    Date.parse('2026-11-10T17:00:00Z'),
  )
  expect(parseUsageApi({ seven_day: { utilization: 54.25, resets_at: '2026-11-10T17:00:00Z' } }, now)?.percentUsed).toBe(54.3)
  expect(parseUsageApi({ seven_day: null }, now)).toBeNull()
  expect(parseUsageApi({ seven_day: { utilization: 'x', resets_at: '2026-11-10T17:00:00Z' } }, now)).toBeNull()
  expect(parseUsageApi({ seven_day: { utilization: 54, resets_at: 'soon' } }, now)).toBeNull()
})
