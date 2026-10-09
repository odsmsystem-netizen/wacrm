import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  cfg: { current: null as Record<string, unknown> | null },
  cfgError: { current: null as unknown },
  imagenes: { current: [] as { ruta: string; nombre: string }[] },
  imagenesError: { current: null as unknown },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

import { GET } from './route';

function from(tabla: string) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    maybeSingle: () => Promise.resolve({ data: mocks.cfg.current, error: mocks.cfgError.current }),
    then: (resolve: (v: unknown) => void) => {
      if (tabla === 'claudia_promociones_imagenes') {
        resolve({ data: mocks.imagenes.current, error: mocks.imagenesError.current });
      } else {
        resolve({ data: [], error: null });
      }
    },
  };
  return builder;
}

const supabase = {
  from: vi.fn((tabla: string) => from(tabla)),
  storage: {
    from: vi.fn(() => ({
      getPublicUrl: (ruta: string) => ({
        data: { publicUrl: `https://cdn.test/claudia-promos/${ruta}` },
      }),
    })),
  },
};

const FILA = {
  personalidad: 3,
  instrucciones_extra: '',
  revision: 7,
  activa: true,
  promociones_activas: true,
  promociones_siempre: false,
  promociones_texto: 'Promo de octubre',
  promociones_dias: [1, 2, 3, 4, 5],
  promociones_inicio: '09:00:00',
  promociones_fin: '18:00:00',
};

const PROMOCIONES_ESPERADAS = {
  activas: true,
  siempre: false,
  texto: 'Promo de octubre',
  dias: [1, 2, 3, 4, 5],
  inicio: '09:00',
  fin: '18:00',
  zona: 'America/Mexico_City',
  imagenes: [
    { url: 'https://cdn.test/claudia-promos/account-1/a.jpg', nombre: 'Uno' },
    { url: 'https://cdn.test/claudia-promos/account-1/b.png', nombre: 'Dos' },
  ],
};

const llamar = (query = '') => GET(new Request(`http://localhost/api/v1/claudia/config${query}`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cfg.current = FILA;
  mocks.cfgError.current = null;
  mocks.imagenes.current = [
    { ruta: 'account-1/a.jpg', nombre: 'Uno' },
    { ruta: 'account-1/b.png', nombre: 'Dos' },
  ];
  mocks.imagenesError.current = null;
  mocks.requireApiKey.mockResolvedValue({ supabase, accountId: 'account-1' });
});

describe('GET /api/v1/claudia/config — promociones', () => {
  it('incluye `promociones` en la respuesta completa, con horas HH:MM y URLs públicas', async () => {
    const { data } = await (await llamar('?since=1')).json();
    expect(data.sin_cambios).toBe(false);
    expect(data.promociones).toEqual(PROMOCIONES_ESPERADAS);
  });

  it('incluye `promociones` TAMBIÉN en la rama sin_cambios', async () => {
    const { data } = await (await llamar('?since=7')).json();
    expect(data).toMatchObject({ revision: 7, sin_cambios: true, activa: true });
    expect(data.promociones).toEqual(PROMOCIONES_ESPERADAS);
  });

  it('sin fila de configuración manda promociones apagadas y vacías', async () => {
    mocks.cfg.current = null;
    const { data } = await (await llamar()).json();
    expect(data.sin_cambios).toBe(true);
    expect(data.promociones).toMatchObject({
      activas: false,
      siempre: false,
      texto: '',
      dias: [1, 2, 3, 4, 5],
      inicio: '09:00',
      fin: '18:00',
      zona: 'America/Mexico_City',
      imagenes: [],
    });
  });

  it('si no se puede leer la configuración responde 503 y NO afirma que Claudia esté encendida', async () => {
    // Regla del producto: el interruptor general lo decide el usuario. Un fallo pasajero de la
    // base de datos no puede encender a Claudia (antes respondía `activa: true`, y el agente lo
    // tomaba por verdad hasta la siguiente vuelta). Con un 503 el agente conserva el último
    // estado conocido, que es lo que ya hace ante cualquier respuesta que no sea 200.
    mocks.cfg.current = null;
    mocks.cfgError.current = { message: 'boom' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await llamar();
    err.mockRestore();
    expect(res.status).toBe(503);
    const cuerpo = await res.json();
    expect(JSON.stringify(cuerpo)).not.toContain('"activa"');
    expect(cuerpo.data).toBeUndefined();
  });

  it('si fallan las imágenes manda el bloque apagado en vez de uno incompleto', async () => {
    mocks.imagenesError.current = { message: 'boom' };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { data } = await (await llamar('?since=7')).json();
    err.mockRestore();
    expect(data.promociones.activas).toBe(false);
    expect(data.promociones.imagenes).toEqual([]);
  });

  it('el interruptor general sigue viajando junto a las promociones', async () => {
    mocks.cfg.current = { ...FILA, activa: false };
    const { data } = await (await llamar('?since=7')).json();
    expect(data.activa).toBe(false);
    expect(data.promociones.activas).toBe(true);
  });
});
