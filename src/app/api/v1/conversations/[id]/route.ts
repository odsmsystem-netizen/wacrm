// ============================================================
// GET   /api/v1/conversations/{id} — read one conversation
//                                    (scope: conversations:read)
// PATCH /api/v1/conversations/{id} — assign / release, change status
//                                    (scope: conversations:write)
// Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import { resolveAssignee, assignConversation } from '@/lib/conversations/assign';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Conversation } from '@/types';

const VALID_STATUS = ['open', 'pending', 'closed'] as const;

/** Both handlers return the same shape, so they read it the same way. */
function readConversation(
  db: SupabaseClient,
  accountId: string,
  id: string
) {
  return db
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const { data, error } = await readConversation(ctx.supabase, ctx.accountId, id);

    if (error) {
      console.error('[api/v1/conversations] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!data) return fail('not_found', 'Conversation not found', 404);

    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

/**
 * PATCH /api/v1/conversations/{id}   (scope: conversations:write)
 *
 * Body (every field optional; at least one required):
 *   {
 *     "assigned_agent_id": "<uuid>" | "auto" | null,
 *     "status": "open" | "pending" | "closed"
 *   }
 *
 * `"auto"` hands the choice to the round-robin: the agent who has gone
 * longest without an assignment (migration 040). It exists so an
 * external caller can assign without first learning who the account's
 * agents are — which would otherwise need a second endpoint exposing
 * the team roster.
 *
 * `null` releases the conversation.
 *
 * `"auto"` on a conversation that already has an agent is a no-op: the
 * caller is saying "nobody picked this up", and between them checking
 * and this request arriving, somebody may have. An explicit agent id
 * does reassign — that's a person deciding, not a timer.
 *
 * Assigning refreshes `assigned_at`, so don't call it on a loop with an
 * explicit id or that agent keeps going to the back of the queue.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Invalid JSON body', 400);
    }

    const wantsAssign = 'assigned_agent_id' in body;
    const wantsStatus = 'status' in body;
    if (!wantsAssign && !wantsStatus) {
      return fail(
        'bad_request',
        "Nothing to update: send 'assigned_agent_id' and/or 'status'",
        400
      );
    }

    if (wantsStatus && !VALID_STATUS.includes(body.status)) {
      return fail(
        'bad_request',
        `'status' must be one of: ${VALID_STATUS.join(', ')}`,
        400
      );
    }

    const target = body.assigned_agent_id;
    if (
      wantsAssign &&
      target !== null &&
      target !== 'auto' &&
      typeof target !== 'string'
    ) {
      return fail(
        'bad_request',
        "'assigned_agent_id' must be an agent id, \"auto\", or null",
        400
      );
    }

    // Existence + ownership first, so a foreign id gets 404 rather than
    // a silent no-op that looks like success. `assigned_agent_id` comes
    // along because "auto" needs to know whether someone already has it.
    const { data: existing, error: readErr } = await ctx.supabase
      .from('conversations')
      .select('id, assigned_agent_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (readErr) {
      console.error('[api/v1/conversations] patch read error:', readErr);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!existing) return fail('not_found', 'Conversation not found', 404);

    // "auto" never takes a conversation away from whoever already has
    // it. The caller asking for it is saying "nobody picked this up" —
    // and between them checking and this request landing, somebody may
    // have. Silently reassigning would pull a customer away from the
    // agent already typing to them.
    const alreadyOwned = wantsAssign && target === 'auto' && existing.assigned_agent_id;

    if (wantsAssign && !alreadyOwned) {
      const resolved = await resolveAssignee(ctx.supabase, ctx.accountId, target);

      if (!resolved.ok) {
        // Nobody eligible — an account whose only members are viewers,
        // say. Not the caller's fault, so it gets its own code: retrying
        // won't help until someone adds an agent.
        if (resolved.reason === 'no_agent_available') {
          return fail(
            'no_agent_available',
            'No agent is available to take this conversation',
            409
          );
        }
        // An agent id from another account. Answered as a bad request
        // rather than 403: from the caller's side that id simply isn't
        // a valid assignee here, and saying more would confirm that the
        // user exists somewhere else.
        return fail(
          'bad_request',
          "'assigned_agent_id' is not a member of this account",
          400
        );
      }

      // Writes `assigned_at` too, which is what keeps the rotation fair.
      await assignConversation(ctx.supabase, id, ctx.accountId, resolved.agentId);
    }

    if (wantsStatus) {
      const { error } = await ctx.supabase
        .from('conversations')
        .update({ status: body.status })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (error) {
        console.error('[api/v1/conversations] status update error:', error);
        return fail('internal', 'Failed to update conversation', 500);
      }
    }

    // Return the conversation as it now stands, so the caller doesn't
    // have to guess who "auto" picked.
    const { data, error } = await readConversation(ctx.supabase, ctx.accountId, id);
    if (error || !data) {
      console.error('[api/v1/conversations] re-read error:', error);
      return fail('internal', 'Updated, but failed to read it back', 500);
    }
    return ok(serializeConversation(normalizeConversation(data as Conversation)));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
