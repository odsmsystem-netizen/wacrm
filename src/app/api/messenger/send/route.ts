import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { MessengerSendError, sendMessengerText } from '@/lib/messenger/send'

const MAX_TEXT = 2000 // límite de Messenger para un mensaje de texto

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      conversation_id?: unknown
      content_text?: unknown
    }
    const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id : ''
    const text = typeof body.content_text === 'string' ? body.content_text.trim() : ''
    if (!conversationId || !text) {
      return NextResponse.json(
        { error: 'conversation_id and content_text are required' },
        { status: 400 },
      )
    }
    if (text.length > MAX_TEXT) {
      return NextResponse.json({ error: `Text exceeds ${MAX_TEXT} characters` }, { status: 400 })
    }

    try {
      const result = await sendMessengerText(supabase, accountId, { conversationId, text })
      return NextResponse.json({ success: true, message_id: result.messageId })
    } catch (err) {
      if (err instanceof MessengerSendError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
      }
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
