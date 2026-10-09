// Extrae del cuerpo del webhook de Messenger solo lo que la bandeja necesita.
// Pura y sin I/O: Meta manda de todo por este mismo canal (entregas, lecturas,
// ecos de lo que la página envía) y aquí se decide qué cuenta como mensaje
// entrante, para que el resto del código no tenga que defenderse del formato.
//
// Límite conocido: las URL de imagen que entrega Meta son temporales. Se
// guardan tal cual; si caducan, la imagen deja de verse.

export interface MessengerInboundEvent {
  pageId: string
  psid: string
  /** Id del mensaje en Meta; es la llave de idempotencia ante reintentos. */
  mid: string
  /** Milisegundos desde epoch, como lo manda Messenger. */
  timestamp: number
  contentType: 'text' | 'image'
  contentText: string | null
  mediaUrl: string | null
}

interface RawAttachment {
  type?: string
  payload?: { url?: string }
}

export function extractInboundEvents(body: unknown): MessengerInboundEvent[] {
  const root = body as { object?: string; entry?: unknown[] } | null
  if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return []

  const events: MessengerInboundEvent[] = []

  for (const rawEntry of root.entry) {
    const entry = rawEntry as { id?: string; messaging?: unknown[] }
    if (!entry?.id || !Array.isArray(entry.messaging)) continue

    for (const rawItem of entry.messaging) {
      // Skip items that are not non-null objects
      if (typeof rawItem !== 'object' || !rawItem) continue

      const item = rawItem as {
        sender?: { id?: string }
        timestamp?: number
        message?: {
          mid?: string
          text?: string
          is_echo?: boolean
          attachments?: RawAttachment[]
        }
      }
      const message = item.message
      const psid = item.sender?.id
      // Sin `message` es una entrega, una lectura o un postback: no es un
      // mensaje del cliente. `is_echo` es lo que la propia página mandó.
      if (!message || !psid || !message.mid || message.is_echo) continue

      const image =
        Array.isArray(message.attachments) &&
        message.attachments.find((a) => a?.type === 'image' && a?.payload?.url)
      const other = Array.isArray(message.attachments) ? message.attachments[0] : undefined

      let contentType: 'text' | 'image' = 'text'
      let contentText: string | null = message.text ?? null
      let mediaUrl: string | null = null

      if (image) {
        contentType = 'image'
        mediaUrl = image.payload!.url!
      } else if (!contentText && other) {
        contentText = `[${other.type ?? 'adjunto'} recibido]`
      }

      events.push({
        pageId: entry.id,
        psid,
        mid: message.mid,
        timestamp: item.timestamp ?? Date.now(),
        contentType,
        contentText,
        mediaUrl,
      })
    }
  }

  return events
}
