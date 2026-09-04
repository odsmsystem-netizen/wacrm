// ============================================================
// POST /api/v1/deals — create a deal on the pipeline
// (scope: deals:write)
//
// Exists so something outside wacrm — an AI agent handling WhatsApp,
// a quoting tool, an ERP — can put a quote on the board where the
// sales team already works, instead of it living only in the other
// system. The deal shows up in the contact's sidebar next to their
// conversation.
//
// Pipeline and stage are optional: an external caller usually has no
// idea what the account's board looks like, so leaving them out picks
// the first pipeline and its first stage. Passing them explicitly
// still works when the caller does know.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import type { SupabaseClient } from '@supabase/supabase-js';

interface DefaultBoard {
  pipelineId: string;
  stageId: string;
}

/**
 * The account's first pipeline and its first stage — where a deal lands
 * when the caller didn't say. Null when the account has no pipeline at
 * all, which is a real state (a fresh account) and not an error the
 * caller caused.
 */
async function defaultBoard(
  db: SupabaseClient,
  accountId: string
): Promise<DefaultBoard | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!pipeline) return null;

  // `position` is what the board is ordered by on screen, so the first
  // stage here is the leftmost column the team sees — "New Lead" on a
  // default board.
  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!stage) return null;

  return { pipelineId: pipeline.id, stageId: stage.id };
}

/**
 * `deals.user_id` is NOT NULL and means "who owns this row" for audit.
 * The key's creator is the honest answer, but they may have been
 * removed since (`createdBy` is null then), so fall back to the
 * account's owner rather than failing a legitimate write.
 */
async function ownerUserId(
  db: SupabaseClient,
  accountId: string,
  createdBy: string | null
): Promise<string | null> {
  if (createdBy) return createdBy;
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('account_role', 'owner')
    .limit(1)
    .maybeSingle();
  return data?.user_id ?? null;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'deals:write');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Invalid JSON body', 400);
    }

    const contactId =
      typeof body.contact_id === 'string' ? body.contact_id.trim() : '';
    if (!contactId) {
      return fail('bad_request', "'contact_id' is required", 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      return fail('bad_request', "'title' is required", 400);
    }

    let value = 0;
    if (body.value !== undefined && body.value !== null) {
      value = Number(body.value);
      if (!Number.isFinite(value) || value < 0) {
        return fail('bad_request', "'value' must be a non-negative number", 400);
      }
    }

    // The contact must belong to this account — otherwise a leaked id
    // would let one account attach deals to another's contacts.
    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!contact) return fail('not_found', 'Contact not found', 404);

    let pipelineId =
      typeof body.pipeline_id === 'string' ? body.pipeline_id : null;
    let stageId = typeof body.stage_id === 'string' ? body.stage_id : null;

    if (!pipelineId || !stageId) {
      const board = await defaultBoard(ctx.supabase, ctx.accountId);
      if (!board) {
        return fail(
          'no_pipeline',
          'This account has no pipeline with stages yet — create one first, or pass pipeline_id and stage_id',
          409
        );
      }
      pipelineId = pipelineId ?? board.pipelineId;
      stageId = stageId ?? board.stageId;
    }

    // The pipeline must be this account's. `pipeline_stages` has no
    // `account_id` of its own — it inherits tenancy through its pipeline
    // — so checking only that the stage belongs to the pipeline would
    // still let a caller file a deal onto another account's board with
    // a guessed or leaked id.
    const { data: pipeline } = await ctx.supabase
      .from('pipelines')
      .select('id')
      .eq('id', pipelineId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (!pipeline) {
      return fail('bad_request', "'pipeline_id' not found", 400);
    }

    // And the stage must belong to that pipeline, or the deal lands on a
    // board where nobody can see it.
    const { data: stage } = await ctx.supabase
      .from('pipeline_stages')
      .select('id')
      .eq('id', stageId)
      .eq('pipeline_id', pipelineId)
      .maybeSingle();
    if (!stage) {
      return fail(
        'bad_request',
        "'stage_id' does not belong to that pipeline",
        400
      );
    }

    const userId = await ownerUserId(ctx.supabase, ctx.accountId, ctx.createdBy);
    if (!userId) {
      return fail('internal', 'Could not resolve an owner for this deal', 500);
    }

    // One currency per account (issue #218): the account's setting wins
    // over the column default, so an API-created deal reads the same as
    // one made by hand.
    const { data: acct } = await ctx.supabase
      .from('accounts')
      .select('default_currency')
      .eq('id', ctx.accountId)
      .maybeSingle();

    const { data: deal, error } = await ctx.supabase
      .from('deals')
      .insert({
        account_id: ctx.accountId,
        user_id: userId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        conversation_id:
          typeof body.conversation_id === 'string' ? body.conversation_id : null,
        title,
        value,
        currency: acct?.default_currency ?? 'USD',
        notes: typeof body.notes === 'string' ? body.notes : null,
        status: 'open',
      })
      .select('id, title, value, currency, status, pipeline_id, stage_id, contact_id, conversation_id, created_at')
      .single();

    if (error) {
      console.error('[api/v1/deals] insert error:', error);
      return fail('internal', 'Failed to create deal', 500);
    }

    return ok(deal, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
