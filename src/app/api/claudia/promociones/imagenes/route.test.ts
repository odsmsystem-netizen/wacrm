import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  checkRateLimit: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
  existentes: { current: [] as { orden: number }[] },
  insertError: { current: null as unknown },
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

import { GET, POST } from './route';

const supabase = {
  from: vi.fn(() => ({
    select: () => ({
      eq: () => {
        const resultado = Promise.resolve({ data: mocks.existentes.current, error: null });
        // GET encadena .order(); POST espera el resultado directo.
        return Object.assign(resultado, { order: () => resultado });
      },
    }),
    insert: (fila: unknown) => {
      mocks.insert(fila);
      return {
        select: () => ({
          single: () =>
            Promise.resolve(
              mocks.insertError.current
                ? { data: null, error: mocks.insertError.current }
                : { data: { id: 'img-1', nombre: 'foto', tamano: 4, orden: 0 }, error: null },
            ),
        }),
      };
    },
  })),
  storage: {
    from: vi.fn(() => ({
      upload: mocks.upload,
      remove: mocks.remove,
      getPublicUrl: (ruta: string) => ({
        data: { publicUrl: `https://cdn.test/claudia-promos/${ruta}` },
      }),
    })),
  },
};

const context = { supabase, accountId: 'account-1', userId: 'user-1', role: 'admin' };

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function subir(bytes: Uint8Array | string, nombre = 'foto.jpg', tipo = 'image/jpeg') {
  const form = new FormData();
  form.append('archivo', new File([bytes as BlobPart], nombre, { type: tipo }));
  return new Request('http://localhost/api/claudia/promociones/imagenes', {
    method: 'POST',
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existentes.current = [];
  mocks.insertError.current = null;
  mocks.requireRole.mockResolvedValue(context);
  mocks.getCurrentAccount.mockResolvedValue(context);
  mocks.checkRateLimit.mockReturnValue({ success: true });
  mocks.upload.mockResolvedValue({ error: null });
  mocks.remove.mockResolvedValue({ error: null });
});

describe('POST /api/claudia/promociones/imagenes', () => {
  it('sube un JPEG a {cuenta}/{uuid}.jpg y devuelve la fila con su URL pública', async () => {
    const res = await POST(subir(JPEG));
    expect(res.status).toBe(201);
    const [ruta, , opciones] = mocks.upload.mock.calls[0];
    expect(ruta).toMatch(/^account-1\/[0-9a-f-]{36}\.jpg$/);
    expect(opciones).toMatchObject({ contentType: 'image/jpeg', upsert: false });
    const json = await res.json();
    expect(json.url).toBe(`https://cdn.test/claudia-promos/${ruta}`);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: 'account-1', ruta, nombre: 'foto', orden: 0 }),
    );
  });

  it('acepta PNG y lo guarda como .png', async () => {
    const res = await POST(subir(PNG, 'promo.png', 'image/png'));
    expect(res.status).toBe(201);
    expect(mocks.upload.mock.calls[0][0]).toMatch(/\.png$/);
  });

  it('el orden es el siguiente al mayor existente', async () => {
    mocks.existentes.current = [{ orden: 0 }, { orden: 4 }];
    await POST(subir(JPEG));
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ orden: 5 }));
  });

  it('rechaza un tipo falso con extensión .jpg (se mira por los primeros bytes)', async () => {
    const res = await POST(subir('<html>no soy una imagen</html>', 'trampa.jpg', 'image/jpeg'));
    expect(res.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('rechaza la imagen número 11', async () => {
    mocks.existentes.current = Array.from({ length: 10 }, (_, i) => ({ orden: i }));
    const res = await POST(subir(JPEG));
    expect(res.status).toBe(409);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('acepta la décima imagen', async () => {
    mocks.existentes.current = Array.from({ length: 9 }, (_, i) => ({ orden: i }));
    const res = await POST(subir(JPEG));
    expect(res.status).toBe(201);
  });

  it('rechaza un archivo de más de 5 MB', async () => {
    const grande = new Uint8Array(5 * 1024 * 1024 + 1);
    grande.set(JPEG);
    const res = await POST(subir(grande));
    expect(res.status).toBe(400);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it('rechaza una petición sin archivo', async () => {
    const res = await POST(
      new Request('http://localhost/x', { method: 'POST', body: new FormData() }),
    );
    expect(res.status).toBe(400);
  });

  it('si falla el INSERT borra el objeto subido (sin huérfanos)', async () => {
    mocks.insertError.current = { message: 'boom' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(subir(JPEG));
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(mocks.remove).toHaveBeenCalledWith([mocks.upload.mock.calls[0][0]]);
  });

  it('si falla la subida no inserta nada', async () => {
    mocks.upload.mockResolvedValue({ error: { message: 'sin permiso' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(subir(JPEG));
    err.mockRestore();
    expect(res.status).toBe(500);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('respeta el límite de tasa y el rol admin', async () => {
    mocks.checkRateLimit.mockReturnValueOnce({ success: false });
    expect((await POST(subir(JPEG))).status).toBe(429);
    mocks.requireRole.mockRejectedValueOnce(new Error('forbidden'));
    expect((await POST(subir(JPEG))).status).toBe(403);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});

describe('GET /api/claudia/promociones/imagenes', () => {
  it('lista las imágenes con su URL pública y sin exponer la ruta interna', async () => {
    mocks.existentes.current = [
      { id: 'a', nombre: 'Uno', tamano: 10, orden: 0, ruta: 'account-1/a.jpg' },
    ] as never;
    const json = await (await GET()).json();
    expect(json.imagenes).toEqual([
      {
        id: 'a',
        nombre: 'Uno',
        tamano: 10,
        orden: 0,
        url: 'https://cdn.test/claudia-promos/account-1/a.jpg',
      },
    ]);
  });
});
