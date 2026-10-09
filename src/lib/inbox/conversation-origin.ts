// Por dónde nos contactó el cliente. Una sola función para la lista y para el encabezado de la
// bandeja, de modo que nunca se contradigan. Misma definición que el indicador del Panel
// (src/lib/dashboard/queries.ts): Messenger por canal; WhatsApp por anuncio o publicación cuando
// Meta mandó el bloque `referral`; y el resto de WhatsApp es orgánico.
//
// Ojo: las conversaciones anteriores al registro de anuncios no traen `referral`, así que se ven
// como orgánicas aunque alguna haya llegado por un anuncio. Es una limitación conocida, no un error.

import type { Conversation } from '@/types'

export type ConversationOrigin =
  | 'messenger'
  | 'whatsapp_ad'
  | 'whatsapp_post'
  | 'whatsapp_organic'

export function conversationOrigin(
  conversation: Pick<Conversation, 'channel' | 'ad_referral'>,
): ConversationOrigin {
  if (conversation.channel === 'messenger') return 'messenger'
  const type = conversation.ad_referral?.source_type
  if (type === 'ad') return 'whatsapp_ad'
  if (type === 'post') return 'whatsapp_post'
  return 'whatsapp_organic'
}
