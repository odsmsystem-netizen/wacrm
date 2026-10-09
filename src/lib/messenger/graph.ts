// Cliente mínimo de la Graph API para Messenger. Mismo patrón que
// src/lib/whatsapp/meta-api.ts, con el token de PÁGINA en vez del de WhatsApp.

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

export class MessengerApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message)
    this.name = 'MessengerApiError'
  }
}

async function graphFetch(
  path: string,
  token: string,
  init?: { method?: string; body?: string },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  })
  const json = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number }
  } & Record<string, unknown>
  if (!res.ok) {
    throw new MessengerApiError(
      json.error?.message ?? `Graph API ${res.status}`,
      res.status,
      json.error?.code,
    )
  }
  return json
}

/** La página a la que pertenece el token. Sirve para validar lo que pega el admin. */
export async function getPage(token: string): Promise<{ id: string; name: string }> {
  const json = await graphFetch('/me?fields=id,name', token)
  return { id: String(json.id), name: String(json.name ?? '') }
}

/** Respuesta dentro de la ventana de 24 h (`messaging_type: RESPONSE`). */
export async function sendText(
  token: string,
  psid: string,
  text: string,
): Promise<{ messageId: string }> {
  const json = await graphFetch('/me/messages', token, {
    method: 'POST',
    body: JSON.stringify({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: { text },
    }),
  })
  return { messageId: String(json.message_id) }
}

/**
 * Nombre del cliente. Nunca lanza: perder el nombre no debe perder el
 * mensaje, y Meta a veces niega el perfil (privacidad, permisos).
 */
export async function getUserName(token: string, psid: string): Promise<string | null> {
  try {
    const json = await graphFetch(`/${encodeURIComponent(psid)}?fields=name`, token)
    return typeof json.name === 'string' && json.name ? json.name : null
  } catch {
    return null
  }
}
