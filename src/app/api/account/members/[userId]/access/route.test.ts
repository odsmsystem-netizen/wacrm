import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkRateLimit: vi.fn(),
  loadTargetMember: vi.fn(),
  updateUserById: vi.fn(),
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
  supabaseAuthAdmin: () => ({ auth: { admin: { updateUserById: mocks.updateUserById } } }),
}))
vi.mock('@/lib/auth/member-access', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/auth/member-access')>()
  return { ...real, loadTargetMember: mocks.loadTargetMember }
})

import { MemberTargetError } from '@/lib/auth/member-access'
import { PUT } from './route'

const UUID = '22222222-2222-4222-8222-222222222222'
const owner = { supabase: {}, accountId: 'account-1', userId: 'owner-1', role: 'owner' }

function llamar(body: unknown) {
  return PUT(
    new Request('http://x/y', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId: UUID }) },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireRole.mockResolvedValue(owner)
  mocks.checkRateLimit.mockReturnValue({ success: true })
  mocks.loadTargetMember.mockResolvedValue({ userId: UUID, role: 'agent' })
  mocks.updateUserById.mockResolvedValue({ data: {}, error: null })
})

describe('PUT /api/account/members/[userId]/access', () => {
  it('exige ser propietario', async () => {
    await llamar({ blocked: true })

    expect(mocks.requireRole).toHaveBeenCalledWith('owner')
  })

  it('un no propietario no bloquea a nadie', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'))

    const res = await llamar({ blocked: true })

    expect(res.status).toBe(403)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('bloquear aplica el ban de larga duración', async () => {
    const res = await llamar({ blocked: true })

    expect(mocks.updateUserById).toHaveBeenCalledWith(UUID, { ban_duration: '876000h' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ blocked: true })
  })

  it('devolver el acceso quita el ban', async () => {
    const res = await llamar({ blocked: false })

    expect(mocks.updateUserById).toHaveBeenCalledWith(UUID, { ban_duration: 'none' })
    expect(await res.json()).toEqual({ blocked: false })
  })

  it.each([{}, { blocked: 'yes' }, { blocked: 1 }, null, 'no es json'])(
    'rechaza un cuerpo inválido (%j) con 400',
    async (body) => {
      const res = await llamar(body)

      expect(res.status).toBe(400)
      expect(mocks.updateUserById).not.toHaveBeenCalled()
    },
  )

  it('respeta el límite de intentos', async () => {
    mocks.checkRateLimit.mockReturnValue({ success: false })

    const res = await llamar({ blocked: true })

    expect(res.status).toBe(429)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('no bloquea a un propietario, a uno mismo ni a un ajeno', async () => {
    mocks.loadTargetMember.mockRejectedValue(new MemberTargetError(400, 'Cannot target the owner'))

    const res = await llamar({ blocked: true })

    expect(res.status).toBe(400)
    expect(mocks.updateUserById).not.toHaveBeenCalled()
  })

  it('si Supabase falla, responde 502', async () => {
    mocks.updateUserById.mockResolvedValue({ data: null, error: { message: 'boom' } })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await llamar({ blocked: true })

    expect(res.status).toBe(502)
    spy.mockRestore()
  })
})
