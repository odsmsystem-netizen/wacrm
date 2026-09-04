// ============================================================
// Assigning a conversation to an agent.
//
// One place, because three callers need it and they used to disagree:
// the inbox assigns by hand, the automation engine claimed to
// round-robin but always picked the same person, and the public API
// couldn't assign at all.
//
// Every assignment goes through here so `assigned_at` is always written
// alongside `assigned_agent_id` — the round-robin reads that column to
// know whose turn it is, and an assignment that skips it makes the
// rotation drift toward whoever was assigned without it.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

/** Who to assign to: a specific agent, the next one in turn, or nobody. */
export type AssignTarget = string | 'auto' | null;

/**
 * The next agent in turn — whoever has gone longest without an
 * assignment. Returns null when the account has nobody eligible
 * (viewers don't count: they can read the inbox but not reply).
 *
 * Callers must treat null as "couldn't assign", never as an error: an
 * account with a single viewer is unusual but not broken.
 */
export async function pickNextAgent(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data, error } = await db.rpc('pick_next_agent', {
    p_account_id: accountId,
  });
  if (error) {
    console.error('[assign] pick_next_agent failed:', error);
    return null;
  }
  return (data as string | null) ?? null;
}

/**
 * True when `userId` is a member of `accountId`.
 *
 * Every caller that accepts an agent id from outside must check this.
 * `conversations.assigned_agent_id` has no foreign key, and the API runs
 * under the service role — so RLS won't catch a foreign id either.
 * Without the check, one account can point a conversation at a user of
 * another, and the assignment trigger from migration 027 then delivers
 * that user a notification carrying this account's contact name.
 */
export async function isAccountMember(
  db: SupabaseClient,
  accountId: string,
  userId: string
): Promise<boolean> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

/** What `resolveAssignee` concluded. */
export type ResolvedAssignee =
  | { ok: true; agentId: string | null }
  /** `'auto'` ran and the account has nobody eligible. */
  | { ok: false; reason: 'no_agent_available' }
  /** An explicit id that doesn't belong to this account. */
  | { ok: false; reason: 'not_a_member' };

/**
 * Resolve `target` into a concrete agent id (or null to unassign).
 * `'auto'` asks the round-robin; an explicit id is checked against the
 * account first.
 */
export async function resolveAssignee(
  db: SupabaseClient,
  accountId: string,
  target: AssignTarget
): Promise<ResolvedAssignee> {
  if (target === null) return { ok: true, agentId: null };

  if (target === 'auto') {
    const agentId = await pickNextAgent(db, accountId);
    return agentId
      ? { ok: true, agentId }
      : { ok: false, reason: 'no_agent_available' };
  }

  if (!(await isAccountMember(db, accountId, target))) {
    return { ok: false, reason: 'not_a_member' };
  }
  return { ok: true, agentId: target };
}

/**
 * Write the assignment. `agentId` null releases the conversation.
 *
 * Scoped by `account_id` as well as `id` so a conversation belonging to
 * another account can't be reassigned even if its id leaks — the same
 * guard every other account-scoped write in this codebase uses.
 *
 * Returns false when nothing was updated (wrong account, or the
 * conversation doesn't exist), so callers can answer 404 rather than
 * reporting a success that never happened.
 */
export async function assignConversation(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
  agentId: string | null
): Promise<boolean> {
  const { data, error } = await db
    .from('conversations')
    .update({
      assigned_agent_id: agentId,
      // Cleared on release: a conversation nobody owns has no
      // assignment time, and leaving a stale one would let the
      // round-robin think that agent was served more recently than
      // they were.
      assigned_at: agentId ? new Date().toISOString() : null,
    })
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .select('id');

  if (error) {
    console.error('[assign] update failed:', error);
    throw error;
  }
  return (data?.length ?? 0) > 0;
}
