import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from './__fixtures__/fake-db'
import { MESSENGER_WINDOW_MS, MessengerSendError, sendMessengerText } from './send'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec(${s})` }))

const { FakeApiError, sendText } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(m: string, public status: number, public code?: number) {
      super(m)
    }
  }
  return { FakeApiError, sendText: vi.fn() }
})
vi.mock('./graph', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  MessengerApiError: FakeApiError,
}))

const NOW = Date.parse('2026-10-06T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString()

function seedMessages(msgs: Array<{ sender: 'customer' | 'agent'; hoursAgo: number }>) {
  const db = seed({ lastInboundHoursAgo: null })
  db.tables.messages.push(
    ...msgs.map((m, i) => ({
      id: `mm${i}`,
      conversation_id: 'conv1',
      sender_type: m.sender,
      created_at: hoursAgo(m.hoursAgo),
    })),
  )
  return db
}

/** Hace que una operación concreta sobre una tabla devuelva un error de la base. */
function failOn(db: ReturnType<typeof seed>, table: string, op: 'insert' | 'update') {
  const realFrom = db.from
  db.from = ((t: string) => {
    const b = realFrom(t)
    if (t !== table) return b
    const real = b[op]
    b[op] = (...a: unknown[]) => {
      real(...a)
      const failing: Record<string, unknown> = {
        eq: () => failing,
        select: () => failing,
        single: async () => ({ data: null, error: { message: 'boom' } }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: 'boom' } }),
      }
      return failing
    }
    return b
  }) as typeof db.from
}

function seed(over: { lastInboundHoursAgo?: number | null; channel?: string } = {}) {
  const { lastInboundHoursAgo = 1, channel = 'messenger' } = over
  return makeFakeDb({
    messenger_config: [{ id: 'cfg-1', account_id: 'acct-1', page_access_token: 'enc', status: 'connected' }],
    contacts: [{ id: 'c1', account_id: 'acct-1', channel: 'messenger', external_id: 'PSID1' }],
    conversations: [{ id: 'conv1', account_id: 'acct-1', contact_id: 'c1', channel }],
    messages:
      lastInboundHoursAgo === null
        ? []
        : [
            {
              id: 'm0',
              conversation_id: 'conv1',
              sender_type: 'customer',
              created_at: hoursAgo(lastInboundHoursAgo),
            },
          ],
  })
}
const params = { conversationId: 'conv1', text: 'Hola' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  sendText.mockReset().mockResolvedValue({ messageId: 'm_sent' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sendMessengerText', () => {
  it('envía dentro de la ventana y guarda el mensaje saliente', async () => {
    const db = seed()
    const r = await sendMessengerText(db as never, 'acct-1', params)
    expect(sendText).toHaveBeenCalledWith('dec(enc)', 'PSID1', 'Hola')
    expect(r.mid).toBe('m_sent')
    const out = db.tables.messages.find((m) => m.sender_type === 'agent')!
    expect(out).toMatchObject({ content_text: 'Hola', message_id: 'm_sent', status: 'sent' })
    expect(db.tables.conversations[0].last_message_text).toBe('Hola')
  })

  it('Review Focus 4: pasadas 24 h no llama a Meta y avisa window_closed (409)', async () => {
    const db = seed({ lastInboundHoursAgo: MESSENGER_WINDOW_MS / 3600_000 + 1 })
    const err = await sendMessengerText(db as never, 'acct-1', params).catch((e) => e)
    expect(err).toBeInstanceOf(MessengerSendError)
    expect(err).toMatchObject({ code: 'window_closed', status: 409 })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('sin ningún mensaje del cliente tampoco hay ventana abierta', async () => {
    const db = seed({ lastInboundHoursAgo: null })
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'window_closed',
    })
  })

  it('Review Focus 5: un token revocado (190) desconecta la página y avisa', async () => {
    sendText.mockRejectedValue(new FakeApiError('Token vencido', 400, 190))
    const db = seed()
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'token_invalid',
      status: 401,
    })
    expect(db.tables.messenger_config[0].status).toBe('disconnected')
    expect(db.tables.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0)
  })

  it('otro error de Meta se reporta sin desconectar nada', async () => {
    sendText.mockRejectedValue(new FakeApiError('Rate limit', 429, 4))
    const db = seed()
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'meta_error',
    })
    expect(db.tables.messenger_config[0].status).toBe('connected')
  })

  it('rechaza una conversación de WhatsApp', async () => {
    const db = seed({ channel: 'whatsapp' })
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'wrong_channel',
      status: 400,
    })
  })

  it('no toca conversaciones de otra cuenta', async () => {
    const db = seed()
    await expect(sendMessengerText(db as never, 'otra-cuenta', params)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
  })

  it('la ventana se mide desde el ÚLTIMO mensaje del cliente (viejo insertado primero)', async () => {
    const db = seedMessages([
      { sender: 'customer', hoursAgo: 30 },
      { sender: 'customer', hoursAgo: 1 },
    ])
    await expect(sendMessengerText(db as never, 'acct-1', params)).resolves.toMatchObject({ mid: 'm_sent' })
  })

  it('la ventana se mide desde el ÚLTIMO mensaje del cliente (reciente insertado primero)', async () => {
    const db = seedMessages([
      { sender: 'customer', hoursAgo: 1 },
      { sender: 'customer', hoursAgo: 30 },
    ])
    await expect(sendMessengerText(db as never, 'acct-1', params)).resolves.toMatchObject({ mid: 'm_sent' })
  })

  it('un mensaje reciente del AGENTE no reabre la ventana', async () => {
    const db = seedMessages([
      { sender: 'customer', hoursAgo: 30 },
      { sender: 'agent', hoursAgo: 1 },
    ])
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'window_closed',
    })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('si falla actualizar la vista previa de la conversación, lo registra y sigue con éxito', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = seed()
    failOn(db, 'conversations', 'update')
    await expect(sendMessengerText(db as never, 'acct-1', params)).resolves.toMatchObject({ mid: 'm_sent' })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('conv1'), expect.stringContaining('boom'))
    spy.mockRestore()
  })

  it('si falla marcar la página como desconectada, lo registra y el agente sigue recibiendo token_invalid', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    sendText.mockRejectedValue(new FakeApiError('Token vencido', 400, 190))
    const db = seed()
    failOn(db, 'messenger_config', 'update')
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'token_invalid',
    })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('cfg-1'), expect.stringContaining('boom'))
    spy.mockRestore()
  })

  it('si falla guardar el saliente tras enviarlo a Meta, registra el mid y avisa que NO se reenvíe', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = seed()
    failOn(db, 'messages', 'insert')
    const err = await sendMessengerText(db as never, 'acct-1', params).catch((e) => e)
    expect(err).toBeInstanceOf(MessengerSendError)
    expect(err).toMatchObject({ code: 'db_error', status: 500 })
    expect(err.message).toMatch(/delivered/i)
    expect(err.message).toMatch(/not resend|do not resend/i)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('m_sent'), expect.stringContaining('boom'))
    spy.mockRestore()
  })
})
