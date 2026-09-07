// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Two orderings, and picking the wrong one silently loses customers.
//
// Default (`sort=created`): newest THREADS first, keyset-paginated.
// Right for browsing the account's history.
//
// `sort=activity`: newest MESSAGES first. This is what a poller wants.
// A conversation row is created once per contact and reused forever
// (see resolve-conversation.ts), so under the default ordering a
// long-standing customer who writes today still sits wherever their
// thread was created — page 5, say. A caller reading only the first
// page would never see them write again, with no error to notice.
//
// `sort=activity` is not paginated: the cursor is built on
// `(created_at, id)` and would walk the wrong axis. Ask for the top N
// with `?limit=` (max 100) — if more than 100 conversations move
// between two polls, the poller is too slow regardless of paging.
//
// Filters: `?status=` (open/pending/closed) and `?contact_id=`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import { serializeConversation } from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', ctx.accountId);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);

    // `nullsFirst: false` matters: a conversation with no messages yet
    // has a null `last_message_at`, and those belong at the end — not
    // ahead of threads that just moved.
    const byActivity = url.searchParams.get('sort') === 'activity';

    query = byActivity
      ? query
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false })
          .limit(limit)
      : query
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(limit + 1);

    // The cursor encodes `(created_at, id)`, so it only applies to the
    // default ordering. Under `sort=activity` it would filter on the
    // wrong axis and skip rows silently.
    const kf = byActivity ? null : keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = byActivity
      ? { items: data ?? [], nextCursor: null }
      : buildPage(
          (data ?? []) as Array<{ created_at: string; id: string }>,
          limit
        );
    return okList(
      items.map((r) =>
        serializeConversation(normalizeConversation(r as Conversation))
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
