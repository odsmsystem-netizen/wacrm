import { describe, expect, it } from 'vitest'
import { conversationOrigin } from './conversation-origin'
import type { AdReferral } from '@/lib/whatsapp/ad-referral'

const referral = (source_type: string): AdReferral =>
  ({ source_type, captured_at: '2026-10-09T00:00:00.000Z' }) as AdReferral

describe('conversationOrigin', () => {
  it('Messenger es siempre Messenger, aunque trajera un referral', () => {
    expect(conversationOrigin({ channel: 'messenger' })).toBe('messenger')
    expect(conversationOrigin({ channel: 'messenger', ad_referral: referral('ad') })).toBe(
      'messenger',
    )
  })

  it('WhatsApp con un referral de anuncio o de publicación', () => {
    expect(conversationOrigin({ channel: 'whatsapp', ad_referral: referral('ad') })).toBe(
      'whatsapp_ad',
    )
    expect(conversationOrigin({ channel: 'whatsapp', ad_referral: referral('post') })).toBe(
      'whatsapp_post',
    )
  })

  it('WhatsApp sin referral es orgánico', () => {
    expect(conversationOrigin({ channel: 'whatsapp', ad_referral: null })).toBe('whatsapp_organic')
    expect(conversationOrigin({ channel: 'whatsapp' })).toBe('whatsapp_organic')
  })

  it('una conversación anterior a la columna de canal (sin channel) cuenta como WhatsApp', () => {
    expect(conversationOrigin({})).toBe('whatsapp_organic')
    expect(conversationOrigin({ ad_referral: referral('ad') })).toBe('whatsapp_ad')
  })

  it('un referral con un tipo desconocido no se inventa un origen: cae en orgánico', () => {
    expect(conversationOrigin({ channel: 'whatsapp', ad_referral: referral('story') })).toBe(
      'whatsapp_organic',
    )
  })
})
