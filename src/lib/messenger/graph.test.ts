import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessengerApiError, getPage, getUserName, sendText } from './graph'

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('graph', () => {
  it('getPage devuelve id y nombre', async () => {
    const f = mockFetch(200, { id: '123', name: 'Ambar Cargo' })
    await expect(getPage('tok')).resolves.toEqual({ id: '123', name: 'Ambar Cargo' })
    expect(f.mock.calls[0][0]).toContain('/v21.0/me?fields=id,name')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('sendText manda RESPONSE al PSID y devuelve el mid', async () => {
    const f = mockFetch(200, { recipient_id: 'psid1', message_id: 'm_abc' })
    await expect(sendText('tok', 'psid1', 'hola')).resolves.toEqual({ messageId: 'm_abc' })
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body).toEqual({
      recipient: { id: 'psid1' },
      messaging_type: 'RESPONSE',
      message: { text: 'hola' },
    })
  })

  it('un error de Meta se vuelve MessengerApiError con su código', async () => {
    mockFetch(400, { error: { message: 'Token vencido', code: 190 } })
    const err = await sendText('tok', 'p', 'x').catch((e) => e)
    expect(err).toBeInstanceOf(MessengerApiError)
    expect(err.code).toBe(190)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Token vencido')
  })

  it('getUserName devuelve null si Meta falla, en vez de lanzar', async () => {
    mockFetch(500, {})
    await expect(getUserName('tok', 'p')).resolves.toBeNull()
  })

  it('getUserName devuelve el nombre', async () => {
    mockFetch(200, { name: 'Juan Pérez' })
    await expect(getUserName('tok', 'p')).resolves.toBe('Juan Pérez')
  })
})
