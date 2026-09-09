import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { BUCKET_CONOCIMIENTO } from '@/lib/claudia/ingesta';

type Params = { params: Promise<{ id: string }> };

const CAMPOS = 'id, tipo, titulo, origen, estado, error, bytes, activo, creado';

/**
 * PATCH /api/claudia/knowledge/[id] (admin+) — renombrar o encender/apagar.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-kb:${userId}`, RATE_LIMITS.adminAction);
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
    if (typeof body.activo === 'boolean') cambios.activo = body.activo;

    if (Object.keys(cambios).length === 0) {
      return NextResponse.json({ error: 'No hay nada que cambiar' }, { status: 400 });
    }
    // `actualizado` lo pone Postgres (trigger de la migración 045). Ponerlo
    // aquí usaba el reloj de Node mientras `creado` usa el de la base: dos
    // relojes distintos que no tienen por qué coincidir, y de hecho no
    // coincidían.

    // El filtro por cuenta va explícito además del id: sin él, un uuid de
    // otra cuenta pasaría la validación de formato y tocaría material ajeno.
    const { data, error } = await supabase
      .from('claudia_knowledge')
      .update(cambios)
      .eq('account_id', accountId)
      .eq('id', id)
      .select(CAMPOS)
      .maybeSingle();
    if (error) {
      console.error('[claudia/knowledge/[id] PATCH] error:', error);
      return NextResponse.json({ error: 'No se pudo guardar' }, { status: 500 });
    }
    if (!data) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    return NextResponse.json(data);
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/claudia/knowledge/[id] (admin+).
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-kb:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Se lee la ruta ANTES de borrar la fila: después ya no habría forma
    // de saber qué objeto de Storage quedó huérfano.
    const { data: fila } = await supabase
      .from('claudia_knowledge')
      .select('storage_path')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();

    const { error } = await supabase
      .from('claudia_knowledge')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[claudia/knowledge/[id] DELETE] error:', error);
      return NextResponse.json({ error: 'No se pudo borrar' }, { status: 500 });
    }

    // El archivo se borra después y sin propagar el fallo: la fila ya no
    // está, así que Claudia ya dejó de saberlo, que es lo que pidió el
    // administrador. Un objeto huérfano en Storage es basura, no un error
    // que merezca decirle que el borrado falló.
    if (fila?.storage_path) {
      const { error: errStorage } = await supabase.storage
        .from(BUCKET_CONOCIMIENTO)
        .remove([fila.storage_path]);
      if (errStorage) {
        console.warn('[claudia/knowledge/[id] DELETE] objeto huérfano:', errStorage);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
