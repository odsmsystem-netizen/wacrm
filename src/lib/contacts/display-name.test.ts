import { describe, expect, it } from 'vitest'
import { contactDisplayName } from './display-name'

describe('contactDisplayName', () => {
  it('prefiere el nombre', () => {
    expect(contactDisplayName({ name: 'Ana', phone: '+521', external_id: 'p1' })).toBe('Ana')
  })
  it('cae al teléfono y luego al PSID', () => {
    expect(contactDisplayName({ name: '', phone: '+521' })).toBe('+521')
    expect(contactDisplayName({ name: null, phone: null, external_id: 'p1' })).toBe('p1')
  })
  it('usa el respaldo cuando no hay nada, y no revienta con null', () => {
    expect(contactDisplayName(null, 'Desconocido')).toBe('Desconocido')
    expect(contactDisplayName(undefined)).toBe('')
  })
})
