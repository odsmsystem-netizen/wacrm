import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from './__fixtures__/fake-db'
import { processInboundEvent } from './inbound'
import type { MessengerInboundEvent } from './parse-webhook'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec(${s})` }))
const getUserName = vi.fn()
vi.mock('./graph', () => ({ getUserName: (...a: unknown[]) => getUserName(...a) }))

const CONFIG = {
  account_id: 'acct-1',
  user_id: 'user-1',
  page_id: 'PAGE1',
  page_access_token: 'enc',
  status: 'connected',
}
const event = (over: Partial<MessengerInboundEvent> = {}): MessengerInboundEvent => ({
  pageId: 'PAGE1',
  psid: 'PSID1',
  mid: 'm_1',
  timestamp: 1700000000000,
  contentType: 'text',
  contentText: 'Hola',
  mediaUrl: null,
  ...over,
})

beforeEach(() => getUserName.mockReset().mockResolvedValue('Juan Pérez'))

describe('processInboundEvent', () => {
  it('crea contacto, conversación y mensaje de Messenger', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await expect(processInboundEvent(db as never, event())).resolves.toBe('stored')

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({
      account_id: 'acct-1',
      channel: 'messenger',
      external_id: 'PSID1',
      name: 'Juan Pérez',
    })
    expect(db.tables.contacts[0].phone).toBeUndefined()
    expect(db.tables.conversations[0]).toMatchObject({ channel: 'messenger', account_id: 'acct-1' })
    expect(db.tables.messages[0]).toMatchObject({
      sender_type: 'customer',
      content_text: 'Hola',
      message_id: 'm_1',
      status: 'delivered',
    })
    expect(db.rpcCalls).toEqual([
      {
        name: 'bump_conversation_on_inbound',
        args: { p_conversation_id: db.tables.conversations[0].id, p_last_message_text: 'Hola' },
      },
    ])
    expect(getUserName).toHaveBeenCalledWith('dec(enc)', 'PSID1')
  })

  it('Review Focus 1: el mismo mid reintentado no duplica ni cuenta dos veces', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event())
    await expect(processInboundEvent(db as never, event())).resolves.toBe('duplicate')

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.messages).toHaveLength(1)
    expect(db.rpcCalls).toHaveLength(1)
  })

  it('el mismo PSID con otro mensaje reutiliza contacto y conversación', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event())
    await processInboundEvent(db as never, event({ mid: 'm_2', contentText: 'Otra cosa' }))

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.messages).toHaveLength(2)
  })

  it('si Meta no da el nombre, el contacto igual se crea con un nombre de respaldo', async () => {
    getUserName.mockResolvedValue(null)
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event({ psid: 'PSID-9999' }))
    expect(db.tables.contacts[0].name).toBe('Messenger ····9999')
  })

  it('una página desconocida se ignora sin guardar nada', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await expect(processInboundEvent(db as never, event({ pageId: 'OTRA' }))).resolves.toBe(
      'unknown_page',
    )
    expect(db.tables.contacts ?? []).toHaveLength(0)
  })

  it('una página desconectada no recibe mensajes', async () => {
    const db = makeFakeDb({ messenger_config: [{ ...CONFIG, status: 'disconnected' }] })
    await expect(processInboundEvent(db as never, event())).resolves.toBe('unknown_page')
  })

  it('un mensaje de imagen guarda la URL y el tipo', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(
      db as never,
      event({ contentType: 'image', contentText: null, mediaUrl: 'https://cdn/x.jpg' }),
    )
    expect(db.tables.messages[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://cdn/x.jpg',
    })
    expect(db.rpcCalls[0].args.p_last_message_text).toBe('[image]')
  })
})
