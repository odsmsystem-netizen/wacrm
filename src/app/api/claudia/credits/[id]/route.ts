import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/claudia/credits/[id] (admin+) — borra una recarga mal
 * capturada. Es el único arreglo posible para un monto equivocado: como
 * el saldo se calcula desde la ÚLTIMA recarga, una cifra errónea
 * distorsiona el estimado hasta que se quita.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-cred:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;
    const { error } = await supabase
      .from('claudia_credits')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id);
    if (error) {
      console.error('[claudia/credits/[id] DELETE] error:', error);
      return NextResponse.json(
        { error: 'No se pudo borrar la recarga' },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
