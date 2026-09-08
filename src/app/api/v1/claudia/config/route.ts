import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { requireApiKey } from '@/lib/auth/api-context';
import {
  construirBloquePrompt,
  type Comportamiento,
  type FuenteConocimiento,
} from '@/lib/claudia/prompt';

/**
 * GET /api/v1/claudia/config?since=<revision>
 *
 * La configuración que el administrador armó en el módulo "Configuración
 * de Claudia IA", servida al agente de Python que corre aparte.
 *
 * El parámetro `since` no es una optimización de red: es lo que protege
 * el caché de prompts de Anthropic. Claudia pega `prompt_extra` DENTRO
 * del bloque estable de su prompt, y ese caché casa por texto exacto. Si
 * el bloque se reemplazara en cada refresco —aunque fuera por el mismo
 * texto reordenado— el caché se caería y cada turno de cada conversación
 * pasaría a costar varias veces más. Por eso cuando la revisión no ha
 * cambiado se responde `sin_cambios: true` y NADA más: sin contenido que
 * copiar, Claudia no tiene forma de alterar su prompt por accidente.
 *
 * Scope: `claudia:read`.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireApiKey(request, 'claudia:read');

    const url = new URL(request.url);
    const crudo = url.searchParams.get('since');
    // `Number(null)` es 0 y `Number('')` también, así que un `since`
    // ausente se comporta como "nunca he bajado nada" — que es
    // justamente lo que queremos que pase en el primer arranque.
    const since = Number.isFinite(Number(crudo)) ? Number(crudo) : 0;

    const { data: cfg, error: cfgErr } = await supabase
      .from('claudia_config')
      .select('personalidad, instrucciones_extra, revision, activa')
      .eq('account_id', accountId)
      .maybeSingle();
    if (cfgErr) {
      console.error('[v1/claudia/config] error leyendo config:', cfgErr);
      // `activa: true` también en el error: si el CRM no puede leer su
      // propia configuración, la conducta segura es que Claudia siga
      // atendiendo clientes, no que enmudezca por un fallo de base de datos.
      return ok({ revision: 0, sin_cambios: true, activa: true });
    }

    // Sin fila de configuración no hay nada que aplicar. Se responde
    // revisión 0 y sin cambios para que Claudia se quede con su prompt
    // de siempre en vez de recibir un bloque vacío que la haría
    // reemplazar —y por tanto invalidar— el texto ya cacheado.
    if (!cfg) return ok({ revision: 0, sin_cambios: true, activa: true });

    const revision = Number(cfg.revision ?? 0);
    // `activa` va fuera del mecanismo de revisión y viaja en TODAS las
    // respuestas. Es un interruptor: tiene que surtir efecto en la
    // siguiente vuelta del sondeo pase lo que pase, y como no forma
    // parte del prompt, mandarlo siempre no toca el caché de Anthropic.
    const activa = cfg.activa !== false;
    if (since > 0 && since === revision) {
      return ok({ revision, sin_cambios: true, activa });
    }

    // Solo lo que está encendido, y del conocimiento solo lo que llegó a
    // extraerse. Una fuente en `pendiente` o `error` no tiene texto útil:
    // mandarla dejaría un encabezado sin contenido dentro del prompt.
    const [conocimiento, comportamientos] = await Promise.all([
      supabase
        .from('claudia_knowledge')
        .select('id, titulo, tipo, origen, texto')
        .eq('account_id', accountId)
        .eq('activo', true)
        .eq('estado', 'listo'),
      supabase
        .from('claudia_behaviors')
        .select('id, titulo, instruccion, orden')
        .eq('account_id', accountId)
        .eq('activo', true),
    ]);

    if (conocimiento.error || comportamientos.error) {
      console.error(
        '[v1/claudia/config] error leyendo contenido:',
        conocimiento.error ?? comportamientos.error,
      );
      // Se responde `sin_cambios` en vez de un bloque parcial. Servir la
      // personalidad sin la base de conocimiento dejaría a Claudia
      // contestando con seguridad sobre cosas que ya no sabe.
      return ok({ revision: since, sin_cambios: true, activa });
    }

    const prompt_extra = construirBloquePrompt({
      personalidad: Number(cfg.personalidad ?? 3),
      instruccionesExtra: String(cfg.instrucciones_extra ?? ''),
      conocimiento: (conocimiento.data ?? []) as FuenteConocimiento[],
      comportamientos: (comportamientos.data ?? []) as Comportamiento[],
    });

    return ok({
      revision,
      sin_cambios: false,
      activa,
      personalidad: Number(cfg.personalidad ?? 3),
      prompt_extra,
      fuentes: conocimiento.data?.length ?? 0,
      comportamientos: comportamientos.data?.length ?? 0,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
