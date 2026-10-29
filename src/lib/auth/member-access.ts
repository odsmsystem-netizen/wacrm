// ============================================================
// Owner-only member access tools: reset a password / block sign-in.
//
// Why it exists: Supabase's built-in SMTP only delivers to members of the
// Supabase organization, so "forgot password" emails never reach most of
// the team. The owner needs a way to rescue an account without email.
//
// Both actions run on the service-role client (auth.admin.*), so the
// authorisation lives in the routes (`requireRole('owner')`) and in
// `loadTargetMember` below — never trust the UI to hide the buttons.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { supabaseAuthAdmin } from './admin-client'
import { isAccountRole, type AccountRole } from './roles'

/** auth.admin.updateUserById `ban_duration`: effectively "until undone". */
export const BLOCK_DURATION = '876000h' // ~100 years
export const UNBLOCK_DURATION = 'none'

// uuid v4 plus the looser shape Postgres gen_random_uuid emits — just
// enough to reject "../etc/passwd"-style ids before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A request the owner can't make (maps straight onto an HTTP status). */
export class MemberTargetError extends Error {
  constructor(
    public readonly status: 400 | 404,
    message: string,
  ) {
    super(message)
    this.name = 'MemberTargetError'
  }
}

/**
 * Link the owner hands to the member. It lands on /auth/callback, which
 * trades the `token_hash` for a session (verifyOtp, no PKCE cookie needed)
 * and forwards to /reset-password, where the member picks their own password.
 */
export function buildRecoveryLink(origin: string, hashedToken: string): string {
  const params = new URLSearchParams({
    token_hash: hashedToken,
    type: 'recovery',
    next: '/reset-password',
  })
  // URLSearchParams encodes spaces as "+"; a token should never contain one,
  // but keep the output unambiguous if it ever does.
  return `${origin}/auth/callback?${params.toString().replace(/\+/g, '%20')}`
}

export interface TargetMember {
  userId: string
  role: AccountRole
}

/**
 * Resolve the member the owner is acting on and refuse the cases that must
 * never happen: not a UUID, not in the caller's account, the caller
 * themselves, or another owner. The lookup is scoped to the caller's
 * account, so a member of a different account is indistinguishable from a
 * missing one (404).
 */
export async function loadTargetMember(
  ctx: { supabase: SupabaseClient; accountId: string; userId: string },
  targetUserId: string,
): Promise<TargetMember> {
  if (!UUID_RE.test(targetUserId)) {
    throw new MemberTargetError(404, 'Member not found')
  }

  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('user_id, account_role')
    .eq('user_id', targetUserId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()

  if (error) {
    console.error('[member-access] target lookup error:', error)
    throw new MemberTargetError(404, 'Member not found')
  }
  if (!data || !isAccountRole(data.account_role)) {
    throw new MemberTargetError(404, 'Member not found')
  }
  if (data.user_id === ctx.userId) {
    throw new MemberTargetError(400, 'You cannot do this to yourself')
  }
  if (data.account_role === 'owner') {
    throw new MemberTargetError(400, 'The account owner cannot be targeted')
  }

  return { userId: data.user_id, role: data.account_role }
}

/**
 * Which of these users are currently blocked. Reads `banned_until` from
 * Supabase Auth — the same source that actually enforces the block — so the
 * roster can never disagree with reality. One lookup per member (an account
 * has a handful), each isolated: a failed lookup logs and counts as "not
 * blocked" rather than taking the whole list down.
 */
export async function loadBlockedUserIds(userIds: string[]): Promise<Set<string>> {
  const blocked = new Set<string>()
  if (userIds.length === 0) return blocked

  let admin: SupabaseClient
  try {
    admin = supabaseAuthAdmin()
  } catch (err) {
    console.error('[member-access] auth admin client unavailable:', err)
    return blocked
  }

  const now = Date.now()
  await Promise.all(
    userIds.map(async (id) => {
      try {
        const { data } = await admin.auth.admin.getUserById(id)
        const until = data?.user?.banned_until
        if (until && new Date(until).getTime() > now) blocked.add(id)
      } catch (err) {
        console.error('[member-access] could not read ban state:', err)
      }
    }),
  )
  return blocked
}
