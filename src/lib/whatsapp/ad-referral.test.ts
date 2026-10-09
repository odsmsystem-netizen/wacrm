import { describe, expect, it } from 'vitest'
import { extractAdReferral } from './ad-referral'

const NOW = new Date('2026-10-09T12:00:00.000Z')

const fullAd = {
  source_url: 'https://fb.me/abc',
  source_id: '1234567890',
  source_type: 'ad',
  headline: 'Envíos a Estados Unidos',
  body: 'Cotiza hoy',
  media_type: 'image',
  image_url: 'https://cdn.example.com/a.jpg',
  video_url: 'https://cdn.example.com/a.mp4',
  thumbnail_url: 'https://cdn.example.com/t.jpg',
  ctwa_clid: 'clid-1',
}

describe('extractAdReferral', () => {
  it('lee un anuncio completo', () => {
    expect(extractAdReferral(fullAd, NOW)).toEqual({
      ...fullAd,
      captured_at: '2026-10-09T12:00:00.000Z',
    })
  })

  it('lee una publicación (post)', () => {
    const r = extractAdReferral({ source_type: 'post', source_id: '77' }, NOW)
    expect(r?.source_type).toBe('post')
    expect(r?.source_id).toBe('77')
    expect(r?.headline).toBeNull()
  })

  it('sin source_type devuelve null', () => {
    const { source_type: _t, ...rest } = fullAd
    void _t
    expect(extractAdReferral(rest, NOW)).toBeNull()
  })

  it('source_type desconocido devuelve null', () => {
    expect(extractAdReferral({ ...fullAd, source_type: 'story' }, NOW)).toBeNull()
  })

  it('raw que no es objeto devuelve null', () => {
    expect(extractAdReferral(null, NOW)).toBeNull()
    expect(extractAdReferral(undefined, NOW)).toBeNull()
    expect(extractAdReferral('ad', NOW)).toBeNull()
    expect(extractAdReferral([fullAd], NOW)).toBeNull()
    expect(extractAdReferral(42, NOW)).toBeNull()
  })

  it('rechaza URLs que no son https', () => {
    const r = extractAdReferral(
      {
        ...fullAd,
        source_url: 'javascript:alert(1)',
        image_url: 'http://cdn.example.com/a.jpg',
        video_url: 'data:text/html,hola',
        thumbnail_url: 'HTTPS://x.com/t.jpg',
      },
      NOW,
    )
    expect(r?.source_url).toBeNull()
    expect(r?.image_url).toBeNull()
    expect(r?.video_url).toBeNull()
    expect(r?.thumbnail_url).toBeNull()
  })

  it('campos de tipo erróneo quedan en null', () => {
    const r = extractAdReferral(
      { source_type: 'ad', source_id: 123, headline: { a: 1 }, body: ['x'], ctwa_clid: true },
      NOW,
    )
    expect(r?.source_type).toBe('ad')
    expect(r?.source_id).toBeNull()
    expect(r?.headline).toBeNull()
    expect(r?.body).toBeNull()
    expect(r?.ctwa_clid).toBeNull()
  })

  it('recorta espacios y vacíos quedan null', () => {
    const r = extractAdReferral(
      { source_type: 'ad', headline: '  Hola  ', body: '   ', source_id: '' },
      NOW,
    )
    expect(r?.headline).toBe('Hola')
    expect(r?.body).toBeNull()
    expect(r?.source_id).toBeNull()
  })

  it('texto más largo que el límite se trunca; URL más larga se descarta', () => {
    const r = extractAdReferral(
      {
        source_type: 'ad',
        headline: 'h'.repeat(400),
        body: 'b'.repeat(1500),
        source_id: 'i'.repeat(300),
        ctwa_clid: 'c'.repeat(300),
        media_type: 'm'.repeat(300),
        source_url: 'https://x.com/' + 'u'.repeat(2000),
        image_url: 'https://x.com/' + 'u'.repeat(1900),
      },
      NOW,
    )
    expect(r?.headline).toHaveLength(300)
    expect(r?.body).toHaveLength(1000)
    expect(r?.source_id).toHaveLength(200)
    expect(r?.ctwa_clid).toHaveLength(200)
    expect(r?.media_type).toHaveLength(200)
    expect(r?.source_url).toBeNull()
    expect(r?.image_url).not.toBeNull()
  })
})
