// ============================================================
// El paso de "el administrador dio de alta una fuente" a "Claudia ya lo
// sabe". Vive fuera de las rutas porque lo usan dos: el alta y el
// reprocesado, y duplicarlo garantizaría que un día diverjan.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadAiConfig } from '@/lib/ai/config';
import {
  extraerDocumento,
  extraerImagen,
  extraerUrl,
  type ResultadoExtraccion,
} from './extraccion';

export const BUCKET_CONOCIMIENTO = 'claudia-knowledge';

/** 20 MB, el mismo tope que declara el bucket en la migración 042. */
export const MAX_BYTES = 20 * 1024 * 1024;

/**
 * La clave de Anthropic de la cuenta, o cadena vacía si no hay.
 *
 * Solo hace falta para describir imágenes. Se resuelve aquí —y no se
 * exige antes— para que subir un PDF siga funcionando en una cuenta que
 * nunca configuró una clave: bloquear todo el módulo por una capacidad
 * que la mayoría de las altas no usa sería desproporcionado.
 */
async function claveAnthropic(
  supabase: SupabaseClient,
  accountId: string,
): Promise<string> {
  try {
    // `requireActive: false` es obligatorio aquí, no una comodidad. Una
    // cuenta que usa Claudia tiene el agente interno de wacrm APAGADO —
    // ese es justamente el motivo de que Claudia exista. Con el valor por
    // omisión, loadAiConfig devolvería null en exactamente las cuentas
    // que necesitan esto, y describir imágenes nunca habría funcionado.
    const cfg = await loadAiConfig(supabase, accountId, { requireActive: false });
    return cfg?.provider === 'anthropic' ? (cfg.apiKey ?? '') : '';
  } catch {
    // Una clave que no se puede descifrar no debe tumbar el alta: la
    // fuente se guarda en estado `error` con su explicación, y el
    // administrador la reprocesa cuando arregle la clave.
    return '';
  }
}

export interface FuenteParaIngerir {
  tipo: 'documento' | 'imagen' | 'url';
  /** Nombre del archivo, o la URL. */
  origen: string;
  /** Contenido del archivo. Ausente para las URLs. */
  buffer?: Buffer;
}

/**
 * Convierte una fuente en texto. NUNCA lanza: devuelve el error como
 * dato para que la fila se guarde en estado `error` con su explicación
 * en vez de desaparecer. Una fuente que falló y se ve en la lista se
 * puede reintentar; una que nunca se guardó, no.
 */
export async function extraerFuente(
  supabase: SupabaseClient,
  accountId: string,
  fuente: FuenteParaIngerir,
): Promise<ResultadoExtraccion> {
  try {
    if (fuente.tipo === 'url') {
      return await extraerUrl(fuente.origen);
    }
    if (!fuente.buffer) {
      return { texto: '', error: 'No llegó el contenido del archivo.' };
    }
    if (fuente.tipo === 'imagen') {
      const clave = await claveAnthropic(supabase, accountId);
      return await extraerImagen(fuente.buffer, fuente.origen, clave);
    }
    return await extraerDocumento(fuente.buffer, fuente.origen);
  } catch (e) {
    return {
      texto: '',
      error: `Fallo inesperado al procesar: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Ruta en Storage, con el mismo namespace por cuenta que el resto del proyecto. */
export function rutaConocimiento(accountId: string, nombre: string): string {
  const conExt = /\.[^.]+$/.test(nombre);
  const ext = conExt ? nombre.split('.').pop()!.toLowerCase() : 'bin';
  const base =
    nombre
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .slice(0, 40) || 'archivo';
  return `account-${accountId}/${Date.now()}-${base}.${ext}`;
}
