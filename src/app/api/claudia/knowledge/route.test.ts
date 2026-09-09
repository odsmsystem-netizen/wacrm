import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  extraerFuente: vi.fn(),
  insert: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: vi.fn(),
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() => Response.json({ error: 'slow down' }, { status: 429 })),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

vi.mock('@/lib/claudia/ingesta', () => ({
  BUCKET_CONOCIMIENTO: 'conocimiento',
  MAX_BYTES: 20 * 1024 * 1024,
  extraerFuente: mocks.extraerFuente,
  rutaConocimiento: vi.fn(() => 'account-1/archivo.pdf'),
}));

import { POST } from './route';

/**
 * Supabase encadenado: `.from(...).insert(...).select(...).single()`.
 * `mocks.insert` guarda la fila para poder afirmar sobre ella.
 */
const supabase = {
  from: vi.fn(() => ({
    insert: (fila: unknown) => {
      mocks.insert(fila);
      return {
        select: () => ({
          single: () => Promise.resolve({ data: { id: 'k1', ...(fila as object) }, error: null }),
        }),
      };
    },
  })),
  storage: { from: vi.fn(() => ({ upload: mocks.upload })) },
};

const context = {
  supabase,
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Ambar' },
};

/** Petición multipart con un documento y, opcionalmente, el campo `activo`. */
function subir(activo?: string) {
  const form = new FormData();
  form.append('file', new File(['contenido del archivo'], 'tarifario.pdf'));
  if (activo !== undefined) form.append('activo', activo);
  return new Request('http://localhost/api/claudia/knowledge', { method: 'POST', body: form });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.checkRateLimit.mockReset();
  mocks.extraerFuente.mockReset();
  mocks.insert.mockReset();
  mocks.upload.mockReset();

  mocks.requireRole.mockResolvedValue(context);
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.extraerFuente.mockResolvedValue({ texto: 'texto extraído', error: '' });
  mocks.upload.mockResolvedValue({ error: null });
});

describe('POST /api/claudia/knowledge — alta apagada para la carga en lote', () => {
  it('da de alta la fuente apagada cuando el formulario manda activo=false', async () => {
    const res = await POST(subir('false'));

    expect(res.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ activo: false }));
  });

  it('no toca `activo` cuando el formulario no lo manda, para que mande el DEFAULT de la tabla', async () => {
    // Una subida suelta tiene que seguir comportándose exactamente como
    // antes de este cambio: la fila llega activa por el DEFAULT de la
    // columna, no porque la ruta lo escriba.
    const res = await POST(subir());

    expect(res.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert.mock.calls[0][0]).not.toHaveProperty('activo');
  });

  it('ignora un valor que no sea exactamente "false" en vez de apagar la fuente', async () => {
    // Defensivo a propósito: un `activo=0` o `activo=no` mal formado
    // desde otro cliente no debe apagar en silencio una fuente que el
    // administrador espera encendida.
    await POST(subir('0'));

    expect(mocks.insert.mock.calls[0][0]).not.toHaveProperty('activo');
  });
});
