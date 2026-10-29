import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadTargetMember: vi.fn(),
  getUserById: vi.fn(),
  generateLink: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(() => Response.json({ error: 'slow down' }, { status: 429 })),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}))
vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAuthAdmin: () => ({
    auth: { admin: { getUserById: mocks.getUserById, generateLink: mocks.generateLink } },
  }),
}))
vi.mock('@/lib/auth/member-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/member-access')>()
  return { ...real, loadTargetMember: mocks.loadTargetMember }
})

import { MemberTargetError } from '@/lib/auth/member-access'
import { POST } from './route'

const UUID = '22222222-2222-4222-8222-222222222222'
const owner = { supabase: {}, accountId: 'account-1', userId: 'owner-1', role: 'owner' }

function llamar() {
  return POST(
    new Request('http://0.0.0.0:3000/x', {
      method: 'POST',
      headers: { 'x-forwarded-host': 'crm.test', 'x-forwarded-proto': 'https' },
    }),
    { params: Promise.resolve({ userId: UUID }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue(owner)
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadTargetMember.mockResolvedValue({ userId: UUID, role: 'agent' })
  mocks.getUserById.mockResolvedValue({ data: { user: { email: 'marketing@ambarcargo.com' } }, error: null })
  mocks.generateLink.mockResolvedValue({ data: { properties: { hashed_token: 'HASH' } }, error: null })
})

describe('POST /api/account/members/[userId]/reset-password', () => {
  it('exige ser propietario', async () => {
    await llamar()

    expect(mocks.requireRole).toHaveBeenCalledWith('owner')
  })

  it('un no propietario recibe lo que devuelve toErrorResponse y no se genera nada', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'))

    const res = await llamar()

    expect(res.status).toBe(403)
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('genera el enlace de recuperación del correo real del miembro', async () => {
    const res = await llamar()

    expect(mocks.generateLink).toHaveBeenCalledWith({
      type: 'recovery',
      email: 'marketing@ambarcargo.com',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      link: 'https://crm.test/auth/callback?token_hash=HASH&type=recovery&next=%2Freset-password',
    })
  })

  it('la respuesta no se cachea', async () => {
    const res = await llamar()

    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('respeta el límite de intentos', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false })

    const res = await llamar()

    expect(res.status).toBe(429)
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('un objetivo inválido (propietario, uno mismo, ajeno) devuelve su estado', async () => {
    mocks.loadTargetMember.mockRejectedValue(new MemberTargetError(400, 'Cannot target the owner'))

    const res = await llamar()

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Cannot target the owner' })
    expect(mocks.generateLink).not.toHaveBeenCalled()
  })

  it('si Supabase no devuelve el token, da 502 y no inventa un enlace', async () => {
    mocks.generateLink.mockResolvedValue({ data: { properties: {} }, error: null })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await llamar()

    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('token_hash')
    spy.mockRestore()
  })

  it('no escribe el token en los logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.generateLink.mockResolvedValue({ data: null, error: { message: 'boom HASH-SECRETO' } })

    await llamar()

    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('HASH')
    }
    spy.mockRestore()
  })
})
