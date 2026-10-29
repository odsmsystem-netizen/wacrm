import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  verifyOtp: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: h.exchangeCodeForSession,
      verifyOtp: h.verifyOtp,
    },
  }),
}))

import { GET } from './route'

function callback(query: string) {
  const url = `http://0.0.0.0:3000/auth/callback?${query}`
  const request = new Request(url, {
    headers: {
      'x-forwarded-host': 'crm.test',
      'x-forwarded-proto': 'https',
    },
  }) as unknown as Parameters<typeof GET>[0]
  // NextRequest expone nextUrl; el resto del handler solo lo usa para leer query.
  ;(request as unknown as { nextUrl: URL }).nextUrl = new URL(url)
  return GET(request)
}

beforeEach(() => {
  vi.clearAllMocks()
  h.exchangeCodeForSession.mockResolvedValue({ error: null })
  h.verifyOtp.mockResolvedValue({ error: null })
})

describe('auth callback: flujo con code (correo normal)', () => {
  it('cambia el code por sesión y sigue a next', async () => {
    const res = await callback('code=abc&next=/reset-password')

    expect(h.exchangeCodeForSession).toHaveBeenCalledWith('abc')
    expect(res.headers.get('location')).toBe('https://crm.test/reset-password')
  })

  it('un code inválido manda a forgot-password', async () => {
    h.exchangeCodeForSession.mockResolvedValue({ error: { message: 'bad' } })

    const res = await callback('code=abc&next=/reset-password')

    expect(res.headers.get('location')).toBe('https://crm.test/forgot-password')
  })
})

describe('auth callback: enlace de recuperación con token_hash', () => {
  it('verifica el token_hash de tipo recovery y sigue a next', async () => {
    const res = await callback(
      'token_hash=HASH123&type=recovery&next=/reset-password',
    )

    expect(h.verifyOtp).toHaveBeenCalledWith({
      type: 'recovery',
      token_hash: 'HASH123',
    })
    expect(h.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toBe('https://crm.test/reset-password')
  })

  it('un token_hash vencido o ya usado manda a forgot-password', async () => {
    h.verifyOtp.mockResolvedValue({ error: { message: 'expired' } })

    const res = await callback('token_hash=HASH123&type=recovery&next=/reset-password')

    expect(res.headers.get('location')).toBe('https://crm.test/forgot-password')
  })

  it('solo acepta type=recovery: otros tipos no llegan a verifyOtp', async () => {
    for (const type of ['magiclink', 'signup', 'email_change', 'invite', '']) {
      const res = await callback(`token_hash=HASH123&type=${type}&next=/dashboard`)
      expect(res.headers.get('location')).toBe('https://crm.test/forgot-password')
    }
    expect(h.verifyOtp).not.toHaveBeenCalled()
  })

  it('un next externo se ignora (sin open redirect)', async () => {
    const res = await callback(
      'token_hash=HASH123&type=recovery&next=//evil.com',
    )

    expect(res.headers.get('location')).toBe('https://crm.test/dashboard')
  })
})
