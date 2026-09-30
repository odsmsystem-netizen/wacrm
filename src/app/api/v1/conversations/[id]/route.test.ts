import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// PATCH /api/v1/conversations/[id] — el rasgo de `assigned_salesrep_id` /
// `ai_autoreply_disabled` (commit 6594e9a) no tenía ninguna prueba propia.
// Este archivo cubre lo que la spec del rasgo prometía:
//
//   - assigned_agent_id + assigned_salesrep_id juntos -> 400
//   - assigned_salesrep_id sin mapear -> 409 salesrep_not_mapped EN EL CUERPO
//   - assigned_salesrep_id válido -> asigna al usuario correcto
//   - ai_autoreply_disabled: true -> queda persistido
//   - aislamiento por cuenta: una conversación de otra cuenta no se toca
//   - asignar + apagar la IA en la misma petición es UNA sola escritura
//     (hallazgo de la ventana sin transacción entre las dos escrituras)
//
// El doble de Supabase sigue el mismo patrón que assign.test.ts y el mock de
// whatsapp/send/route.test.ts: un builder encadenable por tabla, que registra
// cada escritura para poder contarlas.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

import { GET, PATCH } from './route';

const ACCOUNT = 'acct-1';
const OTHER_ACCOUNT = 'acct-2';
const CONV_ID = 'conv-1';

type ConvRow = {
  id: string;
  account_id: string;
  assigned_agent_id: string | null;
  assigned_at: string | null;
  ai_autoreply_disabled: boolean;
  status: string;
  created_at: string;
  updated_at: string;
};

type ProfileRow = {
  account_id: string;
  user_id: string;
  netsuite_salesrep_id?: string;
  is_salesrep_fallback?: boolean;
};

type Write = { table: string; payload: Record<string, unknown>; id: string };

function makeSupabase(opts: {
  conversations: ConvRow[];
  profiles?: ProfileRow[];
}) {
  const conversations = new Map(opts.conversations.map((c) => [c.id, { ...c }]));
  const profiles = opts.profiles ?? [];
  const writes: Write[] = [];

  function conversationsBuilder() {
    // Solo se compara por las columnas en las que realmente se llamó
    // `.eq(...)` — igual que SQL: un filtro que el código de producción
    // deja de aplicar deja de restringir, no se queda "exigiendo
    // coincidencia con undefined". Así, si alguien quita el
    // `.eq('account_id', ...)` de una consulta, el doble SÍ deja pasar una
    // fila de otra cuenta, como pasaría contra Supabase real.
    const appliedFilters = new Map<string, string>();
    let mode: 'select' | 'update' | null = null;
    let payload: Record<string, unknown> = {};

    const matches = (row: ConvRow | undefined): row is ConvRow => {
      if (!row) return false;
      for (const [col, val] of appliedFilters) {
        if ((row as unknown as Record<string, unknown>)[col] !== val) return false;
      }
      return true;
    };

    const commitUpdate = () => {
      const id = appliedFilters.get('id');
      const row = id ? conversations.get(id) : undefined;
      if (!matches(row)) {
        return { data: [], error: null };
      }
      Object.assign(row, payload);
      writes.push({ table: 'conversations', payload: { ...payload }, id: row.id });
      return { data: [{ id: row.id }], error: null };
    };

    const b: Record<string, unknown> = {
      select: () => {
        if (mode === null) mode = 'select';
        return b;
      },
      update: (p: Record<string, unknown>) => {
        mode = 'update';
        payload = p;
        return b;
      },
      eq: (col: string, val: string) => {
        appliedFilters.set(col, val);
        return b;
      },
      maybeSingle: async () => {
        const id = appliedFilters.get('id');
        const row = id ? conversations.get(id) : undefined;
        if (!matches(row)) {
          return { data: null, error: null };
        }
        return { data: { ...row }, error: null };
      },
      // Cubre ambos finales que usa el código de producción: un `update`
      // que termina en `.select('id')` (thenable, como en assignConversation)
      // y uno que se hace `await` directo tras los `.eq()` (el de
      // status/ai_autoreply_disabled en route.ts).
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update') return Promise.resolve(commitUpdate()).then(resolve);
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  }

  function profilesBuilder() {
    const filters: Record<string, string | boolean> = {};
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string | boolean) => {
        filters[col] = val;
        return b;
      },
      maybeSingle: async () => {
        if (filters.netsuite_salesrep_id !== undefined) {
          const hit = profiles.find(
            (p) =>
              p.account_id === filters.account_id &&
              p.netsuite_salesrep_id === filters.netsuite_salesrep_id
          );
          return { data: hit ? { user_id: hit.user_id } : null, error: null };
        }
        if (filters.is_salesrep_fallback !== undefined) {
          const hit = profiles.find(
            (p) => p.account_id === filters.account_id && p.is_salesrep_fallback === true
          );
          return { data: hit ? { user_id: hit.user_id } : null, error: null };
        }
        const hit = profiles.find(
          (p) => p.account_id === filters.account_id && p.user_id === filters.user_id
        );
        return { data: hit ? { user_id: hit.user_id } : null, error: null };
      },
    };
    return b;
  }

  const db = {
    from: (table: string) => {
      if (table === 'conversations') return conversationsBuilder();
      if (table === 'profiles') return profilesBuilder();
      throw new Error(`tabla inesperada en el doble: ${table}`);
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
  };

  return { db, conversations, writes };
}

function baseConversation(overrides: Partial<ConvRow> = {}): ConvRow {
  return {
    id: CONV_ID,
    account_id: ACCOUNT,
    assigned_agent_id: null,
    assigned_at: null,
    ai_autoreply_disabled: false,
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function patch(body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/v1/conversations/${CONV_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CONV_ID }) }
  );
}

beforeEach(() => {
  mocks.requireApiKey.mockReset();
});

function useAccountContext(supabase: unknown, accountId = ACCOUNT) {
  mocks.requireApiKey.mockResolvedValue({
    authType: 'api_key',
    supabase,
    accountId,
    keyId: 'key-1',
    scopes: ['conversations:write', 'conversations:read'],
    createdBy: 'user-0',
  });
}

describe('PATCH /api/v1/conversations/[id]', () => {
  it('assigned_agent_id y assigned_salesrep_id a la vez -> 400 (mutuamente excluyentes)', async () => {
    const { db, writes } = makeSupabase({ conversations: [baseConversation()] });
    useAccountContext(db);

    const res = await patch({
      assigned_agent_id: 'agent-1',
      assigned_salesrep_id: '147',
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('bad_request');
    expect(writes).toHaveLength(0);
  });

  // Hallazgo 2: una cadena vacía no es "asígnalo a quien sea", es una
  // petición mal formada. Antes del arreglo, `typeof '' === 'string'`
  // pasaba la validación, `resolveBySalesrep` no encontraba a nadie con
  // ese id y caía al respaldo de la cuenta -- asignando la conversación
  // sin que nadie lo hubiera pedido de verdad.
  it('assigned_salesrep_id vacío -> 400, no cae al respaldo', async () => {
    const { db, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [
        { account_id: ACCOUNT, user_id: 'agent-respaldo', is_salesrep_fallback: true },
      ],
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '' });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('bad_request');
    expect(writes).toHaveLength(0);
  });

  // Solo espacios se recorta y, si queda vacío, es el mismo 400 -- no un
  // id "válido" que por casualidad no mapea a nadie.
  it('assigned_salesrep_id de solo espacios -> 400, no cae al respaldo', async () => {
    const { db, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [
        { account_id: ACCOUNT, user_id: 'agent-respaldo', is_salesrep_fallback: true },
      ],
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '   ' });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error.code).toBe('bad_request');
    expect(writes).toHaveLength(0);
  });

  it('assigned_salesrep_id sin mapear -> 409 salesrep_not_mapped en el CUERPO de la respuesta', async () => {
    const { db, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [], // nadie reclama ese salesrep
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '999' });

    expect(res.status).toBe(409);
    // El defecto previo de este rasgo fue justo este: el código llegaba a
    // las cabeceras pero no al cuerpo. Se lee el JSON de la respuesta, no
    // el objeto `resolved` interno.
    const json = await res.json();
    expect(json.error.code).toBe('salesrep_not_mapped');
    expect(json.error.message).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it('assigned_salesrep_id válido asigna al usuario correcto', async () => {
    const { db, conversations, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [{ account_id: ACCOUNT, user_id: 'agent-42', netsuite_salesrep_id: '147' }],
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '147' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.assigned_agent_id).toBe('agent-42');
    expect(conversations.get(CONV_ID)?.assigned_agent_id).toBe('agent-42');
    expect(writes).toHaveLength(1);
  });

  it('ai_autoreply_disabled: true queda persistido', async () => {
    const { db, conversations } = makeSupabase({
      conversations: [baseConversation({ ai_autoreply_disabled: false })],
    });
    useAccountContext(db);

    const res = await patch({ ai_autoreply_disabled: true });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.ai_autoreply_disabled).toBe(true);
    expect(conversations.get(CONV_ID)?.ai_autoreply_disabled).toBe(true);
  });

  it('una conversación de otra cuenta no se puede tocar (404)', async () => {
    const { db, conversations } = makeSupabase({
      conversations: [baseConversation({ account_id: OTHER_ACCOUNT })],
      profiles: [
        { account_id: ACCOUNT, user_id: 'agent-42', netsuite_salesrep_id: '147' },
      ],
    });
    useAccountContext(db, ACCOUNT);

    const res = await patch({ assigned_salesrep_id: '147' });
    expect(res.status).toBe(404);
    // No se tocó la fila de la otra cuenta.
    expect(conversations.get(CONV_ID)?.assigned_agent_id).toBeNull();
  });

  it('asignar por salesrep y apagar la IA en la misma petición es UNA sola escritura', async () => {
    // Hallazgo: había una ventana sin transacción entre asignar y pausar.
    // Si esto vuelve a separarse en dos escrituras, esta prueba se pone roja.
    const { db, conversations, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [{ account_id: ACCOUNT, user_id: 'agent-42', netsuite_salesrep_id: '147' }],
    });
    useAccountContext(db);

    const res = await patch({
      assigned_salesrep_id: '147',
      ai_autoreply_disabled: true,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.assigned_agent_id).toBe('agent-42');
    expect(json.data.ai_autoreply_disabled).toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({
      assigned_agent_id: 'agent-42',
      ai_autoreply_disabled: true,
    });

    expect(conversations.get(CONV_ID)?.assigned_agent_id).toBe('agent-42');
    expect(conversations.get(CONV_ID)?.ai_autoreply_disabled).toBe(true);
  });

  // Migración 047, de punta a punta: un salesrep sin mapear pero con
  // respaldo designado en la cuenta asigna al respaldo Y pausa la IA en
  // la MISMA escritura — el mismo hallazgo que la prueba de arriba, ahora
  // por el camino del respaldo en vez del salesrep mapeado directo.
  it('salesrep sin mapear con respaldo designado asigna al respaldo y pausa la IA en UNA sola escritura', async () => {
    const { db, conversations, writes } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [
        { account_id: ACCOUNT, user_id: 'agent-respaldo', is_salesrep_fallback: true },
      ],
    });
    useAccountContext(db);

    const res = await patch({
      assigned_salesrep_id: '999', // nadie lo reclama directamente
      ai_autoreply_disabled: true,
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.assigned_agent_id).toBe('agent-respaldo');
    expect(json.data.ai_autoreply_disabled).toBe(true);

    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toMatchObject({
      assigned_agent_id: 'agent-respaldo',
      ai_autoreply_disabled: true,
    });

    expect(conversations.get(CONV_ID)?.assigned_agent_id).toBe('agent-respaldo');
    expect(conversations.get(CONV_ID)?.ai_autoreply_disabled).toBe(true);
  });

  // Hallazgo 1: `resolveBySalesrep` calcula `viaFallback` y nadie lo usaba.
  // El camino del respaldo debe dejar rastro -- si no, la conversación de
  // un cliente de un representante sin cuenta en el CRM aparece asignada
  // a otra persona sin ninguna pista de por qué.
  it('el camino del respaldo queda registrado; el mapeo directo no', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { db } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [
        { account_id: ACCOUNT, user_id: 'agent-respaldo', is_salesrep_fallback: true },
      ],
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '999' });
    expect(res.status).toBe(200);

    expect(info).toHaveBeenCalledTimes(1);
    const [, data] = info.mock.calls[0];
    expect(data).toMatchObject({
      conversationId: CONV_ID,
      requestedSalesrepId: '999',
      assignedAgentId: 'agent-respaldo',
    });

    info.mockRestore();
  });

  it('el mapeo directo por salesrep NO se registra como respaldo', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { db } = makeSupabase({
      conversations: [baseConversation()],
      profiles: [{ account_id: ACCOUNT, user_id: 'agent-42', netsuite_salesrep_id: '147' }],
    });
    useAccountContext(db);

    const res = await patch({ assigned_salesrep_id: '147' });
    expect(res.status).toBe(200);

    expect(info).not.toHaveBeenCalled();

    info.mockRestore();
  });
});

describe('GET /api/v1/conversations/[id]', () => {
  it('lee una conversación de la cuenta del caller', async () => {
    const { db } = makeSupabase({ conversations: [baseConversation()] });
    useAccountContext(db);

    const res = await GET(
      new Request(`http://localhost/api/v1/conversations/${CONV_ID}`),
      { params: Promise.resolve({ id: CONV_ID }) }
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.id).toBe(CONV_ID);
  });

  it('404 para una conversación de otra cuenta', async () => {
    const { db } = makeSupabase({
      conversations: [baseConversation({ account_id: OTHER_ACCOUNT })],
    });
    useAccountContext(db, ACCOUNT);

    const res = await GET(
      new Request(`http://localhost/api/v1/conversations/${CONV_ID}`),
      { params: Promise.resolve({ id: CONV_ID }) }
    );
    expect(res.status).toBe(404);
  });
});
