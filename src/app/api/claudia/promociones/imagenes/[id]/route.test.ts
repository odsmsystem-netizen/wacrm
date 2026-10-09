import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  remove: vi.fn(),
  borrados: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() => Response.json({ error: 'slow down' }, { status: 429 })),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

import { DELETE } from './route';

/** Filas de TODAS las cuentas: el doble solo devuelve las que cumplen los `.eq` aplicados. */
const FILAS = [
  { id: '11111111-1111-4111-8111-111111111111', account_id: 'account-1', ruta: 'account-1/mia.jpg' },
  { id: '22222222-2222-4222-8222-222222222222', account_id: 'account-2', ruta: 'account-2/ajena.jpg' },
];

function from() {
  const filtros: Record<string, string> = {};
  const builder = {
    select: () => builder,
    delete: () => {
      mocks.borrados(filtros);
      return builder;
    },
    eq: (col: string, val: string) => {
      filtros[col] = val;
      return builder;
    },
    maybeSingle: () =>
      Promise.resolve({
        data: FILAS.find((f) => Object.entries(filtros).every(([k, v]) => f[k as keyof typeof f] === v)) ?? null,
        error: null,
      }),
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
  };
  return builder;
}

const supabase = {
  from: vi.fn(() => from()),
  storage: { from: vi.fn(() => ({ remove: mocks.remove })) },
};

const context = { supabase, accountId: 'account-1', userId: 'user-1', role: 'admin' };
// UUID reales: la ruta rechaza con 404 cualquier id que no lo sea (antes llegaba a Postgres y daba 500).
const UUID_MIA = '11111111-1111-4111-8111-111111111111';
const UUID_AJENA = '22222222-2222-4222-8222-222222222222';
const llamar = (id: string) =>
  DELETE(new Request('http://localhost/x', { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireRole.mockResolvedValue(context);
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.remove.mockResolvedValue({ error: null });
});

describe('DELETE /api/claudia/promociones/imagenes/[id]', () => {
  it('borra la fila y el objeto del bucket', async () => {
    const res = await llamar(UUID_MIA);
    expect(res.status).toBe(200);
    expect(mocks.borrados).toHaveBeenCalledWith({ account_id: 'account-1', id: UUID_MIA });
    expect(mocks.remove).toHaveBeenCalledWith(['account-1/mia.jpg']);
  });

  it('una imagen de otra cuenta responde 404 y no borra nada', async () => {
    const res = await llamar(UUID_AJENA);
    expect(res.status).toBe(404);
    expect(mocks.borrados).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('un id que no es UUID responde 404 sin consultar la base', async () => {
    const res = await llamar('no-es-un-uuid');
    expect(res.status).toBe(404);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it('exige rol admin', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    expect((await llamar(UUID_MIA)).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
