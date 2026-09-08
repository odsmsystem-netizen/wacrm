// ============================================================
// Qué cuesta cada llamada de Claudia a Anthropic.
//
// El costo se calcula AQUÍ y no en el agente de Python a propósito:
// cuando Anthropic cambie sus precios, esto es un despliegue del CRM en
// vez de una imagen nueva del agente. Claudia solo reporta contadores
// —que es lo que de verdad sabe— y el CRM les pone precio.
//
// Puro y sin E/S: se puede probar sin base de datos ni red.
// ============================================================

/** Precios en dólares por millón de tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Escribir en caché cuesta MÁS que un token de entrada normal. */
  cacheWrite: number;
  /** Leer de caché cuesta una fracción. Es de donde sale el ahorro. */
  cacheRead: number;
}

// Claves en minúsculas. La búsqueda es por prefijo (ver `pricingFor`),
// así que `claude-sonnet-4-6` cubre también `claude-sonnet-4-6-20250101`
// y cualquier fecha que Anthropic le cuelgue después.
export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

/**
 * Precio de un modelo, o `null` si no lo conocemos.
 *
 * Devolver `null` en vez de caer a un precio "promedio" es deliberado:
 * un costo inventado se ve exactamente igual que uno real en la
 * pantalla, y el administrador tomaría decisiones de recarga con un
 * número falso. Es preferible que la interfaz diga "modelo no
 * tarificado" a que mienta con confianza.
 */
export function pricingFor(model: string): ModelPricing | null {
  const clave = (model || '').toLowerCase();
  // Del prefijo más largo al más corto: `claude-3-5-haiku` debe ganarle
  // a cualquier entrada más corta que también case.
  const prefijos = Object.keys(PRICING).sort((a, b) => b.length - a.length);
  for (const p of prefijos) {
    if (clave.startsWith(p)) return PRICING[p];
  }
  return null;
}

export interface TokenCounts {
  tokensEntrada: number;
  tokensSalida: number;
  tokensCacheEscritura: number;
  tokensCacheLectura: number;
}

/**
 * Costo en dólares de una llamada, a partir de los contadores que la
 * propia respuesta de Anthropic reporta.
 *
 * Los cuatro contadores son disjuntos: `input_tokens` de la API ya
 * EXCLUYE lo que se leyó o escribió en caché. Sumarlos aquí no
 * duplica nada.
 */
export function costOf(model: string, t: TokenCounts): number | null {
  const p = pricingFor(model);
  if (!p) return null;
  const usd =
    (t.tokensEntrada * p.input +
      t.tokensSalida * p.output +
      t.tokensCacheEscritura * p.cacheWrite +
      t.tokensCacheLectura * p.cacheRead) /
    1_000_000;
  // Seis decimales: un turno con caché puede costar menos de una
  // milésima de dólar, y redondear a centavos lo volvería cero.
  return Math.round(usd * 1e6) / 1e6;
}
