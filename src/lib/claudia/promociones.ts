// ============================================================
// Horario de las promociones de Claudia. Lógica PURA, compartida por la
// ruta de configuración (validación) y la pantalla «Anuncios» (estado en
// vivo). El agente de Python evalúa la misma regla por su cuenta en cada
// mensaje; este archivo es la versión del CRM del CONTRATO:
//
//   vigente = activas AND (siempre OR dentro_del_horario)
//
// dentro_del_horario = día local ∈ dias AND inicio <= hora_local < fin,
// en la zona America/Mexico_City. Los días son ISO (1 = lunes … 7 =
// domingo) y no se admiten rangos que crucen la medianoche.
// ============================================================

export const ZONA_PROMOCIONES = 'America/Mexico_City';

export interface PromocionesConfig {
  activas: boolean;
  siempre: boolean;
  texto: string;
  /** Días ISO 1..7 (1 = lunes, 7 = domingo). */
  dias: number[];
  /** "HH:MM" en 24 h. */
  inicio: string;
  /** "HH:MM" en 24 h, siempre mayor que `inicio`. */
  fin: string;
  zona?: string;
}

export const valoresPorOmision: PromocionesConfig = {
  activas: false,
  siempre: false,
  texto: '',
  dias: [1, 2, 3, 4, 5],
  inicio: '09:00',
  fin: '18:00',
  zona: ZONA_PROMOCIONES,
};

/** Por qué las promociones están (o no) disponibles ahora mismo. */
export type EstadoPromociones = 'apagadas' | 'siempre' | 'dentro' | 'fuera';

const FORMATO_HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" a minutos desde la medianoche; null si el formato no es válido. */
function aMinutos(hora: string): number | null {
  const m = FORMATO_HORA.exec(hora);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const DIAS_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/**
 * Día ISO y minutos del día en la zona pedida. `Intl` resuelve el
 * desfase (y el horario de verano si la zona lo tuviera), sin librerías.
 * `hourCycle: 'h23'` evita el "24:00" que algunos motores devuelven a
 * la medianoche con `hour12: false`.
 */
function horaLocal(ahora: Date, zona: string): { dia: number; minutos: number } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ahora);
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? '';
  return {
    dia: DIAS_ISO[valor('weekday')] ?? 0,
    minutos: Number(valor('hour')) * 60 + Number(valor('minute')),
  };
}

export function estadoPromociones(
  cfg: PromocionesConfig,
  ahora: Date = new Date(),
): EstadoPromociones {
  if (!cfg.activas) return 'apagadas';
  if (cfg.siempre) return 'siempre';

  const inicio = aMinutos(cfg.inicio);
  const fin = aMinutos(cfg.fin);
  // Un horario corrupto nunca debe abrir la mano: ante la duda, fuera.
  if (inicio === null || fin === null) return 'fuera';

  const { dia, minutos } = horaLocal(ahora, cfg.zona || ZONA_PROMOCIONES);
  const dentro = cfg.dias.includes(dia) && inicio <= minutos && minutos < fin;
  return dentro ? 'dentro' : 'fuera';
}

export function promocionesVigentes(
  cfg: PromocionesConfig,
  ahora: Date = new Date(),
): boolean {
  const estado = estadoPromociones(cfg, ahora);
  return estado === 'siempre' || estado === 'dentro';
}

export type ResultadoValidacion =
  | { ok: true }
  | { ok: false; error: 'dias' | 'formato' | 'orden' };

/** Valida días y horas con las mismas reglas que las CHECK de la migración 050. */
export function validarHorario(h: {
  dias: number[];
  inicio: string;
  fin: string;
}): ResultadoValidacion {
  const diasValidos =
    Array.isArray(h.dias) &&
    h.dias.length > 0 &&
    h.dias.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) &&
    new Set(h.dias).size === h.dias.length;
  if (!diasValidos) return { ok: false, error: 'dias' };

  const inicio = typeof h.inicio === 'string' ? aMinutos(h.inicio) : null;
  const fin = typeof h.fin === 'string' ? aMinutos(h.fin) : null;
  if (inicio === null || fin === null) return { ok: false, error: 'formato' };
  if (inicio >= fin) return { ok: false, error: 'orden' };
  return { ok: true };
}

/** La columna `time` de Postgres llega como "09:00:00": se recorta a "09:00". */
export function recortarHora(valor: unknown, porOmision: string): string {
  return typeof valor === 'string' && valor.length >= 5 ? valor.slice(0, 5) : porOmision;
}
