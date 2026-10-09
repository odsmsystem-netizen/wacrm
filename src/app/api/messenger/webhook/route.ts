import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { timingSafeEqual } from 'node:crypto'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { extractInboundEvents } from '@/lib/messenger/parse-webhook'
import { processInboundEvent } from '@/lib/messenger/inbound'

export const maxDuration = 60

// Se crea al primer uso para no romper el build cuando faltan las variables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function supabaseAdmin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// GET — desafío de verificación que Meta manda al guardar el webhook. El
// verify_token se genera al conectar la página en Ajustes; por eso la
// configuración existe ANTES de que Meta llegue aquí.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const token = searchParams.get('hub.verify_token')

  if (mode !== 'subscribe' || !challenge || !token) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }

  const { data: configs, error } = await supabaseAdmin()
    .from('messenger_config')
    .select('verify_token')
  if (error || !configs) {
    console.error('[messenger] error leyendo messenger_config para verificar:', error)
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
  }

  const ok = (configs as Array<{ verify_token: string }>).some((c) =>
    sameToken(c.verify_token, token),
  )
  if (!ok) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// POST — mensajes. Se lee el cuerpo CRUDO para verificar la firma sobre los
// mismos bytes que Meta firmó, y se procesa en `after()` para contestar a Meta
// dentro de su plazo (un ack lento provoca reintentos y duplicados).
export async function POST(request: Request) {
  const rawBody = await request.text()

  if (!verifyMetaWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    console.warn('[messenger] firma inválida')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const events = extractInboundEvents(body)

  after(async () => {
    for (const event of events) {
      try {
        await processInboundEvent(supabaseAdmin(), event)
      } catch (err) {
        // Un mensaje que falla no debe tirar a los demás de la misma entrega.
        console.error('[messenger] error procesando', event.mid, err)
      }
    }
  })

  return NextResponse.json({ status: 'ok' })
}
