import { describe, expect, it } from 'vitest'
import { parseChannelParam } from './channel'

describe('parseChannelParam', () => {
  it('Review Focus 6: sin parámetro es whatsapp, para no cambiar el contrato que usa Claudia', () => {
    expect(parseChannelParam(null)).toEqual({ channel: 'whatsapp' })
  })
  it('acepta messenger explícito', () => {
    expect(parseChannelParam('messenger')).toEqual({ channel: 'messenger' })
    expect(parseChannelParam('whatsapp')).toEqual({ channel: 'whatsapp' })
  })
  it('rechaza cualquier otro valor en vez de ignorarlo', () => {
    expect(parseChannelParam('telegram')).toEqual({
      error: "'channel' must be 'whatsapp' or 'messenger'",
    })
    expect(parseChannelParam('')).toEqual({ error: "'channel' must be 'whatsapp' or 'messenger'" })
  })
})
