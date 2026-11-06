/**
 * Mediana, en minutos, entre que entra una conversación y se asigna.
 * Ignora filas sin ambas fechas o con fecha de asignación anterior a la
 * de creación (dato inconsistente). Devuelve null si no queda ninguna.
 */
export function medianMinutesToAssign(
  rows: { created_at: string | null; assigned_at: string | null }[],
): number | null {
  const mins: number[] = []
  for (const r of rows) {
    if (!r.created_at || !r.assigned_at) continue
    const diff = new Date(r.assigned_at).getTime() - new Date(r.created_at).getTime()
    if (!Number.isFinite(diff) || diff < 0) continue
    mins.push(diff / 60_000)
  }
  if (mins.length === 0) return null
  mins.sort((a, b) => a - b)
  const mid = Math.floor(mins.length / 2)
  return mins.length % 2 ? mins[mid] : (mins[mid - 1] + mins[mid]) / 2
}

/** Porcentaje entero respecto al primer paso; 0 si no hay base. */
export function pctOf(value: number, base: number): number {
  return base > 0 ? Math.round((value / base) * 100) : 0
}
