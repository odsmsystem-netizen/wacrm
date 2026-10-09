import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { BUCKET_PROMOS } from '@/lib/claudia/promos-imagenes';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/claudia/promociones/imagenes/[id] (admin+).
 *
 * El filtro por cuenta va explícito además del id: sin él, un uuid de
 * otra cuenta pasaría la validación de formato. Si la imagen no es de la
 * cuenta, 404 (no se confirma que exista en otra).
 */
const ES_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-promos:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    // Un id que no es UUID no puede existir: se responde 404 sin molestar a la base (que daría un
    // error de sintaxis y, con él, un 500 en vez del 404 que corresponde).
    if (!ES_UUID.test(id)) {
      return NextResponse.json({ error: 'No encontrada' }, { status: 404 });
    }

    // Se lee la ruta ANTES de borrar la fila: después ya no habría forma
    // de saber qué objeto del bucket quedó huérfano.
    const { data: fila, error: errLectura } = await supabase
      .from('claudia_promociones_imagenes')
      .select('ruta')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle();
    if (errLectura) {
      console.error('[claudia/promociones/imagenes/[id] DELETE] lectura:', errLectura);
      return NextResponse.json({ error: 'No se pudo borrar' }, { status: 500 });
    }
    if (!fila) return NextResponse.json({ error: 'No encontrada' }, { status: 404 });

    const { error } = await supabase
      .from('claudia_promociones_imagenes')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[claudia/promociones/imagenes/[id] DELETE] error:', error);
      return NextResponse.json({ error: 'No se pudo borrar' }, { status: 500 });
    }

    // Sin propagar el fallo: la fila ya no está, así que Claudia dejó de
    // usar la imagen. Un objeto huérfano es basura, no un borrado fallido.
    const { error: errStorage } = await supabase.storage
      .from(BUCKET_PROMOS)
      .remove([fila.ruta]);
    if (errStorage) {
      console.warn('[claudia/promociones/imagenes/[id] DELETE] objeto huérfano:', errStorage);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
