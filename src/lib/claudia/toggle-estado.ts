// ============================================================
// Decisiones PURAS del punto de color del Header (claudia-toggle.tsx).
// Viven aparte para poder probarlas: el repo no tiene pruebas de
// componentes de React.
//
// El síntoma que motivó esto: el punto «volvía solo a verde». Una
// respuesta vacía o rara se pintaba como «activa», y una consulta que
// salió antes de un clic podía llegar después y pisar el cambio.
// ============================================================

export type EstadoToggle = 'cargando' | 'activa' | 'inactiva' | 'oculto';

/**
 * Estado a pintar a partir de lo que respondió el servidor. Solo un
 * `activa` booleano cambia algo; cualquier otra cosa conserva el estado
 * anterior (o deja el botón oculto si era la primera carga). Nunca verde
 * por omisión.
 */
export function decidirEstado(respuesta: unknown, anterior: EstadoToggle): EstadoToggle {
  const activa = (respuesta as { activa?: unknown } | null | undefined)?.activa;
  if (typeof activa === 'boolean') return activa ? 'activa' : 'inactiva';
  return anterior === 'cargando' ? 'oculto' : anterior;
}

/**
 * ¿Se puede aplicar la respuesta de un GET? Solo si no hubo ningún clic
 * desde que ese GET salió y no hay un PATCH en vuelo: en ambos casos la
 * respuesta describe un estado que el usuario ya cambió.
 */
export function puedeAplicarGet(p: {
  versionAlSalir: number;
  versionActual: number;
  patchPendiente: boolean;
}): boolean {
  return p.versionAlSalir === p.versionActual && !p.patchPendiente;
}
