import { badRequest, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { requireApiKey } from '@/lib/auth/api-context';
import { costOf } from '@/lib/claudia/pricing';

/** Un entero no negativo, o 0 si lo que llegó no sirve. */
function contador(valor: unknown): number {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * POST /api/v1/claudia/usage
 *
 * Claudia reporta los contadores de una llamada a Anthropic. El costo se
 * calcula AQUÍ, no allá: cuando Anthropic cambie precios, esto es un
 * despliegue del CRM en vez de una imagen nueva del agente.
 *
 * Claudia lo llama una vez por cada ida y vuelta con el modelo, y una
 * cotización encadena varias. Son escrituras pequeñas y frecuentes.
 *
 * Scope: `claudia:write`.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireApiKey(request, 'claudia:write');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      throw badRequest('Se esperaba un cuerpo JSON');
    }

    const modelo = typeof body.modelo === 'string' ? body.modelo.trim().slice(0, 100) : '';
    const tokens = {
      tokensEntrada: contador(body.tokens_entrada),
      tokensSalida: contador(body.tokens_salida),
      tokensCacheEscritura: contador(body.tokens_cache_escritura),
      tokensCacheLectura: contador(body.tokens_cache_lectura),
    };

    // Un modelo que no sabemos tarificar se guarda con costo 0 en vez de
    // rechazarse. Perder el registro de tokens sería peor que no saber el
    // costo: los tokens son el dato que no se puede reconstruir después,
    // mientras que el precio siempre se puede recalcular sobre las filas
    // ya guardadas. La interfaz avisa cuando hay consumo sin tarifar.
    const costo = costOf(modelo, tokens);

    const { error } = await supabase.from('claudia_usage').insert({
      account_id: accountId,
      modelo,
      tokens_entrada: tokens.tokensEntrada,
      tokens_salida: tokens.tokensSalida,
      tokens_cache_escritura: tokens.tokensCacheEscritura,
      tokens_cache_lectura: tokens.tokensCacheLectura,
      costo_usd: costo ?? 0,
    });
    if (error) {
      console.error('[v1/claudia/usage] error insertando:', error);
      return toApiErrorResponse(new Error('No se pudo registrar el consumo'));
    }

    return ok({ ok: true, costo_usd: costo, tarifado: costo !== null }, 201);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
