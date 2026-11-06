import { describe, it, expect } from 'vitest'
import { medianMinutesToAssign, pctOf } from './lead-funnel'

const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString()

describe('medianMinutesToAssign', () => {
  it('calcula la mediana con cantidad impar y par', () => {
    expect(
      medianMinutesToAssign([
        { created_at: at(0), assigned_at: at(3) },
        { created_at: at(0), assigned_at: at(1) },
        { created_at: at(0), assigned_at: at(10) },
      ]),
    ).toBe(3)
    expect(
      medianMinutesToAssign([
        { created_at: at(0), assigned_at: at(2) },
        { created_at: at(0), assigned_at: at(4) },
      ]),
    ).toBe(3)
  })

  it('ignora filas sin fechas o con asignación anterior a la creación', () => {
    expect(
      medianMinutesToAssign([
        { created_at: at(5), assigned_at: at(1) },
        { created_at: at(0), assigned_at: null },
        { created_at: null, assigned_at: at(2) },
      ]),
    ).toBeNull()
  })
})

describe('pctOf', () => {
  it('redondea y protege la división por cero', () => {
    expect(pctOf(1, 3)).toBe(33)
    expect(pctOf(5, 0)).toBe(0)
  })
})
