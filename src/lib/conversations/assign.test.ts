import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveAssignee, resolveBySalesrep, assignConversation } from './assign';

/**
 * Minimal Supabase stand-in: `profiles` lookups answer from `members`,
 * the `pick_next_agent` RPC answers with `rpcResult`, and updates are
 * recorded so a test can assert what was written.
 */
function makeDb(opts: {
  members?: { accountId: string; userId: string }[];
  reps?: { accountId: string; userId: string; salesrepId: string }[];
  rpcResult?: string | null;
  rpcError?: boolean;
  repsError?: boolean;
}) {
  const updates: Record<string, unknown>[] = [];
  const members = opts.members ?? [];

  const db = {
    rpc: vi.fn(async () =>
      opts.rpcError
        ? { data: null, error: { message: 'permission denied' } }
        : { data: opts.rpcResult ?? null, error: null }
    ),
    from: (table: string) => {
      const filters: Record<string, string> = {};
      let payload: Record<string, unknown> = {};
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          payload = p;
          return b;
        },
        eq: (col: string, val: string) => {
          filters[col] = val;
          return b;
        },
        maybeSingle: async () => {
          if (table !== 'profiles') return { data: null, error: null };
          if (filters.netsuite_salesrep_id !== undefined) {
            if (opts.repsError) {
              return { data: null, error: { message: 'permission denied' } };
            }
            const rep = (opts.reps ?? []).find(
              (r) =>
                r.accountId === filters.account_id &&
                r.salesrepId === filters.netsuite_salesrep_id
            );
            return { data: rep ? { user_id: rep.userId } : null, error: null };
          }
          const hit = members.find(
            (m) =>
              m.accountId === filters.account_id && m.userId === filters.user_id
          );
          return { data: hit ? { user_id: hit.userId } : null, error: null };
        },
        // `assignConversation` ends its chain on `.select('id')`, which
        // resolves as a thenable rather than via maybeSingle().
        then: (resolve: (v: unknown) => unknown) => {
          updates.push({ ...payload, _id: filters.id, _account: filters.account_id });
          return Promise.resolve({ data: [{ id: filters.id }], error: null }).then(
            resolve
          );
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;

  return { db, updates };
}

const ACCOUNT = 'acct-1';

describe('resolveAssignee', () => {
  it('lets null through to release the conversation', async () => {
    const { db } = makeDb({});
    expect(await resolveAssignee(db, ACCOUNT, null)).toEqual({
      ok: true,
      agentId: null,
    });
  });

  it('accepts an agent who belongs to the account', async () => {
    const { db } = makeDb({
      members: [{ accountId: ACCOUNT, userId: 'agent-1' }],
    });
    expect(await resolveAssignee(db, ACCOUNT, 'agent-1')).toEqual({
      ok: true,
      agentId: 'agent-1',
    });
  });

  // The one that matters: `assigned_agent_id` has no foreign key and the
  // API runs as service-role, so nothing else would catch this. Left
  // unchecked, the assignment trigger (migration 027) delivers a
  // notification carrying this account's contact name to a stranger.
  it("refuses an agent from another account", async () => {
    const { db } = makeDb({
      members: [{ accountId: 'other-acct', userId: 'outsider' }],
    });
    expect(await resolveAssignee(db, ACCOUNT, 'outsider')).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
  });

  it('asks the round-robin for "auto"', async () => {
    const { db } = makeDb({ rpcResult: 'agent-next' });
    expect(await resolveAssignee(db, ACCOUNT, 'auto')).toEqual({
      ok: true,
      agentId: 'agent-next',
    });
  });

  it('reports no_agent_available when the rotation finds nobody', async () => {
    const { db } = makeDb({ rpcResult: null });
    expect(await resolveAssignee(db, ACCOUNT, 'auto')).toEqual({
      ok: false,
      reason: 'no_agent_available',
    });
  });

  // A broken RPC must NOT look like "nobody was available". That was
  // the original bug: the error got swallowed, the rotation silently
  // assigned nobody forever, and the automation engine logged the step
  // as successful. A missing GRANT looks exactly like this — see
  // migration 031, where the same swallowed error silenced the whole AI
  // reply path for everyone.
  it('throws when the RPC itself fails, instead of reporting no agent', async () => {
    const { db } = makeDb({ rpcError: true });
    await expect(resolveAssignee(db, ACCOUNT, 'auto')).rejects.toThrow(
      /pick_next_agent failed/
    );
  });
});

describe('assignConversation', () => {
  it('stamps assigned_at when assigning', async () => {
    const { db, updates } = makeDb({});
    await assignConversation(db, 'conv-1', ACCOUNT, 'agent-1');
    expect(updates).toHaveLength(1);
    expect(updates[0].assigned_agent_id).toBe('agent-1');
    expect(typeof updates[0].assigned_at).toBe('string');
  });

  // A stale assigned_at on an unassigned conversation would make the
  // rotation believe that agent was served more recently than they were.
  it('clears assigned_at when releasing', async () => {
    const { db, updates } = makeDb({});
    await assignConversation(db, 'conv-1', ACCOUNT, null);
    expect(updates[0].assigned_agent_id).toBeNull();
    expect(updates[0].assigned_at).toBeNull();
  });

  it('scopes the write by account, not just id', async () => {
    const { db, updates } = makeDb({});
    await assignConversation(db, 'conv-1', ACCOUNT, 'agent-1');
    expect(updates[0]._account).toBe(ACCOUNT);
  });
});

describe('resolveBySalesrep', () => {
  it('encuentra al perfil que reclama ese salesrep', async () => {
    const { db } = makeDb({
      reps: [{ accountId: ACCOUNT, userId: 'agent-1', salesrepId: '147' }],
    });
    expect(await resolveBySalesrep(db, ACCOUNT, '147')).toEqual({
      ok: true,
      agentId: 'agent-1',
    });
  });

  // El mismo salesrepId existe en dos cuentas. El de 'otra-cuenta' va
  // PRIMERO en el array a propósito: un `.find()` sin filtrar por cuenta
  // lo encontraría antes que al correcto y esta prueba fallaría — que es
  // justo lo que debe pasar si alguien borra el `.eq('account_id', ...)`.
  it('no cruza cuentas: con el mismo salesrepId en dos cuentas, resuelve al de la cuenta pedida', async () => {
    const { db } = makeDb({
      reps: [
        { accountId: 'otra-cuenta', userId: 'agent-9', salesrepId: '147' },
        { accountId: ACCOUNT, userId: 'agent-1', salesrepId: '147' },
      ],
    });
    expect(await resolveBySalesrep(db, ACCOUNT, '147')).toEqual({
      ok: true,
      agentId: 'agent-1',
    });
  });

  it('un salesrep que solo existe en otra cuenta no vale', async () => {
    const { db } = makeDb({
      reps: [{ accountId: 'otra-cuenta', userId: 'agent-9', salesrepId: '147' }],
    });
    expect(await resolveBySalesrep(db, ACCOUNT, '147')).toEqual({
      ok: false,
      reason: 'salesrep_not_mapped',
    });
  });

  it('avisa cuando nadie lo reclama', async () => {
    const { db } = makeDb({ reps: [] });
    expect(await resolveBySalesrep(db, ACCOUNT, '999')).toEqual({
      ok: false,
      reason: 'salesrep_not_mapped',
    });
  });

  // Un error de base de datos NO es "nadie lo reclama": es un
  // malfuncionamiento (permiso, conexión) que hay que distinguir, igual que
  // `resolveAssignee`/'auto' distingue el RPC roto de "no hay agente". Antes
  // de este arreglo, `resolveBySalesrep` ignoraba `error` y devolvía
  // `salesrep_not_mapped` igual, mandando a quien depure en la dirección
  // equivocada.
  it('propaga el error de la consulta en vez de decir salesrep_not_mapped', async () => {
    const { db } = makeDb({ repsError: true });
    await expect(resolveBySalesrep(db, ACCOUNT, '147')).rejects.toThrow(
      /resolveBySalesrep failed/
    );
  });
});
