import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const CAMPOS = 'id, monto_usd, nota, recargado_en, creado';

/**
 * GET /api/claudia/credits (admin+) — historial de recargas registradas.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('claudia_credits')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('recargado_en', { ascending: false })
      .limit(50);
    if (error) {
      console.error('[claudia/credits GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudieron cargar las recargas' },
        { status: 500 },
      );
    }
    return NextResponse.json({ credits: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/claudia/credits (admin+) — registra una recarga.
 *
 * Esto es contabilidad manual, no un cobro: Anthropic no expone el saldo
 * de una organización por API, así que el administrador anota lo que
 * recargó y el módulo le descuenta el gasto medido desde esa fecha.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-cred:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const monto = Number(body?.monto_usd);
    if (!Number.isFinite(monto) || monto <= 0) {
      return NextResponse.json(
        { error: 'El monto debe ser un número mayor que cero' },
        { status: 400 },
      );
    }

    // La fecha es editable porque el administrador puede registrar la
    // recarga días después de haberla hecho, y es justo desde ahí que se
    // empieza a descontar el gasto. Una fecha inválida se cae a "ahora"
    // en vez de rechazar: perder el registro de la recarga es peor que
    // fecharla con un día de más.
    const fecha = typeof body?.recargado_en === 'string' ? new Date(body.recargado_en) : new Date();
    const recargado_en = Number.isNaN(fecha.getTime())
      ? new Date().toISOString()
      : fecha.toISOString();

    const { data, error } = await supabase
      .from('claudia_credits')
      .insert({
        account_id: accountId,
        created_by: userId,
        monto_usd: monto,
        nota: typeof body?.nota === 'string' ? body.nota.trim().slice(0, 300) : '',
        recargado_en,
      })
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/credits POST] error:', error);
      return NextResponse.json(
        { error: 'No se pudo registrar la recarga' },
        { status: 500 },
      );
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
