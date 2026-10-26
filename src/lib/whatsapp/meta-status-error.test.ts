import { describe, it, expect } from 'vitest'
import { describeMetaStatusError } from './meta-status-error'

describe('describeMetaStatusError', () => {
  it('une código y título', () => {
    expect(
      describeMetaStatusError([
        { code: 131042, title: 'Business eligibility payment issue' },
      ]),
    ).toBe('131042 · Business eligibility payment issue')
  })

  it('agrega el detalle de error_data', () => {
    expect(
      describeMetaStatusError([
        {
          code: 131026,
          title: 'Message undeliverable',
          error_data: { details: 'Unable to deliver message.' },
        },
      ]),
    ).toBe('131026 · Message undeliverable — Unable to deliver message.')
  })

  it('no repite el detalle si es igual al título', () => {
    expect(
      describeMetaStatusError([
        { code: 1, title: 'Boom', error_data: { details: 'Boom' } },
      ]),
    ).toBe('1 · Boom')
  })

  it('cae a message cuando no hay título', () => {
    expect(describeMetaStatusError([{ code: 2, message: 'Sin título' }])).toBe(
      '2 · Sin título',
    )
  })

  it('usa solo el primer error', () => {
    expect(
      describeMetaStatusError([
        { code: 10, title: 'Primero' },
        { code: 20, title: 'Segundo' },
      ]),
    ).toBe('10 · Primero')
  })

  it('devuelve null sin errores o sin contenido útil', () => {
    expect(describeMetaStatusError(undefined)).toBeNull()
    expect(describeMetaStatusError(null)).toBeNull()
    expect(describeMetaStatusError([])).toBeNull()
    expect(describeMetaStatusError([{}])).toBeNull()
  })

  it('recorta textos larguísimos', () => {
    const out = describeMetaStatusError([{ code: 3, title: 'x'.repeat(2000) }])
    expect(out).not.toBeNull()
    expect(out!.length).toBe(500)
    expect(out!.endsWith('…')).toBe(true)
  })
})
