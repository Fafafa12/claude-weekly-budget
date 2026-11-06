import type { Account } from '../../types'
import type { Reading } from './plan'

// Who a chat is signed in as, and its account's weekly usage, as Anthropic's own
// account addresses answer them: asked with the chat's own login through the sealed
// handle $.session.authorize() gives (the plugin never holds the token). These
// addresses are not documented for plugins, so an answer of another shape is none,
// and the plugin falls back to what replies and /usage tell it.
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
export const OAUTH_HEADERS: Readonly<Record<string, string>> = { 'anthropic-beta': 'oauth-2025-04-20' }

// Account lives in the plugin's contract, types/index.d.ts.
export type { Account }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function parseProfile(v: unknown): Account | null {
  if (!isObj(v) || !isObj(v.account)) return null
  const id = str(v.account.uuid)
  if (id === null) return null
  const org = isObj(v.organization) ? v.organization : {}
  return {
    id,
    email: str(v.account.email),
    name: str(v.account.display_name) ?? str(v.account.full_name),
    organization: str(org.name),
    organizationType: str(org.organization_type),
  }
}

// How the account is named on screen: a team's by its organization and email, any
// other by its email (a personal account's "organization" is only its own name).
export function accountLabel(a: Account | null): string | null {
  if (a === null) return null
  const email = a.email ?? a.name ?? a.id
  const isTeam = a.organizationType !== null && /team|enterprise/.test(a.organizationType)
  return isTeam && a.organization !== null ? `${a.organization} (${email})` : email
}

// The week out of the usage answer: its figure to one decimal, and its reset cut to
// whole seconds, as replies report it, so that both name the same week.
export function parseUsageApi(v: unknown, at: number): Reading | null {
  if (!isObj(v) || !isObj(v.seven_day)) return null
  const { utilization, resets_at } = v.seven_day
  if (typeof utilization !== 'number' || !Number.isFinite(utilization) || typeof resets_at !== 'string') return null
  const resetsMs = Date.parse(resets_at)
  if (Number.isNaN(resetsMs)) return null
  return { percentUsed: Math.round(utilization * 10) / 10, resetsMs: Math.floor(resetsMs / 1000) * 1000, at }
}
