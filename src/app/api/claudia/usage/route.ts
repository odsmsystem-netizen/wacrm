import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils';

// Se agrega en memoria sobre una ventana acotada, igual que
// /api/ai/usage. Claudia escribe una fila por ida y vuelta con el
// modelo, así que una cuenta ocupada puede generar bastantes: cuando se
// topa el límite se avisa con `truncated` en vez de reportar de menos
// en silencio.
const MAX_FILAS = 20_000;
const DIAS_POR_OMISION = 30;

interface FilaUso {
  modelo: string;
  tokens_entrada: number;
  tokens_salida: number;
  tokens_cache_escritura: number;
  tokens_cache_lectura: number;
  costo_usd: number | string;
  creado: string;
}

/**
 * GET /api/claudia/usage?days=30 (admin+)
 *
 * Consumo real de Claudia: tokens, costo, serie diaria y el estimado de
 * crédito restante. El gasto es información de facturación, de ahí que
 * sea admin+ — mismo criterio que `ai_usage_log`.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin');

    const url = new URL(request.url);
    const crudo = Number(url.searchParams.get('days'));
    // `>= 1` y no solo `isFinite`: un parámetro ausente o vacío da 0,
    // que es finito, y sin el piso la ventana se colapsaría a nada.
    const dias = Number.isFinite(crudo) && crudo >= 1 ? Math.min(90, Math.floor(crudo)) : DIAS_POR_OMISION;

    const desde = daysAgoStart(dias);

    const { data, error } = await supabase
      .from('claudia_usage')
      .select(
        'modelo, tokens_entrada, tokens_salida, tokens_cache_escritura, tokens_cache_lectura, costo_usd, creado',
      )
      .eq('account_id', accountId)
      .gte('creado', desde.toISOString())
      .order('creado', { ascending: false })
      .limit(MAX_FILAS);
    if (error) {
      console.error('[claudia/usage GET] error:', error);
      return NextResponse.json(
        { error: 'No se pudo cargar el consumo' },
        { status: 500 },
      );
    }

    const filas = (data ?? []) as FilaUso[];
    const truncated = filas.length >= MAX_FILAS;

    const tokens = { entrada: 0, salida: 0, cache_escritura: 0, cache_lectura: 0 };
    let total_usd = 0;
    const porDia = new Map<string, { usd: number; tokens: number }>();
    const porModelo = new Map<string, { usd: number; tokens: number }>();

    for (const f of filas) {
      const usd = Number(f.costo_usd) || 0;
      const t =
        f.tokens_entrada + f.tokens_salida + f.tokens_cache_escritura + f.tokens_cache_lectura;

      tokens.entrada += f.tokens_entrada;
      tokens.salida += f.tokens_salida;
      tokens.cache_escritura += f.tokens_cache_escritura;
      tokens.cache_lectura += f.tokens_cache_lectura;
      total_usd += usd;

      const dia = localDayKey(f.creado);
      const acumDia = porDia.get(dia) ?? { usd: 0, tokens: 0 };
      porDia.set(dia, { usd: acumDia.usd + usd, tokens: acumDia.tokens + t });

      const m = f.modelo || '(sin modelo)';
      const acumModelo = porModelo.get(m) ?? { usd: 0, tokens: 0 };
      porModelo.set(m, { usd: acumModelo.usd + usd, tokens: acumModelo.tokens + t });
    }

    // Relleno con ceros: una gráfica que se salta los días sin actividad
    // comprime el eje y hace parecer continuo un consumo que no lo fue.
    const serie = lastNDayKeys(dias).map((dia) => ({
      dia,
      usd: Number((porDia.get(dia)?.usd ?? 0).toFixed(6)),
      tokens: porDia.get(dia)?.tokens ?? 0,
    }));

    const por_modelo = [...porModelo.entries()]
      .map(([modelo, v]) => ({ modelo, usd: Number(v.usd.toFixed(6)), tokens: v.tokens }))
      .sort((a, b) => b.usd - a.usd);

    // ── Crédito estimado ───────────────────────────────────────────────
    // Anthropic no publica el saldo de una organización, así que se
    // reconstruye: la última recarga que registró el administrador menos
    // lo que Claudia gastó DESDE esa fecha. Solo cuenta el gasto de
    // Claudia: si la misma clave se usa en otra cosa, el estimado queda
    // por encima del real, y la interfaz tiene que decirlo.
    const { data: recarga } = await supabase
      .from('claudia_credits')
      .select('monto_usd, recargado_en')
      .eq('account_id', accountId)
      .order('recargado_en', { ascending: false })
      .limit(1)
      .maybeSingle();

    let creditos: {
      cargado_usd: number;
      gastado_usd: number;
      restante_usd: number;
      ultima_recarga: string | null;
    } | null = null;

    if (recarga) {
      // Se vuelve a consultar en vez de reusar `filas`: la recarga puede
      // ser más vieja que la ventana que pidió la pantalla, y descontar
      // solo el gasto de los últimos 30 días inflaría el saldo.
      const { data: desdeRecarga } = await supabase
        .from('claudia_usage')
        .select('costo_usd')
        .eq('account_id', accountId)
        .gte('creado', recarga.recargado_en)
        .limit(MAX_FILAS);

      const gastado = (desdeRecarga ?? []).reduce(
        (acc, f) => acc + (Number(f.costo_usd) || 0),
        0,
      );
      const cargado = Number(recarga.monto_usd) || 0;
      creditos = {
        cargado_usd: cargado,
        gastado_usd: Number(gastado.toFixed(6)),
        restante_usd: Number(Math.max(0, cargado - gastado).toFixed(6)),
        ultima_recarga: recarga.recargado_en,
      };
    }

    return NextResponse.json({
      dias,
      total_usd: Number(total_usd.toFixed(6)),
      tokens,
      serie,
      por_modelo,
      creditos,
      truncated,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
