// Guarda un mensaje entrante de Messenger: contacto, conversación y mensaje.
//
// A propósito NO llama a automatizaciones, flujos, respuesta automática de IA
// ni webhooks públicos (spec: fuera de alcance). El webhook de WhatsApp sí lo
// hace; aquí cada una de esas puertas asume un teléfono y un canal WhatsApp.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { getUserName } from './graph'
import type { MessengerInboundEvent } from './parse-webhook'

export type InboundOutcome = 'stored' | 'duplicate' | 'unknown_page'

interface PageConfig {
  account_id: string
  user_id: string
  page_access_token: string
}

async function findContact(db: SupabaseClient, accountId: string, psid: string) {
  const { data } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', 'messenger')
    .eq('external_id', psid)
    .maybeSingle()
  return data
}

async function findOrCreateContact(
  db: SupabaseClient,
  config: PageConfig,
  psid: string,
) {
  const existing = await findContact(db, config.account_id, psid)
  if (existing) return existing

  const name =
    (await getUserName(decrypt(config.page_access_token), psid)) ?? `Messenger ····${psid.slice(-4)}`

  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      channel: 'messenger',
      external_id: psid,
      name,
    })
    .select()
    .single()

  if (error) {
    // Perdió la carrera contra otra entrega del mismo PSID: el índice único
    // rechazó el duplicado. Se resuelve a la fila ganadora en vez de perder
    // el mensaje.
    if (isUniqueViolation(error)) return findContact(db, config.account_id, psid)
    console.error('[messenger] error creando contacto:', error)
    return null
  }
  return data
}

async function findConversation(db: SupabaseClient, accountId: string, contactId: string) {
  const { data } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
  return data && data.length > 0 ? data[0] : null
}

async function findOrCreateConversation(
  db: SupabaseClient,
  config: PageConfig,
  contactId: string,
) {
  const existing = await findConversation(db, config.account_id, contactId)
  if (existing) return existing

  const { data, error } = await db
    .from('conversations')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      contact_id: contactId,
      channel: 'messenger',
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) return findConversation(db, config.account_id, contactId)
    console.error('[messenger] error creando conversación:', error)
    return null
  }
  return data
}

export async function processInboundEvent(
  db: SupabaseClient,
  event: MessengerInboundEvent,
): Promise<InboundOutcome> {
  const { data: config } = await db
    .from('messenger_config')
    .select('account_id, user_id, page_access_token')
    .eq('page_id', event.pageId)
    .eq('status', 'connected')
    .maybeSingle()

  if (!config) {
    console.warn('[messenger] mensaje de una página no conectada:', event.pageId)
    return 'unknown_page'
  }

  const contact = await findOrCreateContact(db, config, event.psid)
  if (!contact) throw new Error(`[messenger] no se pudo crear el contacto del PSID ${event.psid}`)
  const conversation = await findOrCreateConversation(db, config, contact.id)
  if (!conversation) {
    throw new Error(`[messenger] no se pudo crear la conversación del contacto ${contact.id}`)
  }

  // Idempotencia: Meta reintenta entregas lentas con el mismo `mid`. El índice
  // único (conversation_id, message_id) convierte el reintento en un
  // ON CONFLICT DO NOTHING y `.select()` solo devuelve fila en el primer
  // insert. Esta es la única frontera de idempotencia, y debe ir ANTES del
  // contador de no leídos.
  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: event.contentType,
        content_text: event.contentText,
        media_url: event.mediaUrl,
        message_id: event.mid,
        status: 'delivered',
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (error) {
    console.error('[messenger] error guardando mensaje:', error)
    // Un fallo real no es un reintento inofensivo: se propaga para que el
    // llamador lo registre en vez de perder el mensaje en silencio.
    throw new Error(`[messenger] no se pudo guardar el mensaje ${event.mid}: ${error.message}`)
  }
  if (!inserted || inserted.length === 0) return 'duplicate'

  await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: event.contentText ?? `[${event.contentType}]`,
  })
  await reopenClosedConversation(db, conversation)

  return 'stored'
}
