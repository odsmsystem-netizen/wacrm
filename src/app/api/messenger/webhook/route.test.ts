import { beforeEach, describe, expect, it, vi } from 'vitest'

const tasks: Promise<unknown>[] = []
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    tasks.push(Promise.resolve(fn()))
  },
}))

let signatureOk = true
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => signatureOk }))

const processInboundEvent = vi.fn().mockResolvedValue('stored')
vi.mock('@/lib/messenger/inbound', () => ({
  processInboundEvent: (...a: unknown[]) => processInboundEvent(...a),
}))

let configs: Array<{ verify_token: string }> = []
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: async () => ({ data: configs, error: null }) }),
  }),
}))

import { GET, POST } from './route'

const postReq = (body: unknown) =>
  new Request('http://x/api/messenger/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': 'sha256=abc' },
    body: JSON.stringify(body),
  })

const payload = {
  object: 'page',
  entry: [
    {
      id: 'PAGE1',
      messaging: [
        { sender: { id: 'P1' }, timestamp: 1, message: { mid: 'm_1', text: 'Hola' } },
        { sender: { id: 'P1' }, timestamp: 2, message: { mid: 'm_2', text: 'eco', is_echo: true } },
      ],
    },
  ],
}

beforeEach(() => {
  tasks.length = 0
  signatureOk = true
  configs = [{ verify_token: 'secreto-123' }]
  processInboundEvent.mockClear()
})

describe('GET /api/messenger/webhook', () => {
  const url = (token: string) =>
    new Request(
      `http://x/api/messenger/webhook?hub.mode=subscribe&hub.challenge=CH&hub.verify_token=${token}`,
    )

  it('devuelve el desafío si el token coincide', async () => {
    const res = await GET(url('secreto-123'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CH')
  })
  it('rechaza un token que no coincide', async () => {
    expect((await GET(url('otro'))).status).toBe(403)
  })
  it('pide los parámetros que faltan', async () => {
    expect((await GET(new Request('http://x/api/messenger/webhook'))).status).toBe(400)
  })
})

describe('POST /api/messenger/webhook', () => {
  it('rechaza con 401 una firma inválida y no procesa nada', async () => {
    signatureOk = false
    const res = await POST(postReq(payload))
    expect(res.status).toBe(401)
    await Promise.all(tasks)
    expect(processInboundEvent).not.toHaveBeenCalled()
  })

  it('responde 200 y procesa solo los mensajes reales, no los ecos', async () => {
    const res = await POST(postReq(payload))
    expect(res.status).toBe(200)
    await Promise.all(tasks)
    expect(processInboundEvent).toHaveBeenCalledTimes(1)
    expect(processInboundEvent.mock.calls[0][1]).toMatchObject({ mid: 'm_1', psid: 'P1' })
  })

  it('responde 400 si el cuerpo no es JSON', async () => {
    const res = await POST(
      new Request('http://x/api/messenger/webhook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=abc' },
        body: 'no json',
      }),
    )
    expect(res.status).toBe(400)
  })
})
