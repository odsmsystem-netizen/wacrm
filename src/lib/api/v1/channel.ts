// Interpreta `?channel=` en la API pública. El valor por omisión es 'whatsapp'
// a propósito: Claudia sondea /api/v1/conversations y contesta por WhatsApp con
// el teléfono del contacto; si Messenger apareciera sin pedirlo, intentaría
// escribirle a un PSID como si fuera un teléfono.

export type ApiChannel = 'whatsapp' | 'messenger'

export function parseChannelParam(
  raw: string | null,
): { channel: ApiChannel } | { error: string } {
  if (raw === null) return { channel: 'whatsapp' }
  if (raw === 'whatsapp' || raw === 'messenger') return { channel: raw }
  return { error: "'channel' must be 'whatsapp' or 'messenger'" }
}
