# Messenger en la bandeja de wacrm — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los mensajes que los clientes escriban por Messenger a la página de Facebook de Ambar Cargo lleguen a la bandeja de wacrm y el equipo pueda responder a mano.

**Architecture:** Un campo `channel` en `contacts` y `conversations` distingue WhatsApp de Messenger; el contacto de Messenger se identifica por `external_id` (el PSID) y no tiene teléfono. Messenger tiene su propio webhook (`/api/messenger/webhook`), su propio envío (`/api/messenger/send`) y su propia configuración (`messenger_config`). Todo lo que asume un teléfono (API pública que consume Claudia, envíos masivos, envío de WhatsApp) deja a Messenger fuera.

**Tech Stack:** Next.js 16 (App Router, `after()`), Supabase (Postgres + RLS), vitest, next-intl, Graph API de Meta `v21.0`.

**Spec:** `docs/superpowers/specs/2026-10-05-messenger-bandeja-design.md`

## Global Constraints

- Migración nueva: `supabase/migrations/048_messenger_channel.sql` (la última es la 047).
- Valores de canal: exactamente `'whatsapp'` y `'messenger'`. Lo existente queda como `'whatsapp'`.
- Graph API: `https://graph.facebook.com/v21.0` (la misma versión que `src/lib/whatsapp/meta-api.ts`).
- El webhook verifica `x-hub-signature-256` con `verifyMetaWebhookSignature` (misma app secret) y procesa dentro de `after()`.
- Los tokens se cifran con `encrypt`/`decrypt` de `@/lib/whatsapp/encryption`.
- Ventana de Messenger: 24 horas desde el último mensaje **entrante** del cliente. Sin etiquetas especiales.
- Un mensaje entrante de Messenger **no** dispara automatizaciones, flujos, respuesta automática de IA ni webhooks públicos.
- `/api/v1/conversations` y `/api/v1/contacts` devuelven solo `whatsapp` por defecto; Messenger solo con `?channel=messenger`. El contrato actual no cambia (Claudia lo consume).
- Una cuenta de wacrm conecta **una** página.
- Comentarios nuevos en español, como el código reciente del repo. Textos de interfaz por next-intl (`en`, `es`, `ko`).
- Lectura obligatoria antes de tocar rutas: `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` (este Next tiene cambios incompatibles, ver `AGENTS.md`).
- Cada commit termina con la línea `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- **Nada se empuja ni se aplica a la base de producción sin confirmación explícita del usuario** (la base de Supabase es compartida con producción; un push a `main` despliega).

## Review Focus

Entradas que la spec insinúa, que ninguna tarea cubriría por sí sola y que más probablemente muerden a quien use esto. Cada línea tiene su prueba en la tarea que posee el código.

1. **Meta reintenta la misma entrega** (mismo `mid`) → un solo mensaje y un solo contacto, sin doble contador de no leídos. *(Tarea 4)*
2. **Eco del propio envío** (`is_echo`: el mensaje que la página mandó) → no se guarda como mensaje del cliente. *(Tarea 3)*
3. **Mensaje sin texto ni adjunto conocido** (sticker, audio, ubicación) → no revienta; se guarda como `[<tipo> recibido]`. *(Tarea 3)*
4. **Responder pasada la ventana de 24 h** → error claro `window_closed` (409), sin llamar a Meta. *(Tarea 6)*
5. **Token de página revocado o vencido** (código Graph 190) → la configuración pasa a `disconnected` y el error llega al agente, en vez de fallar mudo en cada envío. *(Tarea 6)*
6. **Un contacto de Messenger en la cuenta** no aparece en `/api/v1/conversations`, ni en el envío masivo, ni lo puede mandar por WhatsApp `sendMessageToConversation`. *(Tareas 6 y 8)*
7. **Imágenes**: Meta entrega URLs temporales. En esta versión se guarda la URL tal cual; si caducan, la imagen deja de verse. Se documenta como límite conocido, no se resuelve aquí. *(Tarea 3)*

---

## Mapa de archivos

| Archivo | Responsabilidad |
| --- | --- |
| `supabase/migrations/048_messenger_channel.sql` | Columnas `channel`/`external_id`, `phone` opcional, restricciones, tabla `messenger_config` |
| `src/types/index.ts` | `ConversationChannel`; `Contact.phone` nulo; `channel`/`external_id` |
| `src/lib/contacts/display-name.ts` | Nombre para mostrar de un contacto (nombre → teléfono → PSID) |
| `src/lib/messenger/graph.ts` | Cliente de la Graph API: `getPage`, `sendText`, `getUserName` |
| `src/lib/messenger/parse-webhook.ts` | Función pura que extrae eventos entrantes del cuerpo del webhook |
| `src/lib/messenger/inbound.ts` | Guarda un evento entrante: contacto, conversación, mensaje |
| `src/lib/messenger/send.ts` | Envío de texto con ventana de 24 h y manejo de token vencido |
| `src/lib/messenger/__fixtures__/fake-db.ts` | Base en memoria para las pruebas |
| `src/lib/http/request-origin.ts` | Dominio público de una petición detrás del proxy |
| `src/lib/api/v1/channel.ts` | Interpreta el parámetro `?channel=` de la API pública |
| `src/app/api/messenger/webhook/route.ts` | Verificación (GET) y recepción (POST) |
| `src/app/api/messenger/config/route.ts` | Conectar/consultar/desconectar la página |
| `src/app/api/messenger/send/route.ts` | Enviar una respuesta desde la bandeja |
| `src/components/settings/messenger-config.tsx` | Panel de Ajustes |

---

### Task 1: Modelo de datos y tipos

**Files:**
- Create: `supabase/migrations/048_messenger_channel.sql`
- Create: `src/lib/contacts/display-name.ts`
- Create: `src/lib/contacts/display-name.test.ts`
- Modify: `src/types/index.ts:99-116` y `160-184`
- Modify (errores de `tsc`): `src/components/broadcasts/step3-personalize.tsx:212`, `src/components/contacts/contact-detail-view.tsx:195`, `src/components/inbox/contact-sidebar.tsx:130,165`, `src/components/inbox/message-thread.tsx:882`, `src/components/pipelines/deal-card.tsx:78`, `src/hooks/use-broadcast-sending.ts:118`, `src/lib/api/v1/conversations.ts:22,75`, `src/lib/api/v1/contacts.ts:22,49`

**Interfaces:**
- Produces: `type ConversationChannel = 'whatsapp' | 'messenger'`; `Contact.phone: string | null`, `Contact.channel?: ConversationChannel`, `Contact.external_id?: string | null`; `Conversation.channel?: ConversationChannel`; `contactDisplayName(contact, fallback?: string): string`.

- [ ] **Step 1: Escribir la migración**

```sql
-- 048_messenger_channel.sql
--
-- Messenger como segundo canal de la bandeja. Ver
-- docs/superpowers/specs/2026-10-05-messenger-bandeja-design.md
--
-- Un contacto de Messenger no tiene teléfono: se identifica por el PSID que
-- Meta le asigna por página. Por eso `contacts.phone` pasa a admitir NULL y
-- una restricción obliga a que cada canal traiga SU identificador — sin ella
-- se podría crear un contacto que no es alcanzable por ningún canal.
--
-- Todo lo que existe queda como 'whatsapp' (DEFAULT), así que ninguna fila
-- actual cambia de significado.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN IF NOT EXISTS external_id TEXT;

ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_channel_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_check CHECK (channel IN ('whatsapp', 'messenger'));

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_channel_identity_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_identity_check CHECK (
    (channel = 'whatsapp' AND phone IS NOT NULL)
    OR (channel = 'messenger' AND external_id IS NOT NULL)
  );

-- Un PSID no puede duplicar contactos dentro de una cuenta. Parcial porque
-- los contactos de WhatsApp no tienen external_id.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_channel_external_id_key
  ON contacts (account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_check CHECK (channel IN ('whatsapp', 'messenger'));

-- Una página de Facebook por cuenta, y una página no puede estar conectada a
-- dos cuentas: el webhook localiza la cuenta por page_id.
CREATE TABLE IF NOT EXISTS messenger_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL UNIQUE,
  page_name TEXT,
  page_access_token TEXT NOT NULL,
  verify_token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS messenger_config_updated_at ON messenger_config;
CREATE TRIGGER messenger_config_updated_at
  BEFORE UPDATE ON messenger_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE messenger_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messenger_config_select ON messenger_config;
DROP POLICY IF EXISTS messenger_config_insert ON messenger_config;
DROP POLICY IF EXISTS messenger_config_update ON messenger_config;
DROP POLICY IF EXISTS messenger_config_delete ON messenger_config;
CREATE POLICY messenger_config_select ON messenger_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY messenger_config_insert ON messenger_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_update ON messenger_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY messenger_config_delete ON messenger_config FOR DELETE USING (is_account_member(account_id, 'admin'));
```

- [ ] **Step 2: Escribir la prueba del nombre para mostrar**

`src/lib/contacts/display-name.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { contactDisplayName } from './display-name'

describe('contactDisplayName', () => {
  it('prefiere el nombre', () => {
    expect(contactDisplayName({ name: 'Ana', phone: '+521', external_id: 'p1' })).toBe('Ana')
  })
  it('cae al teléfono y luego al PSID', () => {
    expect(contactDisplayName({ name: '', phone: '+521' })).toBe('+521')
    expect(contactDisplayName({ name: null, phone: null, external_id: 'p1' })).toBe('p1')
  })
  it('usa el respaldo cuando no hay nada, y no revienta con null', () => {
    expect(contactDisplayName(null, 'Desconocido')).toBe('Desconocido')
    expect(contactDisplayName(undefined)).toBe('')
  })
})
```

- [ ] **Step 3: Verificar que falla**

Run: `npx vitest run src/lib/contacts/display-name.test.ts`
Expected: FAIL (`Cannot find module './display-name'`).

- [ ] **Step 4: Implementar el helper**

`src/lib/contacts/display-name.ts`:

```ts
/**
 * Nombre para mostrar de un contacto. Un contacto de Messenger no tiene
 * teléfono, así que `contact.name || contact.phone` dejaría de ser un string;
 * esta función es la única que decide el orden de respaldo.
 */
export function contactDisplayName(
  contact:
    | { name?: string | null; phone?: string | null; external_id?: string | null }
    | null
    | undefined,
  fallback = '',
): string {
  return contact?.name || contact?.phone || contact?.external_id || fallback
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `npx vitest run src/lib/contacts/display-name.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Cambiar los tipos**

En `src/types/index.ts`, antes de `export interface Contact`, agregar:

```ts
/** Canal por el que habla un contacto o una conversación (migración 048). */
export type ConversationChannel = 'whatsapp' | 'messenger';
```

En `Contact`, reemplazar `phone: string;` por:

```ts
  /** Nulo en contactos de Messenger: se identifican por `external_id`. */
  phone: string | null;
  /** Ausente = 'whatsapp' (lo anterior a la migración 048). */
  channel?: ConversationChannel;
  /** PSID de Messenger. Solo en contactos de ese canal. */
  external_id?: string | null;
```

En `Conversation`, justo después de `contact?: Contact;`, agregar:

```ts
  /** Ausente = 'whatsapp' (lo anterior a la migración 048). */
  channel?: ConversationChannel;
```

- [ ] **Step 7: Ver los errores de `tsc`**

Run: `npx tsc --noEmit`
Expected: exactamente estos 8 errores (ya medidos): `step3-personalize.tsx(212)`, `contact-detail-view.tsx(195)`, `contact-sidebar.tsx(131)` y `(143)`, `message-thread.tsx(920)`, `deal-card.tsx(78)`, `use-broadcast-sending.ts(118)`, `lib/api/v1/conversations.ts(75)`.

- [ ] **Step 8: Corregir cada uno**

`src/components/broadcasts/step3-personalize.tsx` (línea 212) y `src/hooks/use-broadcast-sending.ts` (línea 118) — en el `fieldMap`, cambiar:

```ts
            phone: contact.phone,
```
por
```ts
            phone: contact.phone ?? undefined,
```
(en `use-broadcast-sending.ts` la sangría es de 8 espacios; el cambio es el mismo).

`src/components/contacts/contact-detail-view.tsx` (línea 195):

```ts
  async function copyPhone() {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
```

`src/components/inbox/contact-sidebar.tsx`: agregar el import `import { contactDisplayName } from "@/lib/contacts/display-name";`, cambiar la línea 130 por
```ts
  const displayName = contactDisplayName(contact);
```
y la línea 165 por
```tsx
              <span className="flex-1 text-left">{contact.phone ?? "Messenger"}</span>
```

`src/components/inbox/message-thread.tsx` línea 882: agregar el mismo import y reemplazar por
```ts
  const displayName = contactDisplayName(contact);
```

`src/components/pipelines/deal-card.tsx` línea 78:
```tsx
          {initials(deal.contact?.name, deal.contact?.phone ?? undefined)}
```

`src/lib/api/v1/conversations.ts`: en `ApiConversation.contact` cambiar `phone: string;` por `phone: string | null;`, y agregar `channel: 'whatsapp' | 'messenger';` justo después de `contact_id: string;` en `ApiConversation`. En el serializador, después de `contact_id: conv.contact_id,` agregar `channel: conv.channel ?? 'whatsapp',`.

`src/lib/api/v1/contacts.ts`: en la interfaz (línea 22) `phone: string;` → `phone: string | null;`, y en la línea 49 `phone: row.phone as string,` → `phone: (row.phone as string | null) ?? null,`.

- [ ] **Step 9: Verificar que todo compila y nada se rompió**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` sin salida y vitest en verde (905+3 pruebas).

- [ ] **Step 10: Commit**

```bash
git add supabase/migrations/048_messenger_channel.sql src/types/index.ts src/lib/contacts src/components src/hooks src/lib/api
git commit -m "feat: modelo de datos para el canal Messenger

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 11: Aplicar la migración (REQUIERE confirmación del usuario)**

La base de Supabase es la de producción. Pedir al usuario que apruebe y aplicar `048_messenger_channel.sql` igual que se aplicó la 047 (SQL Editor de Supabase). Verificar después:

```sql
SELECT channel, count(*) FROM contacts GROUP BY channel;       -- todo 'whatsapp'
SELECT count(*) FROM contacts WHERE phone IS NULL;             -- 0
SELECT to_regclass('public.messenger_config');                 -- messenger_config
```

---

### Task 2: Cliente de la Graph API

**Files:**
- Create: `src/lib/messenger/graph.ts`
- Test: `src/lib/messenger/graph.test.ts`

**Interfaces:**
- Produces: `class MessengerApiError extends Error { status: number; code?: number }`; `getPage(token: string): Promise<{ id: string; name: string }>`; `sendText(token: string, psid: string, text: string): Promise<{ messageId: string }>`; `getUserName(token: string, psid: string): Promise<string | null>` (nunca lanza).

- [ ] **Step 1: Escribir las pruebas**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessengerApiError, getPage, getUserName, sendText } from './graph'

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('graph', () => {
  it('getPage devuelve id y nombre', async () => {
    const f = mockFetch(200, { id: '123', name: 'Ambar Cargo' })
    await expect(getPage('tok')).resolves.toEqual({ id: '123', name: 'Ambar Cargo' })
    expect(f.mock.calls[0][0]).toContain('/v21.0/me?fields=id,name')
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
  })

  it('sendText manda RESPONSE al PSID y devuelve el mid', async () => {
    const f = mockFetch(200, { recipient_id: 'psid1', message_id: 'm_abc' })
    await expect(sendText('tok', 'psid1', 'hola')).resolves.toEqual({ messageId: 'm_abc' })
    const body = JSON.parse(f.mock.calls[0][1].body)
    expect(body).toEqual({
      recipient: { id: 'psid1' },
      messaging_type: 'RESPONSE',
      message: { text: 'hola' },
    })
  })

  it('un error de Meta se vuelve MessengerApiError con su código', async () => {
    mockFetch(400, { error: { message: 'Token vencido', code: 190 } })
    const err = await sendText('tok', 'p', 'x').catch((e) => e)
    expect(err).toBeInstanceOf(MessengerApiError)
    expect(err.code).toBe(190)
    expect(err.status).toBe(400)
    expect(err.message).toBe('Token vencido')
  })

  it('getUserName devuelve null si Meta falla, en vez de lanzar', async () => {
    mockFetch(500, {})
    await expect(getUserName('tok', 'p')).resolves.toBeNull()
  })

  it('getUserName devuelve el nombre', async () => {
    mockFetch(200, { name: 'Juan Pérez' })
    await expect(getUserName('tok', 'p')).resolves.toBe('Juan Pérez')
  })
})
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run src/lib/messenger/graph.test.ts`
Expected: FAIL (`Cannot find module './graph'`).

- [ ] **Step 3: Implementar**

```ts
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
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run src/lib/messenger/graph.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/messenger/graph.ts src/lib/messenger/graph.test.ts
git commit -m "feat: cliente de la Graph API para Messenger

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Análisis del cuerpo del webhook

**Files:**
- Create: `src/lib/messenger/parse-webhook.ts`
- Test: `src/lib/messenger/parse-webhook.test.ts`

**Interfaces:**
- Produces: `interface MessengerInboundEvent { pageId: string; psid: string; mid: string; timestamp: number; contentType: 'text' | 'image'; contentText: string | null; mediaUrl: string | null }`; `extractInboundEvents(body: unknown): MessengerInboundEvent[]`.

- [ ] **Step 1: Escribir las pruebas**

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run src/lib/messenger/parse-webhook.test.ts`
Expected: FAIL (`Cannot find module './parse-webhook'`).

- [ ] **Step 3: Implementar**

```ts
// Extrae del cuerpo del webhook de Messenger solo lo que la bandeja necesita.
// Pura y sin I/O: Meta manda de todo por este mismo canal (entregas, lecturas,
// ecos de lo que la página envía) y aquí se decide qué cuenta como mensaje
// entrante, para que el resto del código no tenga que defenderse del formato.
//
// Límite conocido: las URL de imagen que entrega Meta son temporales. Se
// guardan tal cual; si caducan, la imagen deja de verse.

export interface MessengerInboundEvent {
  pageId: string
  psid: string
  /** Id del mensaje en Meta; es la llave de idempotencia ante reintentos. */
  mid: string
  /** Milisegundos desde epoch, como lo manda Messenger. */
  timestamp: number
  contentType: 'text' | 'image'
  contentText: string | null
  mediaUrl: string | null
}

interface RawAttachment {
  type?: string
  payload?: { url?: string }
}

export function extractInboundEvents(body: unknown): MessengerInboundEvent[] {
  const root = body as { object?: string; entry?: unknown[] } | null
  if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return []

  const events: MessengerInboundEvent[] = []

  for (const rawEntry of root.entry) {
    const entry = rawEntry as { id?: string; messaging?: unknown[] }
    if (!entry?.id || !Array.isArray(entry.messaging)) continue

    for (const rawItem of entry.messaging) {
      const item = rawItem as {
        sender?: { id?: string }
        timestamp?: number
        message?: {
          mid?: string
          text?: string
          is_echo?: boolean
          attachments?: RawAttachment[]
        }
      }
      const message = item.message
      const psid = item.sender?.id
      // Sin `message` es una entrega, una lectura o un postback: no es un
      // mensaje del cliente. `is_echo` es lo que la propia página mandó.
      if (!message || !psid || !message.mid || message.is_echo) continue

      const image = message.attachments?.find((a) => a.type === 'image' && a.payload?.url)
      const other = message.attachments?.[0]

      let contentType: 'text' | 'image' = 'text'
      let contentText: string | null = message.text ?? null
      let mediaUrl: string | null = null

      if (image) {
        contentType = 'image'
        mediaUrl = image.payload!.url!
      } else if (!contentText && other) {
        contentText = `[${other.type ?? 'adjunto'} recibido]`
      }

      events.push({
        pageId: entry.id,
        psid,
        mid: message.mid,
        timestamp: item.timestamp ?? Date.now(),
        contentType,
        contentText,
        mediaUrl,
      })
    }
  }

  return events
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run src/lib/messenger/parse-webhook.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/messenger/parse-webhook.ts src/lib/messenger/parse-webhook.test.ts
git commit -m "feat: extraer los mensajes entrantes del webhook de Messenger

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Guardar el mensaje entrante y la ruta del webhook

**Files:**
- Create: `src/lib/messenger/__fixtures__/fake-db.ts`
- Create: `src/lib/messenger/inbound.ts`
- Test: `src/lib/messenger/inbound.test.ts`
- Create: `src/app/api/messenger/webhook/route.ts`
- Test: `src/app/api/messenger/webhook/route.test.ts`

**Interfaces:**
- Consumes: `MessengerInboundEvent`, `extractInboundEvents` (Tarea 3); `getUserName` (Tarea 2); `decrypt` de `@/lib/whatsapp/encryption`; `isUniqueViolation` de `@/lib/contacts/dedupe`; `reopenClosedConversation(db, { id, status })`.
- Produces: `processInboundEvent(db: SupabaseClient, event: MessengerInboundEvent): Promise<'stored' | 'duplicate' | 'unknown_page'>`; `makeFakeDb(seed?)`.

- [ ] **Step 1: Escribir la base en memoria para las pruebas**

`src/lib/messenger/__fixtures__/fake-db.ts`:

```ts
// Base en memoria con la parte mínima de la API de Supabase que usa el código
// de Messenger. Modela las dos restricciones únicas que importan (contactos por
// PSID y mensajes por `mid`) para poder probar reintentos y carreras.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>

const UNIQUE_KEYS: Record<string, string[]> = {
  contacts: ['account_id', 'channel', 'external_id'],
  messages: ['conversation_id', 'message_id'],
}

export function makeFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  const rpcCalls: Array<{ name: string; args: Row }> = []
  let idSeq = 0

  function from(table: string) {
    const rows = (tables[table] ??= [])
    const filters: Array<[string, unknown]> = []
    let limitN = Infinity
    let op: { kind: 'select' | 'insert' | 'upsert' | 'update'; payload?: Row; ignore?: boolean } = {
      kind: 'select',
    }

    const matching = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v)).slice(0, limitN)
    const duplicateOf = (row: Row) => {
      const keys = UNIQUE_KEYS[table]
      return keys ? rows.find((r) => keys.every((k) => r[k] === row[k])) : undefined
    }

    const run = (): { data: Row[] | null; error: { code?: string; message: string } | null } => {
      if (op.kind === 'insert' || op.kind === 'upsert') {
        const row = { id: `${table}-${++idSeq}`, created_at: new Date().toISOString(), ...op.payload }
        if (duplicateOf(row)) {
          if (op.kind === 'upsert' && op.ignore) return { data: [], error: null }
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
        rows.push(row)
        return { data: [row], error: null }
      }
      if (op.kind === 'update') {
        const hit = matching()
        hit.forEach((r) => Object.assign(r, op.payload))
        return { data: hit, error: null }
      }
      return { data: matching(), error: null }
    }

    const builder: any = {
      select: () => builder,
      eq: (c: string, v: unknown) => (filters.push([c, v]), builder),
      order: () => builder,
      limit: (n: number) => ((limitN = n), builder),
      insert: (p: Row) => ((op = { kind: 'insert', payload: p }), builder),
      upsert: (p: Row, o?: { ignoreDuplicates?: boolean }) => (
        (op = { kind: 'upsert', payload: p, ignore: o?.ignoreDuplicates }), builder
      ),
      update: (p: Row) => ((op = { kind: 'update', payload: p }), builder),
      maybeSingle: async () => {
        const r = run()
        return { data: r.data?.[0] ?? null, error: r.error }
      },
      single: async () => {
        const r = run()
        return { data: r.data?.[0] ?? null, error: r.error }
      },
      then: (resolve: (v: unknown) => unknown) => resolve(run()),
    }
    return builder
  }

  return {
    from,
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args })
      return { error: null }
    },
    tables,
    rpcCalls,
  }
}
```

- [ ] **Step 2: Escribir las pruebas de `inbound`**

`src/lib/messenger/inbound.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from './__fixtures__/fake-db'
import { processInboundEvent } from './inbound'
import type { MessengerInboundEvent } from './parse-webhook'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec(${s})` }))
const getUserName = vi.fn()
vi.mock('./graph', () => ({ getUserName: (...a: unknown[]) => getUserName(...a) }))

const CONFIG = {
  account_id: 'acct-1',
  user_id: 'user-1',
  page_id: 'PAGE1',
  page_access_token: 'enc',
  status: 'connected',
}
const event = (over: Partial<MessengerInboundEvent> = {}): MessengerInboundEvent => ({
  pageId: 'PAGE1',
  psid: 'PSID1',
  mid: 'm_1',
  timestamp: 1700000000000,
  contentType: 'text',
  contentText: 'Hola',
  mediaUrl: null,
  ...over,
})

beforeEach(() => getUserName.mockReset().mockResolvedValue('Juan Pérez'))

describe('processInboundEvent', () => {
  it('crea contacto, conversación y mensaje de Messenger', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await expect(processInboundEvent(db as never, event())).resolves.toBe('stored')

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.contacts[0]).toMatchObject({
      account_id: 'acct-1',
      channel: 'messenger',
      external_id: 'PSID1',
      name: 'Juan Pérez',
    })
    expect(db.tables.contacts[0].phone).toBeUndefined()
    expect(db.tables.conversations[0]).toMatchObject({ channel: 'messenger', account_id: 'acct-1' })
    expect(db.tables.messages[0]).toMatchObject({
      sender_type: 'customer',
      content_text: 'Hola',
      message_id: 'm_1',
      status: 'delivered',
    })
    expect(db.rpcCalls).toEqual([
      {
        name: 'bump_conversation_on_inbound',
        args: { p_conversation_id: db.tables.conversations[0].id, p_last_message_text: 'Hola' },
      },
    ])
    expect(getUserName).toHaveBeenCalledWith('dec(enc)', 'PSID1')
  })

  it('Review Focus 1: el mismo mid reintentado no duplica ni cuenta dos veces', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event())
    await expect(processInboundEvent(db as never, event())).resolves.toBe('duplicate')

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.messages).toHaveLength(1)
    expect(db.rpcCalls).toHaveLength(1)
  })

  it('el mismo PSID con otro mensaje reutiliza contacto y conversación', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event())
    await processInboundEvent(db as never, event({ mid: 'm_2', contentText: 'Otra cosa' }))

    expect(db.tables.contacts).toHaveLength(1)
    expect(db.tables.conversations).toHaveLength(1)
    expect(db.tables.messages).toHaveLength(2)
  })

  it('si Meta no da el nombre, el contacto igual se crea con un nombre de respaldo', async () => {
    getUserName.mockResolvedValue(null)
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(db as never, event({ psid: 'PSID-9999' }))
    expect(db.tables.contacts[0].name).toBe('Messenger ····9999')
  })

  it('una página desconocida se ignora sin guardar nada', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await expect(processInboundEvent(db as never, event({ pageId: 'OTRA' }))).resolves.toBe(
      'unknown_page',
    )
    expect(db.tables.contacts ?? []).toHaveLength(0)
  })

  it('una página desconectada no recibe mensajes', async () => {
    const db = makeFakeDb({ messenger_config: [{ ...CONFIG, status: 'disconnected' }] })
    await expect(processInboundEvent(db as never, event())).resolves.toBe('unknown_page')
  })

  it('un mensaje de imagen guarda la URL y el tipo', async () => {
    const db = makeFakeDb({ messenger_config: [CONFIG] })
    await processInboundEvent(
      db as never,
      event({ contentType: 'image', contentText: null, mediaUrl: 'https://cdn/x.jpg' }),
    )
    expect(db.tables.messages[0]).toMatchObject({
      content_type: 'image',
      media_url: 'https://cdn/x.jpg',
    })
    expect(db.rpcCalls[0].args.p_last_message_text).toBe('[image]')
  })
})
```

- [ ] **Step 3: Verificar que falla**

Run: `npx vitest run src/lib/messenger/inbound.test.ts`
Expected: FAIL (`Cannot find module './inbound'`).

- [ ] **Step 4: Implementar `inbound.ts`**

```ts
// Guarda un mensaje entrante de Messenger: contacto, conversación y mensaje.
//
// A propósito NO llama a automatizaciones, flujos, respuesta automática de IA
// ni webhooks públicos (spec: fuera de alcance). El webhook de WhatsApp sí lo
// hace; aquí cada una de esas puertas asume un teléfono y un canal WhatsApp.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { getUserName } from './graph'
import type { MessengerInboundEvent } from './parse-webhook'

export type InboundOutcome = 'stored' | 'duplicate' | 'unknown_page'

interface PageConfig {
  account_id: string
  user_id: string
  page_access_token: string
}

async function findContact(db: SupabaseClient, accountId: string, psid: string) {
  const { data } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', 'messenger')
    .eq('external_id', psid)
    .maybeSingle()
  return data
}

async function findOrCreateContact(
  db: SupabaseClient,
  config: PageConfig,
  psid: string,
) {
  const existing = await findContact(db, config.account_id, psid)
  if (existing) return existing

  const name =
    (await getUserName(decrypt(config.page_access_token), psid)) ?? `Messenger ····${psid.slice(-4)}`

  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      channel: 'messenger',
      external_id: psid,
      name,
    })
    .select()
    .single()

  if (error) {
    // Perdió la carrera contra otra entrega del mismo PSID: el índice único
    // rechazó el duplicado. Se resuelve a la fila ganadora en vez de perder
    // el mensaje.
    if (isUniqueViolation(error)) return findContact(db, config.account_id, psid)
    console.error('[messenger] error creando contacto:', error)
    return null
  }
  return data
}

async function findConversation(db: SupabaseClient, accountId: string, contactId: string) {
  const { data } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
  return data && data.length > 0 ? data[0] : null
}

async function findOrCreateConversation(
  db: SupabaseClient,
  config: PageConfig,
  contactId: string,
) {
  const existing = await findConversation(db, config.account_id, contactId)
  if (existing) return existing

  const { data, error } = await db
    .from('conversations')
    .insert({
      account_id: config.account_id,
      user_id: config.user_id,
      contact_id: contactId,
      channel: 'messenger',
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) return findConversation(db, config.account_id, contactId)
    console.error('[messenger] error creando conversación:', error)
    return null
  }
  return data
}

export async function processInboundEvent(
  db: SupabaseClient,
  event: MessengerInboundEvent,
): Promise<InboundOutcome> {
  const { data: config } = await db
    .from('messenger_config')
    .select('account_id, user_id, page_access_token')
    .eq('page_id', event.pageId)
    .eq('status', 'connected')
    .maybeSingle()

  if (!config) {
    console.warn('[messenger] mensaje de una página no conectada:', event.pageId)
    return 'unknown_page'
  }

  const contact = await findOrCreateContact(db, config, event.psid)
  if (!contact) return 'unknown_page'
  const conversation = await findOrCreateConversation(db, config, contact.id)
  if (!conversation) return 'unknown_page'

  // Idempotencia: Meta reintenta entregas lentas con el mismo `mid`. El índice
  // único (conversation_id, message_id) convierte el reintento en un
  // ON CONFLICT DO NOTHING y `.select()` solo devuelve fila en el primer
  // insert. Esta es la única frontera de idempotencia, y debe ir ANTES del
  // contador de no leídos.
  const { data: inserted, error } = await db
    .from('messages')
    .upsert(
      {
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: event.contentType,
        content_text: event.contentText,
        media_url: event.mediaUrl,
        message_id: event.mid,
        status: 'delivered',
        created_at: new Date(event.timestamp).toISOString(),
      },
      { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
    )
    .select('id')

  if (error) {
    console.error('[messenger] error guardando mensaje:', error)
    return 'duplicate'
  }
  if (!inserted || inserted.length === 0) return 'duplicate'

  await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: event.contentText ?? `[${event.contentType}]`,
  })
  await reopenClosedConversation(db, conversation)

  return 'stored'
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `npx vitest run src/lib/messenger/inbound.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Escribir las pruebas de la ruta**

`src/app/api/messenger/webhook/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const tasks: Promise<unknown>[] = []
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (fn: () => unknown) => {
    tasks.push(Promise.resolve(fn()))
  },
}))

let signatureOk = true
vi.mock('@/lib/whatsapp/webhook-signature', () => ({ verifyMetaWebhookSignature: () => signatureOk }))

const processInboundEvent = vi.fn().mockResolvedValue('stored')
vi.mock('@/lib/messenger/inbound', () => ({
  processInboundEvent: (...a: unknown[]) => processInboundEvent(...a),
}))

let configs: Array<{ verify_token: string }> = []
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({ select: async () => ({ data: configs, error: null }) }),
  }),
}))

import { GET, POST } from './route'

const postReq = (body: unknown) =>
  new Request('http://x/api/messenger/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': 'sha256=abc' },
    body: JSON.stringify(body),
  })

const payload = {
  object: 'page',
  entry: [
    {
      id: 'PAGE1',
      messaging: [
        { sender: { id: 'P1' }, timestamp: 1, message: { mid: 'm_1', text: 'Hola' } },
        { sender: { id: 'P1' }, timestamp: 2, message: { mid: 'm_2', text: 'eco', is_echo: true } },
      ],
    },
  ],
}

beforeEach(() => {
  tasks.length = 0
  signatureOk = true
  configs = [{ verify_token: 'secreto-123' }]
  processInboundEvent.mockClear()
})

describe('GET /api/messenger/webhook', () => {
  const url = (token: string) =>
    new Request(
      `http://x/api/messenger/webhook?hub.mode=subscribe&hub.challenge=CH&hub.verify_token=${token}`,
    )

  it('devuelve el desafío si el token coincide', async () => {
    const res = await GET(url('secreto-123'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('CH')
  })
  it('rechaza un token que no coincide', async () => {
    expect((await GET(url('otro'))).status).toBe(403)
  })
  it('pide los parámetros que faltan', async () => {
    expect((await GET(new Request('http://x/api/messenger/webhook'))).status).toBe(400)
  })
})

describe('POST /api/messenger/webhook', () => {
  it('rechaza con 401 una firma inválida y no procesa nada', async () => {
    signatureOk = false
    const res = await POST(postReq(payload))
    expect(res.status).toBe(401)
    await Promise.all(tasks)
    expect(processInboundEvent).not.toHaveBeenCalled()
  })

  it('responde 200 y procesa solo los mensajes reales, no los ecos', async () => {
    const res = await POST(postReq(payload))
    expect(res.status).toBe(200)
    await Promise.all(tasks)
    expect(processInboundEvent).toHaveBeenCalledTimes(1)
    expect(processInboundEvent.mock.calls[0][1]).toMatchObject({ mid: 'm_1', psid: 'P1' })
  })

  it('responde 400 si el cuerpo no es JSON', async () => {
    const res = await POST(
      new Request('http://x/api/messenger/webhook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=abc' },
        body: 'no json',
      }),
    )
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 7: Verificar que falla**

Run: `npx vitest run src/app/api/messenger/webhook/route.test.ts`
Expected: FAIL (`Cannot find module './route'`).

- [ ] **Step 8: Implementar la ruta**

`src/app/api/messenger/webhook/route.ts`:

```ts
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
```

- [ ] **Step 9: Verificar que pasa**

Run: `npx vitest run src/app/api/messenger src/lib/messenger`
Expected: PASS (todas).

- [ ] **Step 10: Commit**

```bash
git add src/lib/messenger src/app/api/messenger/webhook
git commit -m "feat: recibir mensajes de Messenger en la bandeja

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Conectar la página (API y panel de Ajustes)

**Files:**
- Create: `src/lib/http/request-origin.ts`
- Test: `src/lib/http/request-origin.test.ts`
- Modify: `src/app/auth/callback/route.ts` (usar el helper)
- Create: `src/app/api/messenger/config/route.ts`
- Test: `src/app/api/messenger/config/route.test.ts`
- Create: `src/components/settings/messenger-config.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx:77`
- Modify: `messages/en.json`, `messages/es.json`, `messages/ko.json`

**Interfaces:**
- Consumes: `getPage` y `MessengerApiError` (Tarea 2); `encrypt` de `@/lib/whatsapp/encryption`; `requireRole('admin')` → `{ supabase, accountId, userId }`.
- Produces: `requestOrigin(request: Request): string`; `GET/POST/DELETE /api/messenger/config` con respuesta `{ connected: boolean; page_id?: string; page_name?: string; verify_token?: string; webhook_url: string }`.

- [ ] **Step 1: Escribir la prueba del dominio**

`src/lib/http/request-origin.test.ts`:

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run src/lib/http/request-origin.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar el helper**

`src/lib/http/request-origin.ts`:

```ts
// Dominio público de una petición. Detrás del proxy de Dokploy `request.url`
// trae el host interno del contenedor (0.0.0.0:3000), así que el dominio real
// se reconstruye desde los encabezados que el proxy reenvía.
export function requestOrigin(request: Request): string {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || undefined
  const url = new URL(request.url)
  const host = first(request.headers.get('x-forwarded-host')) ?? first(request.headers.get('host'))
  const proto =
    first(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(':', '')
  return host ? `${proto}://${host}` : url.origin
}
```

- [ ] **Step 4: Verificar que pasa y reutilizarlo en el callback de autenticación**

Run: `npx vitest run src/lib/http/request-origin.test.ts` → PASS (3 tests).

En `src/app/auth/callback/route.ts`: agregar `import { requestOrigin } from "@/lib/http/request-origin";`, borrar la función local `originOf` y reemplazar `const origin = originOf(request);` por `const origin = requestOrigin(request);`. (`NextRequest` extiende `Request`, así que es compatible.)

Run: `npx tsc --noEmit` → sin errores.

- [ ] **Step 5: Escribir las pruebas de la API de configuración**

`src/app/api/messenger/config/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from '@/lib/messenger/__fixtures__/fake-db'

let db = makeFakeDb()
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: db, accountId: 'acct-1', userId: 'user-1' }),
  toErrorResponse: (e: unknown) => {
    throw e
  },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ encrypt: (s: string) => `enc(${s})` }))
const getPage = vi.fn()
vi.mock('@/lib/messenger/graph', () => ({
  getPage: (...a: unknown[]) => getPage(...a),
  MessengerApiError: class extends Error {},
}))

import { DELETE, GET, POST } from './route'

const post = (body: unknown) =>
  new Request('https://crm.ambar-apps.cloud/api/messenger/config', {
    method: 'POST',
    body: JSON.stringify(body),
  })
const get = () => new Request('https://crm.ambar-apps.cloud/api/messenger/config')

beforeEach(() => {
  db = makeFakeDb()
  getPage.mockReset().mockResolvedValue({ id: 'PAGE1', name: 'Ambar Cargo' })
})

describe('/api/messenger/config', () => {
  it('GET sin configuración: desconectado, con la URL del webhook', async () => {
    const body = await (await GET(get())).json()
    expect(body).toEqual({
      connected: false,
      webhook_url: 'https://crm.ambar-apps.cloud/api/messenger/webhook',
    })
  })

  it('POST valida el token contra Meta, lo guarda cifrado y genera el verify_token', async () => {
    const res = await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ connected: true, page_id: 'PAGE1', page_name: 'Ambar Cargo' })
    expect(body.verify_token).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(body)).not.toContain('TOK')

    expect(getPage).toHaveBeenCalledWith('TOK')
    expect(db.tables.messenger_config[0]).toMatchObject({
      account_id: 'acct-1',
      page_id: 'PAGE1',
      page_access_token: 'enc(TOK)',
      status: 'connected',
    })
  })

  it('POST rechaza un token que no es de esa página', async () => {
    getPage.mockResolvedValue({ id: 'OTRA', name: 'Otra' })
    const res = await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    expect(res.status).toBe(400)
    expect(db.tables.messenger_config ?? []).toHaveLength(0)
  })

  it('POST pide los dos campos', async () => {
    expect((await POST(post({ page_id: 'PAGE1' }))).status).toBe(400)
  })

  it('volver a conectar conserva el verify_token (Meta ya lo tiene guardado)', async () => {
    const first = await (await POST(post({ page_id: 'PAGE1', page_access_token: 'T1' }))).json()
    const second = await (await POST(post({ page_id: 'PAGE1', page_access_token: 'T2' }))).json()
    expect(second.verify_token).toBe(first.verify_token)
    expect(db.tables.messenger_config).toHaveLength(1)
    expect(db.tables.messenger_config[0].page_access_token).toBe('enc(T2)')
  })

  it('DELETE desconecta', async () => {
    await POST(post({ page_id: 'PAGE1', page_access_token: 'TOK' }))
    const res = await DELETE(get())
    expect(res.status).toBe(200)
    expect(db.tables.messenger_config).toHaveLength(0)
  })
})
```

Para que el `DELETE` y el `upsert` de esta prueba funcionen, ampliar el fake con dos operaciones — en `src/lib/messenger/__fixtures__/fake-db.ts`:

1. Agregar `'messenger_config': ['account_id']` a `UNIQUE_KEYS`.
2. Agregar el tipo `'delete'` a `op.kind` y, en el `builder`, `delete: () => ((op = { kind: 'delete' }), builder),`; en `run()`, antes del bloque `update`:

```ts
      if (op.kind === 'delete') {
        const hit = matching()
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1))
        return { data: hit, error: null }
      }
```
3. Para `upsert` con conflicto **sin** `ignoreDuplicates`, en vez de devolver 23505 debe reemplazar la fila existente; cambiar el bloque `if (duplicateOf(row))` por:

```ts
        const dup = duplicateOf(row)
        if (dup) {
          if (op.kind === 'upsert' && op.ignore) return { data: [], error: null }
          if (op.kind === 'upsert') {
            Object.assign(dup, op.payload)
            return { data: [dup], error: null }
          }
          return { data: null, error: { code: '23505', message: 'duplicate key value' } }
        }
```

Run: `npx vitest run src/lib/messenger/inbound.test.ts` → debe seguir en PASS (el cambio no altera `ignoreDuplicates`).

- [ ] **Step 6: Verificar que falla**

Run: `npx vitest run src/app/api/messenger/config/route.test.ts`
Expected: FAIL (`Cannot find module './route'`).

- [ ] **Step 7: Implementar la API**

`src/app/api/messenger/config/route.ts`:

```ts
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
```

- [ ] **Step 8: Verificar que pasa**

Run: `npx vitest run src/app/api/messenger/config src/lib/messenger`
Expected: PASS (todas).

- [ ] **Step 9: Agregar los textos en los tres idiomas**

Insertar el bloque `messenger` justo después de la línea `  "Settings": {` en cada archivo, por inserción de texto (un `json.dump` reformatearía todo el archivo). Guardar como `C:/Users/odaniel/AppData/Local/Temp/claude/D--wacrm/565dc64d-b155-4062-8a93-b5386bf8d480/scratchpad/add_i18n.py` y correr `python add_i18n.py`:

```python
import io, re

BLOCKS = {
    "en": {
        "title": "Messenger", "description": "Receive and answer Facebook Messenger messages from the company page in the inbox.",
        "notConnected": "Not connected", "connectedTo": "Connected to {name}",
        "pageId": "Page ID", "pageToken": "Page access token", "connect": "Connect page",
        "saving": "Connecting...", "disconnect": "Disconnect",
        "webhookUrl": "Webhook URL", "verifyToken": "Verify token",
        "setupHint": "In the Meta app, add the Messenger product, subscribe the page to the \"messages\" field, and paste the webhook URL and verify token above.",
        "tokenHidden": "The token is stored encrypted and is never shown again.",
        "errorGeneric": "Could not connect the page.",
    },
    "es": {
        "title": "Messenger", "description": "Recibe y responde en la bandeja los mensajes de Facebook Messenger de la página de la empresa.",
        "notConnected": "Sin conectar", "connectedTo": "Conectado a {name}",
        "pageId": "ID de la página", "pageToken": "Token de acceso de la página", "connect": "Conectar página",
        "saving": "Conectando...", "disconnect": "Desconectar",
        "webhookUrl": "URL del webhook", "verifyToken": "Token de verificación",
        "setupHint": "En la app de Meta agrega el producto Messenger, suscribe la página al campo \"messages\" y pega arriba la URL del webhook y el token de verificación.",
        "tokenHidden": "El token se guarda cifrado y no se vuelve a mostrar.",
        "errorGeneric": "No se pudo conectar la página.",
    },
}
BLOCKS["ko"] = BLOCKS["en"]  # sin traducción al coreano todavía: se muestra en inglés

def render(d):
    pairs = ",\n".join('      "%s": "%s"' % (k, v.replace('"', '\\"').replace('\\\\"', '\\"')) for k, v in d.items())
    return '    "messenger": {\n' + pairs + '\n    },\n'

for lang, block in BLOCKS.items():
    path = f"messages/{lang}.json"
    text = io.open(path, encoding="utf-8", newline="").read()
    if '"messenger": {' in text and '"setupHint"' in text:
        print(lang, "ya tiene el bloque")
        continue
    nl = "\r\n" if "\r\n" in text else "\n"
    m = re.search(r'^  "Settings": \{\r?\n', text, re.M)
    assert m, f"{path}: no encontré la línea de Settings"
    ins = render(block).replace("\n", nl)
    text = text[: m.end()] + ins + text[m.end():]
    io.open(path, "w", encoding="utf-8", newline="").write(text)
    print(lang, "ok")
```

Verificar que los tres JSON siguen siendo válidos:

Run: `node -e "for (const l of ['en','es','ko']) JSON.parse(require('fs').readFileSync('messages/'+l+'.json','utf8')).Settings.messenger.title"`
Expected: sin salida ni error.

- [ ] **Step 10: Crear el panel de Ajustes**

`src/components/settings/messenger-config.tsx`:

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface MessengerStatus {
  connected: boolean;
  page_id?: string;
  page_name?: string;
  verify_token?: string;
  webhook_url: string;
}

export function MessengerConfig() {
  const t = useTranslations('Settings.messenger');
  const [status, setStatus] = useState<MessengerStatus | null>(null);
  const [pageId, setPageId] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/messenger/config');
    if (res.ok) setStatus(await res.json());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/messenger/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: pageId, page_access_token: token }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body?.error ?? t('errorGeneric'));
        return;
      }
      setStatus(body);
      setToken('');
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    await fetch('/api/messenger/config', { method: 'DELETE' });
    setPageId('');
    await load();
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="text-foreground">{t('title')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {status?.connected
            ? t('connectedTo', { name: status.page_name ?? status.page_id ?? '' })
            : t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        {!status?.connected && (
          <form onSubmit={connect} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="messenger-page-id" className="text-muted-foreground">
                {t('pageId')}
              </Label>
              <Input
                id="messenger-page-id"
                value={pageId}
                onChange={(e) => setPageId(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="messenger-token" className="text-muted-foreground">
                {t('pageToken')}
              </Label>
              <Input
                id="messenger-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                className="border-border bg-muted text-foreground"
              />
              <p className="text-xs text-muted-foreground">{t('tokenHidden')}</p>
            </div>
            <Button type="submit" disabled={saving} className="w-fit">
              {saving ? t('saving') : t('connect')}
            </Button>
          </form>
        )}

        {status?.connected && (
          <>
            <div className="flex flex-col gap-1">
              <Label className="text-muted-foreground">{t('webhookUrl')}</Label>
              <code className="rounded bg-muted px-3 py-2 text-xs text-foreground">
                {status.webhook_url}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-muted-foreground">{t('verifyToken')}</Label>
              <code className="rounded bg-muted px-3 py-2 text-xs text-foreground">
                {status.verify_token}
              </code>
            </div>
            <p className="text-xs text-muted-foreground">{t('setupHint')}</p>
            <Button variant="outline" onClick={disconnect} className="w-fit">
              {t('disconnect')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 11: Mostrarlo en Ajustes, debajo de WhatsApp**

En `src/app/(dashboard)/settings/page.tsx`: agregar `import { MessengerConfig } from '@/components/settings/messenger-config';` junto al import de `WhatsAppConfig`, y cambiar la línea 77 por:

```tsx
    whatsapp: (
      <div className="space-y-6">
        <WhatsAppConfig />
        <MessengerConfig />
      </div>
    ),
```

- [ ] **Step 12: Verificar**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` sin salida; vitest en verde.

- [ ] **Step 13: Commit**

```bash
git add src/lib/http src/app/auth src/app/api/messenger/config src/components/settings/messenger-config.tsx "src/app/(dashboard)/settings/page.tsx" messages src/lib/messenger/__fixtures__
git commit -m "feat: conectar la página de Facebook desde Ajustes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Responder desde la bandeja (envío, ventana de 24 h y candado de WhatsApp)

**Files:**
- Create: `src/lib/messenger/send.ts`
- Test: `src/lib/messenger/send.test.ts`
- Create: `src/app/api/messenger/send/route.ts`
- Modify: `src/lib/whatsapp/send-message.ts` (candado: después de cargar la conversación, ~línea 225)
- Test: `src/lib/whatsapp/send-message.messenger-guard.test.ts`

**Interfaces:**
- Consumes: `sendText`, `MessengerApiError` (Tarea 2); `decrypt`; `makeFakeDb`.
- Produces: `MESSENGER_WINDOW_MS`; `class MessengerSendError extends Error { code: 'not_found' | 'wrong_channel' | 'not_configured' | 'window_closed' | 'token_invalid' | 'meta_error' | 'db_error'; status: number }`; `sendMessengerText(db, accountId, { conversationId, text }): Promise<{ messageId: string; mid: string }>`.

- [ ] **Step 1: Escribir las pruebas de `send.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeDb } from './__fixtures__/fake-db'
import { MESSENGER_WINDOW_MS, MessengerSendError, sendMessengerText } from './send'

vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => `dec(${s})` }))

class FakeApiError extends Error {
  constructor(m: string, public status: number, public code?: number) {
    super(m)
  }
}
const sendText = vi.fn()
vi.mock('./graph', () => ({
  sendText: (...a: unknown[]) => sendText(...a),
  MessengerApiError: FakeApiError,
}))

const NOW = Date.parse('2026-10-06T12:00:00Z')
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString()

function seed(over: { lastInboundHoursAgo?: number | null; channel?: string } = {}) {
  const { lastInboundHoursAgo = 1, channel = 'messenger' } = over
  return makeFakeDb({
    messenger_config: [{ id: 'cfg-1', account_id: 'acct-1', page_access_token: 'enc', status: 'connected' }],
    contacts: [{ id: 'c1', account_id: 'acct-1', channel: 'messenger', external_id: 'PSID1' }],
    conversations: [{ id: 'conv1', account_id: 'acct-1', contact_id: 'c1', channel }],
    messages:
      lastInboundHoursAgo === null
        ? []
        : [
            {
              id: 'm0',
              conversation_id: 'conv1',
              sender_type: 'customer',
              created_at: hoursAgo(lastInboundHoursAgo),
            },
          ],
  })
}
const params = { conversationId: 'conv1', text: 'Hola' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  sendText.mockReset().mockResolvedValue({ messageId: 'm_sent' })
})

describe('sendMessengerText', () => {
  it('envía dentro de la ventana y guarda el mensaje saliente', async () => {
    const db = seed()
    const r = await sendMessengerText(db as never, 'acct-1', params)
    expect(sendText).toHaveBeenCalledWith('dec(enc)', 'PSID1', 'Hola')
    expect(r.mid).toBe('m_sent')
    const out = db.tables.messages.find((m) => m.sender_type === 'agent')!
    expect(out).toMatchObject({ content_text: 'Hola', message_id: 'm_sent', status: 'sent' })
    expect(db.tables.conversations[0].last_message_text).toBe('Hola')
  })

  it('Review Focus 4: pasadas 24 h no llama a Meta y avisa window_closed (409)', async () => {
    const db = seed({ lastInboundHoursAgo: MESSENGER_WINDOW_MS / 3600_000 + 1 })
    const err = await sendMessengerText(db as never, 'acct-1', params).catch((e) => e)
    expect(err).toBeInstanceOf(MessengerSendError)
    expect(err).toMatchObject({ code: 'window_closed', status: 409 })
    expect(sendText).not.toHaveBeenCalled()
  })

  it('sin ningún mensaje del cliente tampoco hay ventana abierta', async () => {
    const db = seed({ lastInboundHoursAgo: null })
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'window_closed',
    })
  })

  it('Review Focus 5: un token revocado (190) desconecta la página y avisa', async () => {
    sendText.mockRejectedValue(new FakeApiError('Token vencido', 400, 190))
    const db = seed()
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'token_invalid',
      status: 401,
    })
    expect(db.tables.messenger_config[0].status).toBe('disconnected')
    expect(db.tables.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0)
  })

  it('otro error de Meta se reporta sin desconectar nada', async () => {
    sendText.mockRejectedValue(new FakeApiError('Rate limit', 429, 4))
    const db = seed()
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'meta_error',
    })
    expect(db.tables.messenger_config[0].status).toBe('connected')
  })

  it('rechaza una conversación de WhatsApp', async () => {
    const db = seed({ channel: 'whatsapp' })
    await expect(sendMessengerText(db as never, 'acct-1', params)).rejects.toMatchObject({
      code: 'wrong_channel',
      status: 400,
    })
  })

  it('no toca conversaciones de otra cuenta', async () => {
    const db = seed()
    await expect(sendMessengerText(db as never, 'otra-cuenta', params)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    })
  })
})
```

Para que la prueba de «desconectar» funcione, el `select` de conversación con contacto embebido (`'*, contact:contacts(*)'`) no lo soporta el fake; por eso `send.ts` carga la conversación y el contacto con **dos consultas simples** (así se escribe abajo).

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run src/lib/messenger/send.test.ts`
Expected: FAIL (`Cannot find module './send'`).

- [ ] **Step 3: Implementar `send.ts`**

```ts
// Responder a un cliente de Messenger desde la bandeja (solo texto).
//
// La ventana de Messenger es de 24 h contadas desde el ÚLTIMO mensaje del
// cliente; pasada esa ventana Meta solo permite contestar con etiquetas
// especiales que esta versión no usa, así que se rechaza ANTES de llamar a Meta.

import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { MessengerApiError, sendText } from './graph'

export const MESSENGER_WINDOW_MS = 24 * 60 * 60 * 1000

/** Código de Graph para un token vencido o revocado. */
const GRAPH_INVALID_TOKEN = 190

export type MessengerSendErrorCode =
  | 'not_found'
  | 'wrong_channel'
  | 'not_configured'
  | 'window_closed'
  | 'token_invalid'
  | 'meta_error'
  | 'db_error'

export class MessengerSendError extends Error {
  constructor(
    public code: MessengerSendErrorCode,
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'MessengerSendError'
  }
}

export async function sendMessengerText(
  db: SupabaseClient,
  accountId: string,
  params: { conversationId: string; text: string },
): Promise<{ messageId: string; mid: string }> {
  const { conversationId, text } = params

  const { data: conversation } = await db
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conversation) {
    throw new MessengerSendError('not_found', 'Conversation not found', 404)
  }
  if (conversation.channel !== 'messenger') {
    throw new MessengerSendError(
      'wrong_channel',
      'This conversation is not on Messenger; use /api/whatsapp/send',
      400,
    )
  }

  const { data: contact } = await db
    .from('contacts')
    .select('*')
    .eq('id', conversation.contact_id)
    .maybeSingle()
  if (!contact?.external_id) {
    throw new MessengerSendError('not_found', 'Contact has no Messenger id', 404)
  }

  const { data: config } = await db
    .from('messenger_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!config || config.status !== 'connected') {
    throw new MessengerSendError(
      'not_configured',
      'Messenger is not connected. Connect the page in Settings.',
      400,
    )
  }

  const { data: inbound } = await db
    .from('messages')
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .order('created_at', { ascending: false })
    .limit(1)
  const lastInbound = inbound?.[0]?.created_at as string | undefined
  if (!lastInbound || Date.now() - new Date(lastInbound).getTime() > MESSENGER_WINDOW_MS) {
    throw new MessengerSendError(
      'window_closed',
      'The 24-hour Messenger window is closed. The customer has to write first.',
      409,
    )
  }

  let mid: string
  try {
    mid = (await sendText(decrypt(config.page_access_token), contact.external_id, text)).messageId
  } catch (err) {
    if (err instanceof MessengerApiError) {
      if (err.code === GRAPH_INVALID_TOKEN) {
        // Sin esto cada envío siguiente fallaría igual y en silencio: se marca
        // la página como desconectada para que Ajustes lo muestre.
        await db.from('messenger_config').update({ status: 'disconnected' }).eq('id', config.id)
        throw new MessengerSendError(
          'token_invalid',
          'The page token is invalid or was revoked. Reconnect the page in Settings.',
          401,
        )
      }
      throw new MessengerSendError('meta_error', err.message, 502)
    }
    throw err
  }

  const { data: row, error } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: 'text',
      content_text: text,
      message_id: mid,
      status: 'sent',
    })
    .select()
    .single()
  if (error || !row) {
    throw new MessengerSendError(
      'db_error',
      'Message sent to Meta but failed to save to DB',
      500,
    )
  }

  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: now, updated_at: now })
    .eq('id', conversationId)

  return { messageId: row.id as string, mid }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run src/lib/messenger/send.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Implementar la ruta de envío**

`src/app/api/messenger/send/route.ts`:

```ts
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
```

- [ ] **Step 6: Escribir la prueba del candado de WhatsApp**

`src/lib/whatsapp/send-message.messenger-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SendMessageError, sendMessageToConversation } from './send-message'

// Review Focus 6: ningún camino de WhatsApp (API pública, envío de la bandeja,
// automatizaciones) debe poder mandar a una conversación de Messenger — ni
// siquiera con un contacto sin teléfono, que daría un error confuso.
function dbReturning(conversation: Record<string, unknown>) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  Object.assign(builder, {
    select: chain,
    eq: chain,
    single: async () => ({ data: conversation, error: null }),
  })
  return { from: () => builder } as never
}

describe('sendMessageToConversation', () => {
  it('rechaza una conversación de Messenger con un error que dice dónde enviar', async () => {
    const db = dbReturning({ id: 'c1', channel: 'messenger', contact: { phone: null } })
    const err = await sendMessageToConversation(db, 'acct-1', {
      conversationId: 'c1',
      messageType: 'text',
      contentText: 'hola',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(SendMessageError)
    expect(err.status).toBe(400)
    expect(err.message).toContain('/api/messenger/send')
  })
})
```

- [ ] **Step 7: Verificar que falla**

Run: `npx vitest run src/lib/whatsapp/send-message.messenger-guard.test.ts`
Expected: FAIL (hoy el mensaje es `Contact phone number not found`, que no contiene `/api/messenger/send`).

- [ ] **Step 8: Poner el candado**

En `src/lib/whatsapp/send-message.ts`, justo antes de `const contact = conversation.contact;`, agregar:

```ts
  // Messenger tiene su propio camino de envío (ventana de 24 h, token de
  // página). Se corta aquí, antes de mirar el teléfono: un contacto de
  // Messenger no tiene, y "Contact phone number not found" mandaría a quien
  // llama a buscar un problema que no existe.
  if (conversation.channel === 'messenger') {
    throw new SendMessageError(
      'bad_request',
      'This conversation is on Messenger; send through /api/messenger/send',
      400
    );
  }

```

- [ ] **Step 9: Verificar todo**

Run: `npx vitest run src/lib/whatsapp src/lib/messenger src/app/api/whatsapp/send && npx tsc --noEmit`
Expected: PASS y `tsc` sin salida (incluye las pruebas existentes de `send`).

- [ ] **Step 10: Commit**

```bash
git add src/lib/messenger/send.ts src/lib/messenger/send.test.ts src/app/api/messenger/send src/lib/whatsapp/send-message.ts src/lib/whatsapp/send-message.messenger-guard.test.ts
git commit -m "feat: responder a Messenger desde la bandeja

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Interfaz de la bandeja

**Files:**
- Modify: `src/components/inbox/message-thread.tsx` (envío de texto ~línea 487; `MessageComposer` ~línea 1176)
- Modify: `src/components/inbox/message-composer.tsx` (props ~112; `sessionExpired` ~549; menú de adjuntos y plantilla ~631-709)
- Modify: `src/components/inbox/conversation-list.tsx:475-478`

**Interfaces:**
- Consumes: `Conversation.channel` (Tarea 1); `POST /api/messenger/send` (Tarea 6).
- Produces: prop `textOnly?: boolean` en `MessageComposer`.

No hay pruebas de componentes en este repo para la bandeja; la verificación es `tsc` + `eslint` y la prueba manual de la Tarea 9.

- [ ] **Step 1: Elegir el endpoint de envío de texto según el canal**

En `message-thread.tsx`, dentro de `handleSend`, reemplazar el bloque `const res = await fetch("/api/whatsapp/send", { ... })` del envío de texto (el que lleva `message_type: "text"`, ~línea 487) por:

```tsx
        const isMessenger = conversation.channel === "messenger";
        const res = await fetch(
          isMessenger ? "/api/messenger/send" : "/api/whatsapp/send",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              isMessenger
                ? { conversation_id: conversation.id, content_text: text }
                : {
                    conversation_id: conversation.id,
                    message_type: "text",
                    content_text: text,
                    reply_to_message_id: replyToId,
                  },
            ),
          },
        );
```

Si `handleSend` es un `useCallback`, agregar `conversation.channel` a su lista de dependencias.

- [ ] **Step 2: Pasar `textOnly` al compositor**

En el `<MessageComposer ... />` (~línea 1176) agregar la prop:

```tsx
        textOnly={conversation.channel === "messenger"}
```

- [ ] **Step 3: Aceptar `textOnly` en el compositor**

En `message-composer.tsx`, en `MessageComposerProps` agregar:

```ts
  /** Messenger solo admite texto en esta versión: oculta adjuntos y plantillas. */
  textOnly?: boolean;
```

y en la desestructuración de `MessageComposer({ ... })` agregar `textOnly,` junto a `onClearReply,`.

- [ ] **Step 4: Ocultar adjuntos y plantillas**

(a) Banner de sesión vencida: envolver el `<Button ... onClick={onOpenTemplates}> ... </Button>` que está dentro de `{sessionExpired && ( ... )}` en `{!textOnly && ( ... )}`.

(b) En la barra de entrada, envolver desde el comentario `{/* Attach menu — photo / video / document / voice. */}` hasta el cierre `</GatedButton>` del **primer** `GatedButton` (el de `t("sendTemplate")`) en:

```tsx
          {!textOnly && (
            <>
              {/* Attach menu — photo / video / document / voice. */}
              ... (el DropdownMenu y el GatedButton de plantillas, sin cambios) ...
            </>
          )}
```

El botón de IA (`t("draftWithAI")`) y el `<textarea>` quedan fuera del envoltorio.

- [ ] **Step 5: Insignia de canal en la lista**

En `conversation-list.tsx`, reemplazar el bloque

```tsx
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
```
por
```tsx
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {displayName}
            </span>
            {conversation.channel === "messenger" && (
              <span className="shrink-0 rounded bg-blue-500/15 px-1 text-[9px] font-semibold uppercase text-blue-400">
                Messenger
              </span>
            )}
          </span>
```

- [ ] **Step 6: Verificar**

Run: `npx tsc --noEmit && npx eslint src/components/inbox && npx vitest run`
Expected: sin errores de `tsc` ni de `eslint` nuevos; vitest en verde.

- [ ] **Step 7: Commit**

```bash
git add src/components/inbox
git commit -m "feat: bandeja con insignia de Messenger y compositor de solo texto

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Aislamiento de Messenger

**Files:**
- Create: `src/lib/api/v1/channel.ts`
- Test: `src/lib/api/v1/channel.test.ts`
- Modify: `src/app/api/v1/conversations/route.ts:47-52`
- Modify: `src/app/api/v1/contacts/route.ts:54-58`
- Modify: `src/components/broadcasts/step2-select-audience.tsx` (consultas a `contacts`, ~209 y las demás)
- Modify: `src/hooks/use-broadcast-sending.ts` (consultas a `contacts`: ~171, 192, 266, 296, 340)
- Modify: `src/components/broadcasts/step3-personalize.tsx:97`, `step4-schedule-send.tsx:62`

**Interfaces:**
- Produces: `parseChannelParam(raw: string | null): { channel: 'whatsapp' | 'messenger' } | { error: string }`.

- [ ] **Step 1: Escribir la prueba del parámetro**

```ts
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
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run src/lib/api/v1/channel.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
// Interpreta `?channel=` en la API pública. El valor por omisión es 'whatsapp'
// a propósito: Claudia sondea /api/v1/conversations y contesta por WhatsApp con
// el teléfono del contacto; si Messenger apareciera sin pedirlo, intentaría
// escribirle a un PSID como si fuera un teléfono.

export type ApiChannel = 'whatsapp' | 'messenger'

export function parseChannelParam(
  raw: string | null,
): { channel: ApiChannel } | { error: string } {
  if (raw === null) return { channel: 'whatsapp' }
  if (raw === 'whatsapp' || raw === 'messenger') return { channel: raw }
  return { error: "'channel' must be 'whatsapp' or 'messenger'" }
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run src/lib/api/v1/channel.test.ts` → PASS (3 tests).

- [ ] **Step 5: Filtrar la API pública de conversaciones**

En `src/app/api/v1/conversations/route.ts`: agregar `import { parseChannelParam } from '@/lib/api/v1/channel';`. Después de `const contactId = url.searchParams.get('contact_id');` agregar:

```ts
    const parsedChannel = parseChannelParam(url.searchParams.get('channel'));
    if ('error' in parsedChannel) return fail('bad_request', parsedChannel.error, 400);
```

y después de `.eq('account_id', ctx.accountId);` de la consulta agregar el filtro, de modo que quede:

```ts
    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', ctx.accountId)
      .eq('channel', parsedChannel.channel);
```

- [ ] **Step 6: Filtrar la API pública de contactos**

En `src/app/api/v1/contacts/route.ts`: agregar el mismo import; después de `const tag = url.searchParams.get('tag');` agregar las dos líneas de `parseChannelParam` (con `fail` si ya está importado en ese archivo; si no, importar `fail` de `@/lib/api/v1/respond`), y cambiar la consulta a:

```ts
    let query = ctx.supabase
      .from('contacts')
      .select(selectClause)
      .eq('account_id', ctx.accountId)
      .eq('channel', parsedChannel.channel);
```

- [ ] **Step 7: Excluir Messenger del envío masivo**

Los envíos masivos arman la audiencia desde el navegador. En cada consulta a `contacts` de estos tres archivos agregar `.eq('channel', 'whatsapp')` justo después de `.select(...)`:

Run: `grep -n "from('contacts')" src/components/broadcasts/step2-select-audience.tsx src/components/broadcasts/step3-personalize.tsx src/components/broadcasts/step4-schedule-send.tsx src/hooks/use-broadcast-sending.ts`

Para cada coincidencia, el cambio es (ejemplo real de `step2-select-audience.tsx:209`):

```ts
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true })
          .eq('channel', 'whatsapp');
```
y de `use-broadcast-sending.ts:171`:
```ts
      const { data, error } = await supabase.from('contacts').select('*').eq('channel', 'whatsapp');
```

Después de editar, comprobar que no quedó ninguna consulta sin filtro:

Run: `grep -n "from('contacts')" -A3 src/components/broadcasts/step2-select-audience.tsx src/components/broadcasts/step3-personalize.tsx src/components/broadcasts/step4-schedule-send.tsx src/hooks/use-broadcast-sending.ts | grep -c "channel"`
Expected: el mismo número que las coincidencias del `grep` anterior.

- [ ] **Step 8: Verificar todo**

Run: `npx tsc --noEmit && npx vitest run`
Expected: `tsc` sin salida; vitest en verde.

- [ ] **Step 9: Commit**

```bash
git add src/lib/api/v1 src/app/api/v1 src/components/broadcasts src/hooks/use-broadcast-sending.ts
git commit -m "feat: dejar a Messenger fuera de la API de Claudia y de los envíos masivos

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Despliegue y prueba de punta a punta (con el usuario)

**Files:** ninguno. Verificación manual con el sistema desplegado.

Los pasos 1, 3 y 4 son **irreversibles o visibles para clientes**: no se ejecutan sin confirmación explícita del usuario.

- [ ] **Step 1: Migración (si no se aplicó en la Tarea 1)**

Confirmar con el usuario y aplicar `048_messenger_channel.sql`; correr las tres consultas de verificación de la Tarea 1, paso 11.

- [ ] **Step 2: Suite completa antes de empujar**

Run: `npx tsc --noEmit && npx vitest run && npx eslint src`
Expected: todo en verde.

- [ ] **Step 3: Empujar (CONFIRMAR)**

```bash
cd /d/wacrm && git push origin main
```

Esperar a que Dokploy termine (~3 min) y comprobar que la ruta nueva existe (un 200 por sí solo también lo da la versión vieja):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://crm.ambar-apps.cloud/api/messenger/webhook?hub.mode=subscribe&hub.challenge=x&hub.verify_token=x"
```
Expected: `403` (ruta nueva: rechaza el token); `404` significa que aún corre la versión vieja.

- [ ] **Step 4: Conectar la página (lo hace el usuario en Meta)**

1. En la app de Meta, agregar el producto **Messenger** y asociar la página de Ambar Cargo.
2. Generar el token de acceso de la página (permisos `pages_messaging` y `pages_manage_metadata`).
3. En wacrm → Ajustes → pestaña WhatsApp → tarjeta **Messenger**: pegar el ID de la página y el token, y pulsar **Conectar página**. Deben aparecer la URL del webhook y el token de verificación.
4. En Meta → Messenger → Webhooks: pegar esa URL y ese token, y suscribir la página al campo `messages`.

Expected: Meta acepta el webhook (la verificación `GET` devuelve 200).

- [ ] **Step 5: Probar con una cuenta con rol en la app**

Mientras la app de Meta no tenga acceso avanzado a `pages_messaging`, solo reciben mensajes las personas con un rol en la app (administrador, desarrollador, probador). Desde una de esas cuentas de Facebook, escribir a la página:

1. El mensaje aparece en la bandeja con la insignia **Messenger** y el nombre de quien escribió.
2. Responder desde la bandeja con texto: llega a Messenger. El compositor no muestra adjuntos ni plantillas.
3. Escribir de nuevo desde Facebook: entra a la **misma** conversación, sin duplicar el contacto.
4. Con la conversación abierta, comprobar que `GET /api/v1/conversations` (con una clave de API) **no** la devuelve, y que `?channel=messenger` sí.
5. Esperar más de 24 h sin escribir (o ajustar la hora del último mensaje en la base) e intentar responder: debe avisar que la ventana de 24 h está cerrada.

- [ ] **Step 6: Comprobar que WhatsApp no se rompió**

Escribir al número de WhatsApp de pruebas (`5213338316311`) y comprobar que entra, se asigna y Claudia responde como antes.

---

## Self-Review

**Cobertura de la spec:**

| Requisito de la spec | Tarea |
| --- | --- |
| Datos: `channel`, `external_id`, `phone` opcional, restricciones, índice, `messenger_config` + RLS | 1 |
| Webhook propio, firma, `after()`, página desconocida con 200, ecos ignorados, dedupe por `mid` | 3, 4 |
| Texto e imágenes; otros adjuntos como texto | 3 |
| Envío propio, ventana de 24 h, estados del mensaje | 6 |
| Insignia de canal, compositor de solo texto, barra lateral sin teléfono | 1 (barra lateral), 7 |
| Ajustes: ID de página y token, URL del webhook y verify token | 5 |
| Aislamiento: API pública `?channel=`, envíos masivos, candado de WhatsApp | 6 (candado), 8 |
| Token vencido → desconectado | 6 |
| Pruebas: webhook, envío, aislamiento, restricción de BD | 3, 4, 6, 8; la restricción de BD se verifica con las consultas del paso 11 de la Tarea 1 |
| Requisitos del lado de Meta | 9 |

**Sin marcadores pendientes:** el plan no deja «TODO», «TBD» ni pasos sin código. Las dos ediciones de JSX de la Tarea 7 (envolver el menú de adjuntos) se describen con anclas literales del código y no con el bloque completo, porque el bloque tiene ~80 líneas que no cambian.

**Consistencia de tipos:** `MessengerInboundEvent` (Tarea 3) lo consume `processInboundEvent` (4); `getUserName`/`sendText`/`getPage`/`MessengerApiError` (2) los usan 4, 5 y 6; `sendMessengerText` y `MessengerSendError` (6) los usa la ruta de envío; `requestOrigin` (5) lo usan la ruta de configuración y el callback de autenticación; `parseChannelParam` (8) lo usan las dos rutas v1; `makeFakeDb` (4) lo amplían las Tareas 5 (`delete`, `upsert` con reemplazo, `messenger_config` único) y se reutiliza en la 6.

**Riesgos reconocidos del plan:**
- La Tarea 7 no tiene pruebas automáticas (el repo no prueba la bandeja); se cubre con `tsc`, `eslint` y la prueba manual de la Tarea 9.
- La migración se aplica sobre la base de producción: por eso el paso 11 de la Tarea 1 y el paso 1 de la Tarea 9 exigen confirmación.
- La política de Meta sobre acceso avanzado a `pages_messaging` no se pudo verificar contra el estado de la app de Ambar (ver spec).
