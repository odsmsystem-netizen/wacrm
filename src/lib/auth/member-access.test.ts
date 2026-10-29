import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getUserById: vi.fn(),
}))

vi.mock('./admin-client', () => ({
  supabaseAuthAdmin: () => ({ auth: { admin: { getUserById: mocks.getUserById } } }),
}))

import {
  BLOCK_DURATION,
  UNBLOCK_DURATION,
  MemberTargetError,
  buildRecoveryLink,
  loadBlockedUserIds,
  loadTargetMember,
} from './member-access'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

function ctxWith(row: { user_id: string; account_role: string } | null, userId = UUID_A) {
  const filtros: Record<string, string> = {}
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      filtros[col] = val
      return builder
    },
    maybeSingle: () => Promise.resolve({ data: row, error: null, filtros }),
  }
  return {
    ctx: { supabase: { from: vi.fn(() => builder) }, accountId: 'account-1', userId } as never,
    filtros,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('buildRecoveryLink', () => {
  it('apunta al callback del CRM con token_hash, type=recovery y next', () => {
    expect(buildRecoveryLink('https://crm.test', 'HASH')).toBe(
      'https://crm.test/auth/callback?token_hash=HASH&type=recovery&next=%2Freset-password',
    )
  })

  it('escapa el token', () => {
    expect(buildRecoveryLink('https://crm.test', 'a b&c')).toContain('token_hash=a%20b%26c')
  })
})

describe('duraciones de bloqueo', () => {
  it('bloquear es "para siempre" y desbloquear es none', () => {
    expect(BLOCK_DURATION).toBe('876000h')
    expect(UNBLOCK_DURATION).toBe('none')
  })
})

describe('loadTargetMember', () => {
  it('devuelve al miembro de la cuenta del propietario', async () => {
    const { ctx, filtros } = ctxWith({ user_id: UUID_B, account_role: 'agent' })

    await expect(loadTargetMember(ctx, UUID_B)).resolves.toEqual({
      userId: UUID_B,
      role: 'agent',
    })
    // Acotado a la cuenta del que llama: nunca se busca en otra.
    expect(filtros).toMatchObject({ user_id: UUID_B, account_id: 'account-1' })
  })

  it('un id que no es UUID da 404 sin tocar la base', async () => {
    const { ctx } = ctxWith(null)

    await expect(loadTargetMember(ctx, '../etc/passwd')).rejects.toMatchObject({ status: 404 })
    expect((ctx as never as { supabase: { from: () => void } }).supabase.from).not.toHaveBeenCalled()
  })

  it('alguien de otra cuenta (o inexistente) da 404', async () => {
    const { ctx } = ctxWith(null)

    await expect(loadTargetMember(ctx, UUID_B)).rejects.toMatchObject({ status: 404 })
  })

  it('no permite actuar sobre uno mismo', async () => {
    const { ctx } = ctxWith({ user_id: UUID_A, account_role: 'owner' }, UUID_A)

    await expect(loadTargetMember(ctx, UUID_A)).rejects.toBeInstanceOf(MemberTargetError)
    await expect(loadTargetMember(ctx, UUID_A)).rejects.toMatchObject({ status: 400 })
  })

  it('no permite actuar sobre un propietario', async () => {
    const { ctx } = ctxWith({ user_id: UUID_B, account_role: 'owner' })

    await expect(loadTargetMember(ctx, UUID_B)).rejects.toMatchObject({ status: 400 })
  })
})

describe('loadBlockedUserIds', () => {
  const futuro = new Date(Date.now() + 3600_000).toISOString()
  const pasado = new Date(Date.now() - 3600_000).toISOString()

  it('marca solo a quienes tienen banned_until en el futuro', async () => {
    mocks.getUserById.mockImplementation(async (id: string) => ({
      data: { user: { id, banned_until: id === UUID_A ? futuro : id === UUID_B ? pasado : null } },
      error: null,
    }))

    const ids = await loadBlockedUserIds([UUID_A, UUID_B, 'otro'])

    expect([...ids]).toEqual([UUID_A])
  })

  it('un fallo al consultar a uno no tumba a los demás', async () => {
    mocks.getUserById.mockImplementation(async (id: string) => {
      if (id === UUID_B) throw new Error('red caída')
      return { data: { user: { id, banned_until: futuro } }, error: null }
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ids = await loadBlockedUserIds([UUID_A, UUID_B])

    expect([...ids]).toEqual([UUID_A])
    spy.mockRestore()
  })
})
