// Lector del bloque `referral` que Meta agrega al primer mensaje de WhatsApp
// cuando el cliente llega desde un anuncio "Clic para enviar mensaje por
// WhatsApp" o desde una publicación. El payload viene de un tercero: se
// valida todo y se acotan longitudes antes de guardarlo en la conversación.

export type AdReferral = {
  source_type: 'ad' | 'post'
  source_id: string | null
  source_url: string | null
  headline: string | null
  body: string | null
  media_type: string | null
  image_url: string | null
  video_url: string | null
  thumbnail_url: string | null
  ctwa_clid: string | null
  captured_at: string
}

const MAX_HEADLINE = 300
const MAX_BODY = 1000
const MAX_SHORT = 200
const MAX_URL = 2000

/** Texto recortado y truncado al límite; vacío o de otro tipo → null. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max) : t
}

/**
 * URL solo si es https:// y cabe en el límite. Una URL cortada dejaría de
 * funcionar, así que si es muy larga se descarta en vez de truncarla. Esto
 * evita `javascript:` y `data:` en el enlace y el <img> que la muestran.
 */
function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t.startsWith('https://') || t.length > MAX_URL) return null
  return t
}

/** Devuelve el origen publicitario ya validado, o null si no es de anuncio/publicación. */
export function extractAdReferral(
  raw: unknown,
  now: Date = new Date(),
): AdReferral | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.source_type !== 'ad' && r.source_type !== 'post') return null

  return {
    source_type: r.source_type,
    source_id: text(r.source_id, MAX_SHORT),
    source_url: httpsUrl(r.source_url),
    headline: text(r.headline, MAX_HEADLINE),
    body: text(r.body, MAX_BODY),
    media_type: text(r.media_type, MAX_SHORT),
    image_url: httpsUrl(r.image_url),
    video_url: httpsUrl(r.video_url),
    thumbnail_url: httpsUrl(r.thumbnail_url),
    ctwa_clid: text(r.ctwa_clid, MAX_SHORT),
    captured_at: now.toISOString(),
  }
}
