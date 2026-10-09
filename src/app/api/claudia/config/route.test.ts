import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  checkRateLimit: vi.fn(),
  upsert: vi.fn(),
  fila: { current: null as Record<string, unknown> | null },
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: mocks.getCurrentAccount,
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() => Response.json({ error: 'slow down' }, { status: 429 })),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

import { GET, PATCH } from './route';

/** Lo que Postgres devolvería: `time` llega como "09:00:00". */
const FILA_BD = {
  personalidad: 3,
  instrucciones_extra: '',
  revision: 4,
  activa: true,
  promociones_activas: true,
  promociones_siempre: false,
  promociones_texto: '2x1 en octubre',
  promociones_dias: [1, 2, 3],
  promociones_inicio: '09:00:00',
  promociones_fin: '18:30:00',
};

const supabase = {
  from: vi.fn(() => ({
    select: () => ({
      eq: () => ({ maybeSingle: () => Promise.resolve({ data: mocks.fila.current, error: null }) }),
    }),
    upsert: (fila: unknown) => {
      mocks.upsert(fila);
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { ...FILA_BD, ...(fila as object) }, error: null }),
        }),
      };
    },
  })),
};

const context = { supabase, accountId: 'account-1', userId: 'user-1', role: 'admin' };

function patch(body: unknown) {
  return new Request('http://localhost/api/claudia/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const horarioOk = {
  promociones_dias: [1, 2, 3, 4, 5],
  promociones_inicio: '09:00',
  promociones_fin: '18:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fila.current = FILA_BD;
  mocks.requireRole.mockResolvedValue(context);
  mocks.getCurrentAccount.mockResolvedValue(context);
  mocks.checkRateLimit.mockReturnValue({ success: true });
});

describe('GET /api/claudia/config — promociones', () => {
  it('devuelve los seis campos y recorta la hora a HH:MM', async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.promociones_activas).toBe(true);
    expect(json.promociones_siempre).toBe(false);
    expect(json.promociones_texto).toBe('2x1 en octubre');
    expect(json.promociones_dias).toEqual([1, 2, 3]);
    expect(json.promociones_inicio).toBe('09:00');
    expect(json.promociones_fin).toBe('18:30');
  });

  it('sin fila devuelve los valores por omisión del contrato', async () => {
    mocks.fila.current = null;
    const json = await (await GET()).json();
    expect(json).toMatchObject({
      promociones_activas: false,
      promociones_siempre: false,
      promociones_texto: '',
      promociones_dias: [1, 2, 3, 4, 5],
      promociones_inicio: '09:00',
      promociones_fin: '18:00',
    });
  });
});

describe('PATCH /api/claudia/config — promociones', () => {
  it('guarda los campos válidos y responde con la hora recortada', async () => {
    const res = await PATCH(
      patch({ promociones_activas: true, promociones_siempre: true, promociones_texto: 'Hola', ...horarioOk }),
    );
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'account-1',
        promociones_activas: true,
        promociones_siempre: true,
        promociones_texto: 'Hola',
        promociones_dias: [1, 2, 3, 4, 5],
        promociones_inicio: '09:00',
        promociones_fin: '18:00',
      }),
    );
    const json = await res.json();
    expect(json.promociones_inicio).toBe('09:00');
  });

  it.each([
    ['activas no booleano', { promociones_activas: 'si' }],
    ['siempre no booleano', { promociones_siempre: 1 }],
    ['texto no es texto', { promociones_texto: 5 }],
    ['texto de más de 5000', { promociones_texto: 'a'.repeat(5001) }],
    ['días vacíos', { ...horarioOk, promociones_dias: [] }],
    ['día 0', { ...horarioOk, promociones_dias: [0, 1] }],
    ['día 8', { ...horarioOk, promociones_dias: [8] }],
    ['días repetidos', { ...horarioOk, promociones_dias: [1, 1] }],
    ['días no numéricos', { ...horarioOk, promociones_dias: ['1'] }],
    ['hora mal formada', { ...horarioOk, promociones_inicio: '9:00' }],
    ['hora imposible', { ...horarioOk, promociones_fin: '25:00' }],
    ['inicio igual a fin', { ...horarioOk, promociones_inicio: '10:00', promociones_fin: '10:00' }],
    ['inicio mayor que fin', { ...horarioOk, promociones_inicio: '19:00' }],
    ['horario incompleto (solo inicio)', { promociones_inicio: '08:00' }],
  ])('rechaza con 400: %s', async (_nombre, body) => {
    const res = await PATCH(patch(body));
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('acepta un texto de exactamente 5000 caracteres', async () => {
    const res = await PATCH(patch({ promociones_texto: 'a'.repeat(5000) }));
    expect(res.status).toBe(200);
  });

  it('sigue exigiendo rol admin (si requireRole lanza, no se guarda nada)', async () => {
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    const res = await PATCH(patch({ promociones_activas: true }));
    expect(res.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('respeta el límite de tasa', async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ success: false });
    const res = await PATCH(patch({ promociones_activas: true }));
    expect(res.status).toBe(429);
  });
});

describe('PATCH /api/claudia/config — interruptor general', () => {
  it('registra quién cambió `activa`', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await PATCH(patch({ activa: false }));
    expect(info).toHaveBeenCalledWith(
      '[claudia/config] interruptor general -> false por usuario user-1',
    );
    info.mockRestore();
  });

  it('no registra nada cuando no se toca `activa`', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await PATCH(patch({ promociones_activas: true }));
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});
