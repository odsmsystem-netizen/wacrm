import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { getPage, MessengerApiError } from '@/lib/messenger/graph'
import { requestOrigin } from '@/lib/http/request-origin'

// Conectar la página de Facebook a la cuenta. Solo administradores: el token
// de página da control total sobre los mensajes de la página.
//
// El token NUNCA se devuelve: la interfaz solo necesita saber que existe.

const webhookUrl = (request: Request) => `${requestOrigin(request)}/api/messenger/webhook`

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data } = await supabase
      .from('messenger_config')
      .select('page_id, page_name, verify_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!data) return NextResponse.json({ connected: false, webhook_url: webhookUrl(request) })
    return NextResponse.json({
      connected: data.status === 'connected',
      page_id: data.page_id,
      page_name: data.page_name,
      verify_token: data.verify_token,
      webhook_url: webhookUrl(request),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as {
      page_id?: unknown
      page_access_token?: unknown
    }
    const pageId = typeof body.page_id === 'string' ? body.page_id.trim() : ''
    const token = typeof body.page_access_token === 'string' ? body.page_access_token.trim() : ''
    if (!pageId || !token) {
      return NextResponse.json(
        { error: 'page_id and page_access_token are required' },
        { status: 400 },
      )
    }

    // Se valida contra Meta antes de guardar nada: un token que no es de esa
    // página dejaría el webhook recibiendo mensajes que no podemos contestar.
    let page: { id: string; name: string }
    try {
      page = await getPage(token)
    } catch (err) {
      const reason = err instanceof MessengerApiError ? err.message : 'No se pudo validar el token'
      return NextResponse.json({ error: reason }, { status: 400 })
    }
    if (page.id !== pageId) {
      return NextResponse.json(
        { error: 'El token no corresponde a esa página' },
        { status: 400 },
      )
    }

    // Reconectar conserva el verify_token: Meta ya lo tiene guardado en su
    // panel y cambiarlo rompería la suscripción sin avisar.
    const { data: existing } = await supabase
      .from('messenger_config')
      .select('verify_token')
      .eq('account_id', accountId)
      .maybeSingle()
    const verifyToken = existing?.verify_token ?? randomBytes(16).toString('hex')

    const { error } = await supabase.from('messenger_config').upsert(
      {
        account_id: accountId,
        user_id: userId,
        page_id: page.id,
        page_name: page.name,
        page_access_token: encrypt(token),
        verify_token: verifyToken,
        status: 'connected',
        connected_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' },
    )
    if (error) {
      console.error('[messenger/config] error guardando:', error)
      return NextResponse.json({ error: 'No se pudo guardar la configuración' }, { status: 500 })
    }

    return NextResponse.json({
      connected: true,
      page_id: page.id,
      page_name: page.name,
      verify_token: verifyToken,
      webhook_url: webhookUrl(request),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('messenger_config').delete().eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: 'No se pudo desconectar' }, { status: 500 })
    }
    return NextResponse.json({ connected: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
