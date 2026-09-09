import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

const CAMPOS = 'id, titulo, instruccion, activo, orden, creado';

/**
 * PATCH /api/claudia/behaviors/[id] (admin+) — editar, activar o reordenar.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-beh:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Cuerpo JSON inválido' }, { status: 400 });
    }

    const cambios: Record<string, unknown> = {};
    if (typeof body.titulo === 'string' && body.titulo.trim()) {
      cambios.titulo = body.titulo.trim().slice(0, 200);
    }
    if (typeof body.instruccion === 'string' && body.instruccion.trim()) {
      cambios.instruccion = body.instruccion.trim().slice(0, 5_000);
    }
    if (typeof body.activo === 'boolean') cambios.activo = body.activo;
    if (Number.isInteger(body.orden)) cambios.orden = body.orden;

    if (Object.keys(cambios).length === 0) {
      return NextResponse.json({ error: 'No hay nada que cambiar' }, { status: 400 });
    }
    // `actualizado` lo pone Postgres (trigger de la migración 045), por la
    // misma razón que en la ruta de knowledge: el reloj de Node y el de la
    // base no coinciden.

    // El filtro por `account_id` va explícito además del id: sin él, un
    // uuid de otra cuenta pasaría la validación de formato y editaría
    // configuración ajena.
    const { data, error } = await supabase
      .from('claudia_behaviors')
      .update(cambios)
      .eq('account_id', accountId)
      .eq('id', id)
      .select(CAMPOS)
      .maybeSingle();
    if (error) {
      console.error('[claudia/behaviors/[id] PATCH] error:', error);
      return NextResponse.json(
        { error: 'No se pudo guardar el comportamiento' },
        { status: 500 },
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'No encontrado' }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/claudia/behaviors/[id] (admin+).
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-beh:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { error } = await supabase
      .from('claudia_behaviors')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[claudia/behaviors/[id] DELETE] error:', error);
      return NextResponse.json(
        { error: 'No se pudo borrar el comportamiento' },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
