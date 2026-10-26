/**
 * Motivo de fallo de un mensaje saliente, tal como Meta lo reporta en el
 * webhook de estado (`statuses[].errors`).
 *
 * Meta manda `code` + `title` (+ `message` y `error_data.details` según el
 * caso). Se condensa en una sola línea legible para guardarla en
 * `messages.error_detail` y mostrarla en la bandeja:
 *   "131042 · Business eligibility payment issue — <detalle>"
 */

export interface MetaStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

/** Tope defensivo: el texto viene de un tercero y se guarda tal cual. */
const MAX_LENGTH = 500

export function describeMetaStatusError(
  errors: MetaStatusError[] | undefined | null,
): string | null {
  const first = Array.isArray(errors) ? errors[0] : undefined
  if (!first || typeof first !== 'object') return null

  const title = first.title?.trim() || first.message?.trim() || ''
  const details = first.error_data?.details?.trim() || ''
  const code = typeof first.code === 'number' ? String(first.code) : ''

  const head = [code, title].filter(Boolean).join(' · ')
  // El detalle a veces repite el título; no lo dupliques.
  const body =
    details && details !== title ? [head, details].filter(Boolean).join(' — ') : head

  if (!body) return null
  return body.length > MAX_LENGTH ? `${body.slice(0, MAX_LENGTH - 1)}…` : body
}
