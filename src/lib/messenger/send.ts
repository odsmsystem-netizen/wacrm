// Responder a un cliente de Messenger desde la bandeja (solo texto).
//
// La ventana de Messenger es de 24 h contadas desde el ÚLTIMO mensaje del
// cliente; pasada esa ventana Meta solo permite contestar con etiquetas
// especiales que esta versión no usa, así que se rechaza ANTES de llamar a Meta.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MessengerApiError, sendText } from './graph'

export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000

/** Código de Graph para un token vencido o revocado. */
const GRAPH_INVALID_TOKEN = 190

export type MessengerSendErrorCode =
  | 'not_found'
  | 'wrong_channel'
  | 'not_configured'
  | 'window_closed'
  | 'token_invalid'
  | 'meta_error'
  | 'db_error'

export class MessengerSendError extends Error {
  constructor(
    public code: MessengerSendErrorCode,
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'MessengerSendError'
  }
}

export async function sendMessengerText(
  db: SupabaseClient,
  accountId: string,
  params: { conversationId: string; text: string },
): Promise<{ messageId: string; mid: string }> {
  const { conversationId, text } = params

  const { data: conversation } = await db
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conversation) {
    throw new MessengerSendError('not_found', 'Conversation not found', 404)
  }
  if (conversation.channel !== 'messenger') {
    throw new MessengerSendError(
      'wrong_channel',
      'This conversation is not on Messenger; use /api/whatsapp/send',
      400,
    )
  }

  const { data: contact } = await db
    .from('contacts')
    .select('*')
    .eq('id', conversation.contact_id)
    .maybeSingle()
  if (!contact?.external_id) {
    throw new MessengerSendError('not_found', 'Contact has no Messenger id', 404)
  }

  const { data: config } = await db
    .from('messenger_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config || config.status !== 'connected') {
    throw new MessengerSendError(
      'not_configured',
      'Messenger is not connected. Connect the page in Settings.',
      400,
    )
  }

  const { data: inbound } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  const lastInbound = inbound?.[0]?.created_at as string | undefined
  if (!lastInbound || Date.now() - new Date(lastInbound).getTime() > MESSENGER_WINDOW_MS) {
    throw new MessengerSendError(
      'window_closed',
      'The 24-hour Messenger window is closed. The customer has to write first.',
      409,
    )
  }

  let mid: string
  try {
    mid = (await sendText(decrypt(config.page_access_token), contact.external_id, text)).messageId
  } catch (err) {
    if (err instanceof MessengerApiError) {
      if (err.code === GRAPH_INVALID_TOKEN) {
        // Sin esto cada envío siguiente fallaría igual y en silencio: se marca
        // la página como desconectada para que Ajustes lo muestre.
        await db.from('messenger_config').update({ status: 'disconnected' }).eq('id', config.id)
        throw new MessengerSendError(
          'token_invalid',
          'The page token is invalid or was revoked. Reconnect the page in Settings.',
          401,
        )
      }
      throw new MessengerSendError('meta_error', err.message, 502)
    }
    throw err
  }

  const { data: row, error } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'text',
      content_text: text,
      message_id: mid,
      status: 'sent',
    })
    .select()
    .single()
  if (error || !row) {
    throw new MessengerSendError(
      'db_error',
      'Message sent to Meta but failed to save to DB',
      500,
    )
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { messageId: row.id as string, mid }
}
