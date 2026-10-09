import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessengerApiError, getUserName, inspectPageToken, sendText } from './graph'

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
  it('inspectPageToken lee la página dueña del token con debug_token, sin pedir pages_read_engagement', async () => {
    const f = mockFetch(200, { data: { type: 'PAGE', profile_id: '123', is_valid: true } })
    await expect(inspectPageToken('tok')).resolves.toEqual({
      pageId: '123',
      isValid: true,
      type: 'PAGE',
    })
    expect(f.mock.calls[0][0]).toContain('/v21.0/debug_token?input_token=tok')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('inspectPageToken codifica el token en la URL', async () => {
    const f = mockFetch(200, { data: { type: 'PAGE', profile_id: '1', is_valid: true } })
    await inspectPageToken('a b&c')
    expect(f.mock.calls[0][0]).toContain('input_token=a%20b%26c')
  })

  it('inspectPageToken marca inválido un token que Meta rechaza o una respuesta sin datos', async () => {
    mockFetch(200, { data: { is_valid: false, error: { message: 'Session expired' } } })
    await expect(inspectPageToken('tok')).resolves.toEqual({
      pageId: '',
      isValid: false,
      type: '',
    })
    mockFetch(200, {})
    await expect(inspectPageToken('tok')).resolves.toMatchObject({ isValid: false })
  })

  it('inspectPageToken propaga el error de Meta como MessengerApiError', async () => {
    mockFetch(400, { error: { message: 'Invalid OAuth access token', code: 190 } })
    const err = await inspectPageToken('tok').catch((e) => e)
    expect(err).toBeInstanceOf(MessengerApiError)
    expect(err.code).toBe(190)
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
