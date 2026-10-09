import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { requireApiKey } from '@/lib/auth/api-context';
import {
  construirBloquePrompt,
  type Comportamiento,
  type FuenteConocimiento,
} from '@/lib/claudia/prompt';
import { BUCKET_PROMOS } from '@/lib/claudia/promos-imagenes';
import { recortarHora, valoresPorOmision } from '@/lib/claudia/promociones';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Promociones apagadas y vacías: lo que se manda cuando no hay nada que leer. */
const PROMOCIONES_APAGADAS = {
  activas: valoresPorOmision.activas,
  siempre: valoresPorOmision.siempre,
  texto: valoresPorOmision.texto,
  dias: valoresPorOmision.dias,
  inicio: valoresPorOmision.inicio,
  fin: valoresPorOmision.fin,
  zona: valoresPorOmision.zona,
  imagenes: [] as { url: string; nombre: string }[],
};

/**
 * El bloque `promociones` del contrato. Viaja en TODAS las respuestas
 * (también en `sin_cambios`), igual que `activa`: el agente lo relee cada
 * minuto, y como NO forma parte del prompt cacheado ni de la revisión,
 * mandarlo siempre no toca el caché de Anthropic.
 *
 * El CRM solo entrega la configuración; quien decide si «ahora» está
 * vigente es el agente, con la hora de cada mensaje. Si no se pueden leer
 * las imágenes se manda el bloque apagado: ante la duda, Claudia calla.
 */
async function leerPromociones(
  supabase: SupabaseClient,
  accountId: string,
  cfg: Record<string, unknown>,
) {
  const { data, error } = await supabase
    .from('claudia_promociones_imagenes')
    .select('ruta, nombre')
    .eq('account_id', accountId)
    .order('orden', { ascending: true });
  if (error) {
    console.error('[v1/claudia/config] error leyendo imágenes de promociones:', error);
    return PROMOCIONES_APAGADAS;
  }
  const dias = Array.isArray(cfg.promociones_dias)
    ? (cfg.promociones_dias as number[])
    : valoresPorOmision.dias;
  return {
    activas: cfg.promociones_activas === true,
    siempre: cfg.promociones_siempre === true,
    texto: typeof cfg.promociones_texto === 'string' ? cfg.promociones_texto : '',
    dias,
    inicio: recortarHora(cfg.promociones_inicio, valoresPorOmision.inicio),
    fin: recortarHora(cfg.promociones_fin, valoresPorOmision.fin),
    zona: valoresPorOmision.zona,
    imagenes: (data ?? []).map((f: { ruta: string; nombre: string }) => ({
      url: supabase.storage.from(BUCKET_PROMOS).getPublicUrl(f.ruta).data.publicUrl,
      nombre: f.nombre,
    })),
  };
}

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
      .select(
        'personalidad, instrucciones_extra, revision, activa, promociones_activas, promociones_siempre, promociones_texto, promociones_dias, promociones_inicio, promociones_fin',
      )
      .eq('account_id', accountId)
      .maybeSingle();
    if (cfgErr) {
      console.error('[v1/claudia/config] error leyendo config:', cfgErr);
      // `activa: true` también en el error: si el CRM no puede leer su
      // propia configuración, la conducta segura es que Claudia siga
      // atendiendo clientes, no que enmudezca por un fallo de base de datos.
      return ok({
        revision: 0,
        sin_cambios: true,
        activa: true,
        promociones: PROMOCIONES_APAGADAS,
      });
    }

    // Sin fila de configuración no hay nada que aplicar. Se responde
    // revisión 0 y sin cambios para que Claudia se quede con su prompt
    // de siempre en vez de recibir un bloque vacío que la haría
    // reemplazar —y por tanto invalidar— el texto ya cacheado.
    if (!cfg) {
      return ok({
        revision: 0,
        sin_cambios: true,
        activa: true,
        promociones: PROMOCIONES_APAGADAS,
      });
    }

    const revision = Number(cfg.revision ?? 0);
    // `activa` va fuera del mecanismo de revisión y viaja en TODAS las
    // respuestas. Es un interruptor: tiene que surtir efecto en la
    // siguiente vuelta del sondeo pase lo que pase, y como no forma
    // parte del prompt, mandarlo siempre no toca el caché de Anthropic.
    const activa = cfg.activa !== false;
    const promociones = await leerPromociones(supabase, accountId, cfg);
    if (since > 0 && since === revision) {
      return ok({ revision, sin_cambios: true, activa, promociones });
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
      return ok({ revision: since, sin_cambios: true, activa, promociones });
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
      promociones,
      personalidad: Number(cfg.personalidad ?? 3),
      prompt_extra,
      fuentes: conocimiento.data?.length ?? 0,
      comportamientos: comportamientos.data?.length ?? 0,
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
