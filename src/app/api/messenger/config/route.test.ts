import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from '@/lib/messenger/__fixtures__/fake-db'

let db = makeFakeDb()
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: db, accountId: 'acct-1', userId: 'user-1' }),
  toErrorResponse: (e: unknown) => {
    throw e
  },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc(${s})` }))
const getPage = vi.fn()
vi.mock('@/lib/messenger/graph', () => ({
  getPage: (...a: unknown[]) => getPage(...a),
  MessengerApiError: class extends Error {},
}))

import { DELETE, GET, POST } from './route'

const post = (body: unknown) =>
  new Request('https://crm.ambar-apps.cloud/api/messenger/config', {
    method: 'POST',
    body: JSON.stringify(body),
  })
const get = () => new Request('https://crm.ambar-apps.cloud/api/messenger/config')

beforeEach(() => {
  db = makeFakeDb()
  getPage.mockReset().mockResolvedValue({ id: 'PAGE1', name: 'Ambar Cargo' })
})

describe('/api/messenger/config', () => {
  it('GET sin configuración: desconectado, con la URL del webhook', async () => {
    const body = await (await GET(get())).json()
    expect(body).toEqual({
      connected: false,
      webhook_url: 'https://crm.ambar-apps.cloud/api/messenger/webhook',
    })
  })

  it('GET responde 500 (no "desconectado") si la lectura falla', async () => {
    const realFrom = db.from
    db.from = ((table: string) =>
      table === 'messenger_config'
        ? {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
              }),
            }),
          }
        : realFrom(table)) as typeof db.from
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(get())
    spy.mockRestore()
    expect(res.status).toBe(500)
    expect(await res.json()).not.toHaveProperty('connected')
  })

  it('POST valida el token contra Meta, lo guarda cifrado y genera el verify_token', async () => {
    const res = await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ connected: true, page_id: 'PAGE1', page_name: 'Ambar Cargo' })
    expect(body.verify_token).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(body)).not.toContain('TOK')

    expect(getPage).toHaveBeenCalledWith('TOK')
    expect(db.tables.messenger_config[0]).toMatchObject({
      account_id: 'acct-1',
      page_id: 'PAGE1',
      page_access_token: 'enc(TOK)',
      status: 'connected',
    })
  })

  it('POST rechaza un token que no es de esa página', async () => {
    getPage.mockResolvedValue({ id: 'OTRA', name: 'Otra' })
    const res = await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    expect(res.status).toBe(400)
    expect(db.tables.messenger_config ?? []).toHaveLength(0)
  })

  it('POST pide los dos campos', async () => {
    expect((await POST(post({ page_id: 'PAGE1' }))).status).toBe(400)
  })

  it('volver a conectar conserva el verify_token (Meta ya lo tiene guardado)', async () => {
    const first = await (await POST(post({ page_id: 'PAGE1', page_access_token: 'T1' }))).json()
    const second = await (await POST(post({ page_id: 'PAGE1', page_access_token: 'T2' }))).json()
    expect(second.verify_token).toBe(first.verify_token)
    expect(db.tables.messenger_config).toHaveLength(1)
    expect(db.tables.messenger_config[0].page_access_token).toBe('enc(T2)')
  })

  it('DELETE desconecta', async () => {
    await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(db.tables.messenger_config).toHaveLength(0)
  })
})
