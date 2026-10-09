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

/**
 * A qué página pertenece un token de página, y si sigue siendo válido. Sirve para
 * validar lo que pega el administrador antes de guardarlo.
 *
 * Usa `debug_token` y no `GET /me`: leer la página exige el permiso
 * `pages_read_engagement`, que el caso de uso de Messenger no concede (el token solo
 * trae `pages_messaging`, que es lo único que hace falta para recibir y responder).
 * El token de acceso viaja en el encabezado; `input_token` va en la consulta porque
 * así lo pide la API (con POST no responde).
 */
export async function inspectPageToken(
  token: string,
): Promise<{ pageId: string; isValid: boolean; type: string }> {
  const json = await graphFetch(`/debug_token?input_token=${encodeURIComponent(token)}`, token)
  const data = (json.data ?? {}) as { profile_id?: unknown; is_valid?: unknown; type?: unknown }
  return {
    pageId: typeof data.profile_id === 'string' ? data.profile_id : '',
    isValid: data.is_valid === true,
    type: typeof data.type === 'string' ? data.type : '',
  }
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
