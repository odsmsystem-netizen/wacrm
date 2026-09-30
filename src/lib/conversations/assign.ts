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
 * assignment. Only `agent` members take part: owners and admins are
 * left out of the automatic rotation (migration 041), because a
 * customer handed to someone who doesn't work the inbox waits on a
 * reply that isn't coming. Assigning by hand still works for any role.
 *
 * Returns null when the account has no `agent` at all. Callers must
 * treat that as "couldn't assign", never as an error — it's a real
 * state, not a malfunction.
 */
export async function pickNextAgent(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data, error } = await db.rpc('pick_next_agent', {
    p_account_id: accountId,
  });
  // Throws instead of returning null, because the two mean opposite
  // things. Null is a real, benign state: the account has no agent yet.
  // An RPC error is a malfunction — a missing GRANT (the bug migration
  // 031 exists for), the function gone, the database unreachable.
  // Collapsing them made every failure read as "nobody was available",
  // which the automation engine then logged as a SUCCESSFUL step.
  // Nobody would ever have looked.
  if (error) {
    throw new Error(`pick_next_agent failed: ${error.message}`);
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

/**
 * What `resolveAssignee` concluded.
 *
 * `viaFallback` is required, not optional, on purpose: every place that
 * builds an `{ ok: true }` result has to say explicitly whether this
 * agent was who was actually asked for or the account's designated
 * catch-all. Making it optional would let a future resolver (say, one
 * more routing rule added next to `resolveBySalesrep`) forget the field
 * entirely and have it silently read as "not a fallback" — the same
 * class of silent-default bug the `error` checks elsewhere in this file
 * exist to avoid.
 */
export type ResolvedAssignee =
  | { ok: true; agentId: string | null; viaFallback: boolean }
  /** `'auto'` ran and the account has nobody eligible. */
  | { ok: false; reason: 'no_agent_available' }
  /** An explicit id that doesn't belong to this account. */
  | { ok: false; reason: 'not_a_member' }
  /** A NetSuite salesrep id that no profile in this account claims. */
  | { ok: false; reason: 'salesrep_not_mapped' };

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
  if (target === null) return { ok: true, agentId: null, viaFallback: false };

  if (target === 'auto') {
    const agentId = await pickNextAgent(db, accountId);
    return agentId
      ? { ok: true, agentId, viaFallback: false }
      : { ok: false, reason: 'no_agent_available' };
  }

  if (!(await isAccountMember(db, accountId, target))) {
    return { ok: false, reason: 'not_a_member' };
  }
  return { ok: true, agentId: target, viaFallback: false };
}

/**
 * Resolve a NetSuite salesrep id into the profile that claims it.
 *
 * Scoped by account because those ids are only unique inside the
 * NetSuite instance that issued them — two accounts could legitimately
 * use the same one.
 *
 * Of NetSuite's real salesreps, 4 have a customer portfolio but will
 * never get a wacrm account (product decision: one existing agent
 * already covers them, so creating accounts nobody will log into isn't
 * worth it). Without a fallback, those customers' conversations came
 * back `salesrep_not_mapped`, the caller retried without a rep, and the
 * conversation landed on whoever the round-robin happened to pick —
 * i.e. anyone but the person who actually handles that account.
 */
export async function resolveBySalesrep(
  db: SupabaseClient,
  accountId: string,
  salesrepId: string
): Promise<ResolvedAssignee> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('netsuite_salesrep_id', salesrepId)
    .maybeSingle();

  // Same failure-mode split as `pickNextAgent` above: a query error is a
  // malfunction (bad GRANT, connection lost, RLS misconfigured) and must
  // not collapse into "nobody claims this id". `salesrep_not_mapped` tells
  // a caller "go register that rep"; a swallowed DB error would tell them
  // the same thing while the actual problem — the database — goes
  // unnoticed, same as the bug migration 031 exists for.
  if (error) {
    throw new Error(`resolveBySalesrep failed: ${error.message}`);
  }

  if (data?.user_id) {
    return { ok: true, agentId: data.user_id, viaFallback: false };
  }

  // Nobody claims that id directly. Before giving up, check whether this
  // account designated a catch-all (migration 047). Most accounts won't
  // have one — that's fine, `salesrep_not_mapped` below still covers it —
  // but the ones that do get their unmapped reps routed on purpose
  // instead of by whatever the round-robin lands on.
  const { data: fallback, error: fallbackError } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('is_salesrep_fallback', true)
    .maybeSingle();

  // Same reasoning as the `error` check above, applied to this second
  // query: a broken lookup here must not read as "this account has no
  // fallback" either, or a bad GRANT on this new column would silently
  // widen back into the random-assignment bug this feature exists to
  // close, with nothing in the logs to say why.
  if (fallbackError) {
    throw new Error(`resolveBySalesrep failed: ${fallbackError.message}`);
  }

  if (fallback?.user_id) {
    // `viaFallback: true` instead of returning the fallback the same way
    // as a direct match: a silent fallback is one nobody can diagnose.
    // Without this flag, a conversation from one of Eva's customers
    // shows up assigned to Pablo with no trace of why — whoever debugs
    // it has to already know Eva has no CRM account and that Pablo is
    // her stand-in. The flag lets that reasoning live in the code path
    // instead of in someone's head.
    return { ok: true, agentId: fallback.user_id, viaFallback: true };
  }

  return { ok: false, reason: 'salesrep_not_mapped' };
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
 *
 * `extra` folds additional columns into this SAME update — e.g. a public
 * API PATCH that assigns a salesrep's mapped agent AND sets
 * `ai_autoreply_disabled` in one request. Supabase gives us no
 * multi-statement transaction from the client, so the only way to avoid a
 * window where the assignment lands but the pause doesn't (inbox says
 * "assigned" while Claudia is still answering) is to make it ONE write
 * instead of two. Don't split `extra` back out into a second `.update()` —
 * that's the exact bug this parameter exists to close.
 */
export async function assignConversation(
  db: SupabaseClient,
  conversationId: string,
  accountId: string,
  agentId: string | null,
  extra?: Record<string, unknown>,
  onlyIfUnassigned = false
): Promise<boolean> {
  let q = db
    .from('conversations')
    .update({
      assigned_agent_id: agentId,
      // Cleared on release: a conversation nobody owns has no
      // assignment time, and leaving a stale one would let the
      // round-robin think that agent was served more recently than
      // they were.
      assigned_at: agentId ? new Date().toISOString() : null,
      ...extra,
    })
    .eq('id', conversationId)
    .eq('account_id', accountId);

  // `onlyIfUnassigned` cierra la carrera entre "miré y no tenía dueño" y
  // "se lo asigné". El endpoint lee la conversación para decidir si ya la
  // tiene un humano, pero entre esa lectura y esta escritura alguien pudo
  // pulsar «Tomar control». Comprobarlo en el WHERE hace que la condición
  // y la escritura ocurran a la vez: o sigue libre y se asigna, o ya no lo
  // está y no se toca nada. Solo aplica a las asignaciones automáticas —
  // "auto" y el salesrep del bot—; un id explícito es una persona
  // decidiendo, y esa sí puede reasignar.
  if (onlyIfUnassigned) q = q.is('assigned_agent_id', null);

  const { data, error } = await q.select('id');

  if (error) {
    console.error('[assign] update failed:', error);
    throw error;
  }
  // false = no se escribió nada: la conversación no existe, es de otra
  // cuenta, o —con onlyIfUnassigned— alguien la tomó primero. Quien llama
  // TIENE que mirar esto: ignorarlo es reportar un éxito que no ocurrió.
  return (data?.length ?? 0) > 0;
}
