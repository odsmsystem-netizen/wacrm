import type { ContactSourcesData } from './types'

export type SourceShares = Omit<ContactSourcesData, 'total'>

const KEYS: (keyof SourceShares)[] = [
  'whatsappOrganic',
  'whatsappAd',
  'whatsappPost',
  'messenger',
]

/**
 * Porcentaje entero de cada origen, repartido por el método del mayor
 * residuo para que SIEMPRE sumen 100 (redondear cada uno por separado
 * puede dar 99 o 101). Con total 0 devuelve ceros.
 */
export function sourceShares(data: ContactSourcesData): SourceShares {
  const result: SourceShares = {
    whatsappOrganic: 0,
    whatsappAd: 0,
    whatsappPost: 0,
    messenger: 0,
  }
  const total = KEYS.reduce((acc, k) => acc + data[k], 0)
  if (total <= 0) return result

  const parts = KEYS.map((key, order) => {
    const exact = (data[key] * 100) / total
    return { key, order, floor: Math.floor(exact), rest: exact - Math.floor(exact) }
  })
  let left = 100 - parts.reduce((acc, p) => acc + p.floor, 0)
  // Mayor residuo primero; en empate, el orden fijo de KEYS.
  const byRest = [...parts].sort((a, b) => b.rest - a.rest || a.order - b.order)
  for (const p of byRest) {
    if (left <= 0) break
    p.floor += 1
    left -= 1
  }
  for (const p of parts) result[p.key] = p.floor
  return result
}
