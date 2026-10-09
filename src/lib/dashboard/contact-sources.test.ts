import { describe, expect, it } from 'vitest'
import { sourceShares } from './contact-sources'
import type { ContactSourcesData } from './types'

const sum = (s: ReturnType<typeof sourceShares>) =>
  s.whatsappOrganic + s.whatsappAd + s.whatsappPost + s.messenger

describe('sourceShares', () => {
  it('reparto exacto', () => {
    const d: ContactSourcesData = {
      total: 100,
      whatsappOrganic: 50,
      whatsappAd: 30,
      whatsappPost: 0,
      messenger: 20,
    }
    expect(sourceShares(d)).toEqual({
      whatsappOrganic: 50,
      whatsappAd: 30,
      whatsappPost: 0,
      messenger: 20,
    })
  })

  it('un tercio cada uno suma 100', () => {
    const s = sourceShares({
      total: 3,
      whatsappOrganic: 1,
      whatsappAd: 1,
      whatsappPost: 0,
      messenger: 1,
    })
    expect(sum(s)).toBe(100)
    expect(Object.values(s).sort()).toEqual([0, 33, 33, 34])
  })

  it('total 0 devuelve ceros sin dividir entre cero', () => {
    expect(
      sourceShares({
        total: 0,
        whatsappOrganic: 0,
        whatsappAd: 0,
        whatsappPost: 0,
        messenger: 0,
      }),
    ).toEqual({ whatsappOrganic: 0, whatsappAd: 0, whatsappPost: 0, messenger: 0 })
  })

  it('un solo origen es 100', () => {
    const s = sourceShares({
      total: 7,
      whatsappOrganic: 0,
      whatsappAd: 7,
      whatsappPost: 0,
      messenger: 0,
    })
    expect(s.whatsappAd).toBe(100)
    expect(sum(s)).toBe(100)
  })

  it('reparte el residuo al mayor y siempre suma 100', () => {
    const s = sourceShares({
      total: 7,
      whatsappOrganic: 3,
      whatsappAd: 2,
      whatsappPost: 1,
      messenger: 1,
    })
    // 42.86, 28.57, 14.29, 14.29 -> 42, 28, 14, 14 = 98; residuos .86 y .57
    expect(s).toEqual({
      whatsappOrganic: 43,
      whatsappAd: 29,
      whatsappPost: 14,
      messenger: 14,
    })
    expect(sum(s)).toBe(100)
  })
})
