import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const CAMPOS = 'id, titulo, instruccion, activo, orden, creado';

/**
 * GET /api/claudia/behaviors — objetivos y comportamientos (cualquier miembro).
 *
 * Se ordenan igual que en el prompt (orden, luego id) para que la lista
 * de la pantalla y lo que de verdad lee Claudia coincidan. Ver el
 * desempate por id en `construirBloquePrompt`.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('claudia_behaviors')
      .select(CAMPOS)
      .eq('account_id', accountId)
      .order('orden', { ascending: true })
      .order('id', { ascending: true });
    if (error) {
      console.error('[claudia/behaviors GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudieron cargar los comportamientos' },
        { status: 500 },
      );
    }
    return NextResponse.json({ behaviors: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/claudia/behaviors (admin+) — crea uno nuevo.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(`claudia-beh:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    const titulo = typeof body?.titulo === 'string' ? body.titulo.trim() : '';
    const instruccion =
      typeof body?.instruccion === 'string' ? body.instruccion.trim() : '';
    if (!titulo || !instruccion) {
      return NextResponse.json(
        { error: 'Hacen falta el título y la instrucción' },
        { status: 400 },
      );
    }

    // Al final de la lista. El orden llega al prompt tal cual, y cuando
    // dos instrucciones se contradicen el modelo tiende a seguir la
    // última — así que lo recién agregado manda, que es lo que espera
    // quien lo acaba de escribir.
    const { data: ultimo } = await supabase
      .from('claudia_behaviors')
      .select('orden')
      .eq('account_id', accountId)
      .order('orden', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data, error } = await supabase
      .from('claudia_behaviors')
      .insert({
        account_id: accountId,
        created_by: userId,
        titulo: titulo.slice(0, 200),
        instruccion: instruccion.slice(0, 5_000),
        orden: (ultimo?.orden ?? 0) + 1,
      })
      .select(CAMPOS)
      .single();
    if (error) {
      console.error('[claudia/behaviors POST] error:', error);
      return NextResponse.json(
        { error: 'No se pudo crear el comportamiento' },
        { status: 500 },
      );
    }
    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
