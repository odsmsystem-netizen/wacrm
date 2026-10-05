import { describe, expect, it } from 'vitest'
import { SendMessageError, sendMessageToConversation } from './send-message'

// Review Focus 6: ningún camino de WhatsApp (API pública, envío de la bandeja,
// automatizaciones) debe poder mandar a una conversación de Messenger — ni
// siquiera con un contacto sin teléfono, que daría un error confuso.
function dbReturning(conversation: Record<string, unknown>) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  Object.assign(builder, {
    select: chain,
    eq: chain,
    single: async () => ({ data: conversation, error: null }),
  })
  return { from: () => builder } as never
}

describe('sendMessageToConversation', () => {
  it('rechaza una conversación de Messenger con un error que dice dónde enviar', async () => {
    const db = dbReturning({ id: 'c1', channel: 'messenger', contact: { phone: null } })
    const err = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'c1',
      messageType: 'text',
      contentText: 'hola',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(SendMessageError)
    expect(err.status).toBe(400)
    expect(err.message).toContain('/api/messenger/send')
  })
})
