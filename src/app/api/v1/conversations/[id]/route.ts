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
import { resolveAssignee, resolveBySalesrep, assignConversation } from '@/lib/conversations/assign';
import type { ResolvedAssignee } from '@/lib/conversations/assign';
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
 *     "assigned_salesrep_id": "<netsuite salesrep id>",
 *     "status": "open" | "pending" | "closed",
 *     "ai_autoreply_disabled": true | false
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
 *
 * `assigned_salesrep_id` is the NetSuite id of the customer's rep —
 * resolved to whichever profile claims it (`profiles.netsuite_salesrep_id`)
 * and assigned exactly like an explicit `assigned_agent_id` would be.
 * Mutually exclusive with `assigned_agent_id`: sending both is a 400,
 * because guessing which one wins is worse than rejecting the request.
 * When nobody claims the id, `resolveBySalesrep` (migration 047) tries the
 * account's designated fallback profile next; only when THAT is also
 * unset does this return `409 salesrep_not_mapped` rather than silently
 * assigning nobody — the caller decides how to route from there.
 *
 * `ai_autoreply_disabled` just writes that column; the inbox paints its
 * "Claudia IA is answering" banner off it, independent of assignment.
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
    const wantsSalesrep = 'assigned_salesrep_id' in body;
    const wantsStatus = 'status' in body;
    const wantsPause = 'ai_autoreply_disabled' in body;

    if (!wantsAssign && !wantsSalesrep && !wantsStatus && !wantsPause) {
      return fail(
        'bad_request',
        "Nothing to update: send 'assigned_agent_id', 'assigned_salesrep_id', 'status' and/or 'ai_autoreply_disabled'",
        400
      );
    }

    // Mutuamente excluyentes a propósito: con los dos puestos habría que
    // adivinar cuál gana, y adivinar a quién llega un cliente es peor
    // que rechazar la petición.
    if (wantsAssign && wantsSalesrep) {
      return fail(
        'bad_request',
        "Send either 'assigned_agent_id' or 'assigned_salesrep_id', not both",
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

    if (wantsSalesrep && typeof body.assigned_salesrep_id !== 'string') {
      return fail('bad_request', "'assigned_salesrep_id' must be a string", 400);
    }

    // Una cadena vacía (o solo espacios) no es "asígnalo a quien sea": es
    // una petición mal formada, probablemente un cliente de la API con un
    // bug. Sin este chequeo, `resolveBySalesrep` no encuentra a nadie con
    // ese id y cae al respaldo de la cuenta (migración 047), asignando la
    // conversación a alguien que nadie pidió. Se recorta primero para que
    // "  " tenga el mismo destino que "": ninguno de los dos es un id.
    const salesrepId = wantsSalesrep
      ? (body.assigned_salesrep_id as string).trim()
      : undefined;
    if (wantsSalesrep && salesrepId === '') {
      return fail(
        'bad_request',
        "'assigned_salesrep_id' must not be empty",
        400
      );
    }

    if (wantsPause && typeof body.ai_autoreply_disabled !== 'boolean') {
      return fail('bad_request', "'ai_autoreply_disabled' must be a boolean", 400);
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

    let resolved: ResolvedAssignee | undefined;

    if (wantsSalesrep) {
      resolved = await resolveBySalesrep(
        ctx.supabase,
        ctx.accountId,
        salesrepId as string
      );
      if (!resolved.ok && resolved.reason === 'salesrep_not_mapped') {
        // 409 y no 404: la conversación existe y la petición es válida;
        // lo que falta es que alguien del equipo reclame ese id. Quien
        // llama decide si reparte de otra forma — el CRM no elige por su
        // cuenta a quién mandar un cliente. El código de error ES el
        // motivo (mismo patrón que `no_agent_available` abajo), para que
        // quien llama pueda ramificar sobre `error.code` sin parsear el
        // mensaje humano.
        return fail('salesrep_not_mapped', 'No profile claims that salesrep id', 409);
      }

      // El respaldo (migración 047) es una desviación silenciosa por
      // diseño para el cliente de la API -- por eso deja rastro aquí.
      // Sin esto, la conversación de un cliente de un representante sin
      // cuenta en el CRM aparece asignada a otra persona y quien depure
      // tiene que saber de antemano que ese representante no tiene
      // cuenta y quién es su respaldo. El mapeo directo no se registra:
      // es el camino esperado, no el que hay que explicar.
      if (resolved.ok && resolved.viaFallback) {
        console.info('[api/v1/conversations] assigned_salesrep_id resolved via account fallback', {
          conversationId: id,
          requestedSalesrepId: salesrepId,
          assignedAgentId: resolved.agentId,
        });
      }
    } else if (wantsAssign && !alreadyOwned) {
      resolved = await resolveAssignee(ctx.supabase, ctx.accountId, target);

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
    }

    // Cuando esta misma petición tanto asigna como toca status/pausa,
    // ambas van en la MISMA escritura vía `assignConversation`'s `extra`.
    // Supabase no da transacciones multi-sentencia desde el cliente: dos
    // `.update()` consecutivos dejan una ventana donde, si el segundo
    // falla, la conversación queda asignada a un vendedor con la IA
    // todavía marcada activa (la bandeja miente y ambos le contestan al
    // cliente). Fusionarlas en un solo UPDATE hace esa ventana imposible:
    // o se escriben las dos cosas o no se escribe ninguna.
    if (resolved?.ok) {
      const extra: Record<string, unknown> = {};
      if (wantsStatus) extra.status = body.status;
      if (wantsPause) extra.ai_autoreply_disabled = body.ai_autoreply_disabled;

      // Writes `assigned_at` too, which is what keeps the rotation fair.
      await assignConversation(
        ctx.supabase,
        id,
        ctx.accountId,
        resolved.agentId,
        Object.keys(extra).length > 0 ? extra : undefined
      );
    } else if (wantsStatus || wantsPause) {
      const update: Record<string, unknown> = {};
      if (wantsStatus) update.status = body.status;
      if (wantsPause) update.ai_autoreply_disabled = body.ai_autoreply_disabled;

      const { error } = await ctx.supabase
        .from('conversations')
        .update(update)
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
