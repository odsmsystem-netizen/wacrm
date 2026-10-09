import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import {
  recortarHora,
  validarHorario,
  valoresPorOmision,
} from '@/lib/claudia/promociones';

// Una cuenta sin configurar sale ENCENDIDA: el interruptor da control,
// no cambia el comportamiento de nadie por existir.
const POR_OMISION = {
  personalidad: 3,
  instrucciones_extra: '',
  revision: 0,
  activa: true,
  promociones_activas: valoresPorOmision.activas,
  promociones_siempre: valoresPorOmision.siempre,
  promociones_texto: valoresPorOmision.texto,
  promociones_dias: valoresPorOmision.dias,
  promociones_inicio: valoresPorOmision.inicio,
  promociones_fin: valoresPorOmision.fin,
};

const CAMPOS =
  'personalidad, instrucciones_extra, revision, activa, promociones_activas, promociones_siempre, promociones_texto, promociones_dias, promociones_inicio, promociones_fin';

/** Máximo de caracteres del texto de promociones (CHECK de la migración 050). */
const MAX_TEXTO_PROMOCIONES = 5_000;

/**
 * La columna `time` de Postgres llega como "09:00:00"; el contrato y la
 * pantalla hablan en "HH:MM". Se recorta aquí, en un solo lugar.
 */
function normalizar<T extends { promociones_inicio?: unknown; promociones_fin?: unknown }>(
  fila: T,
) {
  return {
    ...fila,
    promociones_inicio: recortarHora(fila.promociones_inicio, valoresPorOmision.inicio),
    promociones_fin: recortarHora(fila.promociones_fin, valoresPorOmision.fin),
  };
}

/**
 * GET /api/claudia/config — personalidad e indicaciones extra (cualquier miembro).
 *
 * Si no hay fila NO se crea una: escribir en una lectura subiría la
 * revisión y le tiraría a Claudia el caché del prompt cada vez que
 * alguien abre la pantalla.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('claudia_config')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[claudia/config GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudo cargar la configuración' },
        { status: 500 },
      );
    }
    return NextResponse.json(data ? normalizar(data) : POR_OMISION);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/claudia/config (admin+) — cambia personalidad y/o indicaciones.
 */
export async function PATCH(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-cfg:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
    }

    const cambios: Record<string, unknown> = {};

    if (body.personalidad !== undefined) {
      const n = Number(body.personalidad);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return NextResponse.json(
          { error: 'La personalidad debe ser un entero del 1 al 5' },
          { status: 400 },
        );
      }
      cambios.personalidad = n;
    }

    if (body.instrucciones_extra !== undefined) {
      if (typeof body.instrucciones_extra !== 'string') {
        return NextResponse.json(
          { error: 'instrucciones_extra debe ser texto' },
          { status: 400 },
        );
      }
      // Este texto viaja dentro del prompt de Claudia en CADA
      // conversación. Sin tope, un pegado accidental de veinte páginas
      // encarecería todos los mensajes de la cuenta.
      cambios.instrucciones_extra = body.instrucciones_extra.slice(0, 10_000);
    }

    if (typeof body.activa === 'boolean') {
      cambios.activa = body.activa;
      // Rastro para diagnosticar quién mueve el interruptor general (el
      // punto del Header «volvía solo» y no había forma de saber por qué).
      console.info(
        `[claudia/config] interruptor general -> ${body.activa} por usuario ${userId}`,
      );
    }

    // ---- Promociones (migración 050). Validación estricta: un tipo
    // equivocado se rechaza en vez de coaccionarse.
    for (const campo of ['promociones_activas', 'promociones_siempre'] as const) {
      if (body[campo] !== undefined) {
        if (typeof body[campo] !== 'boolean') {
          return NextResponse.json({ error: `${campo} debe ser verdadero o falso` }, { status: 400 });
        }
        cambios[campo] = body[campo];
      }
    }

    if (body.promociones_texto !== undefined) {
      if (typeof body.promociones_texto !== 'string') {
        return NextResponse.json({ error: 'promociones_texto debe ser texto' }, { status: 400 });
      }
      // Se rechaza en vez de recortar: cortar en silencio un texto de
      // promociones podría dejar a medias una condición comercial.
      if (body.promociones_texto.length > MAX_TEXTO_PROMOCIONES) {
        return NextResponse.json(
          { error: `El texto de promociones no puede pasar de ${MAX_TEXTO_PROMOCIONES} caracteres` },
          { status: 400 },
        );
      }
      cambios.promociones_texto = body.promociones_texto;
    }

    // El horario se valida completo: inicio < fin no se puede comprobar
    // con un solo extremo, así que días, inicio y fin viajan juntos.
    const horario = [body.promociones_dias, body.promociones_inicio, body.promociones_fin];
    if (horario.some((v) => v !== undefined)) {
      if (horario.some((v) => v === undefined)) {
        return NextResponse.json(
          { error: 'El horario requiere promociones_dias, promociones_inicio y promociones_fin juntos' },
          { status: 400 },
        );
      }
      const dias = body.promociones_dias;
      if (!Array.isArray(dias) || !dias.every((d: unknown) => typeof d === 'number')) {
        return NextResponse.json(
          { error: 'promociones_dias debe ser una lista de números del 1 al 7' },
          { status: 400 },
        );
      }
      const v = validarHorario({
        dias,
        inicio: body.promociones_inicio,
        fin: body.promociones_fin,
      });
      if (!v.ok) {
        const mensajes = {
          dias: 'Elige al menos un día, sin repetir, del 1 (lunes) al 7 (domingo)',
          formato: 'Las horas deben tener el formato HH:MM (24 horas)',
          orden: 'La hora de inicio debe ser menor que la de fin',
        };
        return NextResponse.json({ error: mensajes[v.error] }, { status: 400 });
      }
      cambios.promociones_dias = dias;
      cambios.promociones_inicio = body.promociones_inicio;
      cambios.promociones_fin = body.promociones_fin;
    }

    if (Object.keys(cambios).length === 0) {
      return NextResponse.json({ error: 'No hay nada que cambiar' }, { status: 400 });
    }

    // Upsert porque la fila puede no existir todavía: la lectura no la
    // crea a propósito, así que el primer guardado es el que la inserta.
    const { data, error } = await supabase
      .from('claudia_config')
      .upsert({ account_id: accountId, ...cambios }, { onConflict: 'account_id' })
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/config PATCH] error:', error);
      return NextResponse.json(
        { error: 'No se pudo guardar la configuración' },
        { status: 500 },
      );
    }
    return NextResponse.json(normalizar(data));
  } catch (err) {
    return toErrorResponse(err);
  }
}
