import { describe, expect, it } from 'vitest'
import { requestOrigin } from './request-origin'

const req = (headers: Record<string, string>) => new Request('http://0.0.0.0:3000/x', { headers })

describe('requestOrigin', () => {
  it('prefiere el host que reenvía el proxy', () => {
    expect(
      requestOrigin(req({ 'x-forwarded-host': 'crm.ambar-apps.cloud', 'x-forwarded-proto': 'https' })),
    ).toBe('https://crm.ambar-apps.cloud')
  })
  it('toma el primero de una lista de proxies', () => {
    expect(
      requestOrigin(req({ 'x-forwarded-host': 'a.com, b.com', 'x-forwarded-proto': 'https, http' })),
    ).toBe('https://a.com')
  })
  it('sin proxy usa el host de la petición', () => {
    expect(requestOrigin(req({ host: 'localhost:3000' }))).toBe('http://localhost:3000')
  })
})
