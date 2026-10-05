import { describe, expect, it } from 'vitest'
import { extractInboundEvents } from './parse-webhook'

const wrap = (messaging: unknown[]) => ({
  object: 'page',
  entry: [{ id: 'PAGE1', time: 1, messaging }],
})
const msg = (extra: Record<string, unknown>) => ({
  sender: { id: 'PSID1' },
  recipient: { id: 'PAGE1' },
  timestamp: 1700000000000,
  message: { mid: 'm_1', ...extra },
})

describe('extractInboundEvents', () => {
  it('extrae un mensaje de texto', () => {
    const [e] = extractInboundEvents(wrap([msg({ text: 'Hola' })]))
    expect(e).toEqual({
      pageId: 'PAGE1',
      psid: 'PSID1',
      mid: 'm_1',
      timestamp: 1700000000000,
      contentType: 'text',
      contentText: 'Hola',
      mediaUrl: null,
    })
  })

  it('extrae una imagen con su URL', () => {
    const [e] = extractInboundEvents(
      wrap([msg({ attachments: [{ type: 'image', payload: { url: 'https://cdn/x.jpg' } }] })]),
    )
    expect(e.contentType).toBe('image')
    expect(e.mediaUrl).toBe('https://cdn/x.jpg')
  })

  it('Review Focus 2: ignora el eco del propio envío de la página', () => {
    expect(extractInboundEvents(wrap([msg({ text: 'x', is_echo: true })]))).toEqual([])
  })

  it('Review Focus 3: un adjunto desconocido no revienta y se guarda como texto', () => {
    const [e] = extractInboundEvents(
      wrap([msg({ attachments: [{ type: 'audio', payload: { url: 'https://cdn/a.mp4' } }] })]),
    )
    expect(e.contentType).toBe('text')
    expect(e.contentText).toBe('[audio recibido]')
    expect(e.mediaUrl).toBeNull()
  })

  it('ignora lo que no es un mensaje (entregas, lecturas) y lo malformado', () => {
    expect(
      extractInboundEvents(wrap([{ sender: { id: 'P' }, delivery: { mids: ['m'] } }])),
    ).toEqual([])
    expect(extractInboundEvents(null)).toEqual([])
    expect(extractInboundEvents({ object: 'whatsapp_business_account' })).toEqual([])
    expect(extractInboundEvents(wrap([{ message: { text: 'sin remitente' } }]))).toEqual([])
    expect(extractInboundEvents(wrap([msg({ mid: undefined, text: 'sin mid' })]))).toEqual([])
  })

  it('procesa varias páginas y varios mensajes en una entrega', () => {
    const body = {
      object: 'page',
      entry: [
        { id: 'A', messaging: [msg({ text: '1' }), msg({ mid: 'm_2', text: '2' })] },
        { id: 'B', messaging: [msg({ mid: 'm_3', text: '3' })] },
      ],
    }
    expect(extractInboundEvents(body).map((e) => `${e.pageId}:${e.mid}`)).toEqual([
      'A:m_1',
      'A:m_2',
      'B:m_3',
    ])
  })
})
