import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/** Lo que ve una cuenta que nunca configuró nada. */
const POR_OMISION = { personalidad: 3, instrucciones_extra: '', revision: 0 };

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
      .select('personalidad, instrucciones_extra, revision')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[claudia/config GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudo cargar la configuración' },
        { status: 500 },
      );
    }
    return NextResponse.json(data ?? POR_OMISION);
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

    if (Object.keys(cambios).length === 0) {
      return NextResponse.json({ error: 'No hay nada que cambiar' }, { status: 400 });
    }

    // Upsert porque la fila puede no existir todavía: la lectura no la
    // crea a propósito, así que el primer guardado es el que la inserta.
    const { data, error } = await supabase
      .from('claudia_config')
      .upsert({ account_id: accountId, ...cambios }, { onConflict: 'account_id' })
      .select('personalidad, instrucciones_extra, revision')
      .single();
    if (error) {
      console.error('[claudia/config PATCH] error:', error);
      return NextResponse.json(
        { error: 'No se pudo guardar la configuración' },
        { status: 500 },
      );
    }
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}
