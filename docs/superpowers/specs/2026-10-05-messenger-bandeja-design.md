# Messenger en la bandeja de wacrm — diseño

Fecha: 2026-10-05. Estado: **borrador para revisión**.

## Objetivo

Que lo que los clientes escriban por Messenger a la página de Facebook de Ambar
Cargo llegue a la bandeja de wacrm, junto a las conversaciones de WhatsApp, y que
el equipo pueda responder a mano desde ahí.

Lo dijo el usuario (2026-10-05): bandeja + respuesta manual; es administrador de la
página de Facebook y de la app de Meta que ya usa WhatsApp.

## Fuera de alcance (primera versión)

- Que Claudia IA conteste en Messenger.
- Plantillas, envíos masivos, automatizaciones y flujos sobre Messenger.
- Inicio de sesión con Facebook (OAuth). La conexión es pegando ID de página y token.
- Instagram, comentarios de publicaciones y otros objetos de Meta.
- Varias páginas por cuenta. Una cuenta de wacrm conecta **una** página.

## Hechos del código que condicionan el diseño (verificados)

- `contacts.phone` es `NOT NULL` (migración 001). Un contacto de Messenger no tiene
  teléfono: se identifica por un PSID, único por página.
- `whatsapp_config` guarda `phone_number_id`, `waba_id` y `access_token` de WhatsApp;
  no hay ninguna noción de canal en el esquema ni en el código (los «channel» que
  existen son canales de tiempo real de Supabase).
- El webhook de WhatsApp (`src/app/api/whatsapp/webhook/route.ts`, 1259 líneas) es
  específico de ese canal. Verifica la firma con `verifyMetaWebhookSignature` y
  procesa dentro de `after()` para responder a Meta a tiempo.
- La API pública `/api/v1/conversations` serializa `contact.phone: string`
  (`src/lib/api/v1/conversations.ts`). **Claudia consume esa API** y contesta por
  WhatsApp usando ese teléfono. Una conversación de Messenger sin teléfono en esa
  lista rompería el contrato y haría que Claudia intentara escribirle a un PSID.
- Hay ~78 usos de `.phone` fuera de pruebas (envíos masivos, automatizaciones, flujos,
  importación, formularios). Cualquiera que dé por hecho que todo contacto tiene
  teléfono debe seguir funcionando.
- El compositor de la bandeja ya impone la ventana de 24 h para texto libre y medios
  (`message-composer.tsx`); es la misma regla que aplica Messenger.

## Diseño

### 1. Datos (migración 048)

- `contacts.channel` y `conversations.channel`: `TEXT NOT NULL DEFAULT 'whatsapp'`
  con `CHECK (channel IN ('whatsapp','messenger'))`. Todo lo existente queda como
  `whatsapp` sin tocarse.
- `contacts.phone` pasa a admitir `NULL`. Se agrega `contacts.external_id TEXT`
  (el PSID).
- Restricción que obliga a cada canal a traer su identificador:
  `CHECK ((channel = 'whatsapp' AND phone IS NOT NULL) OR (channel = 'messenger' AND external_id IS NOT NULL))`.
- Índice único `(account_id, channel, external_id) WHERE external_id IS NOT NULL`,
  para que un PSID no duplique contactos.
- Tabla `messenger_config`: `account_id` (único), `page_id`, `page_name`,
  `page_access_token` (cifrado con el mismo mecanismo que usa la configuración de IA),
  `verify_token`, `status` (`connected`/`disconnected`), marcas de tiempo. RLS por
  cuenta, igual que `whatsapp_config`.
- `messages` reutiliza sus columnas. El id de mensaje de Meta (`mid`) va en
  `message_id`, que ya existe y sirve para deduplicar reintentos.

### 2. Entrada: `POST /api/messenger/webhook`

- Ruta propia, separada del webhook de WhatsApp. `GET` responde el desafío de
  verificación con `verify_token`.
- `POST` verifica `x-hub-signature-256` con `verifyMetaWebhookSignature` (misma app,
  misma app secret) y procesa dentro de `after()`, como el de WhatsApp.
- Localiza la cuenta por `entry[].id` = `messenger_config.page_id`. Una página
  desconocida se ignora con 200 (para que Meta no la reintente) y deja un aviso en el
  registro.
- Por cada `messaging[]` con `message`: ignora los `is_echo` (los que envía la propia
  página), busca o crea el contacto por PSID (nombre desde la API de perfil de Meta,
  con el PSID como respaldo si falla), busca o crea la conversación, e inserta el
  mensaje deduplicando por `mid`.
- Texto e imágenes en esta versión. Otros adjuntos se guardan como texto indicando el
  tipo («[audio recibido]»), sin descargarse.

### 3. Salida: `POST /api/messenger/send`

- Recibe `conversation_id` y texto; comprueba que la conversación sea de la cuenta del
  llamador y de canal `messenger`.
- Envía por la Send API de Meta con el token de la página
  (`messaging_type: RESPONSE`).
- **Ventana de 24 h:** si el último mensaje entrante tiene más de 24 h, rechaza con un
  error claro. No se usan etiquetas especiales en esta versión.
- Registra el mensaje saliente con su `mid` y estado, igual que WhatsApp.

### 4. Interfaz

- Lista de conversaciones: insignia de canal (WhatsApp / Messenger).
- Hilo: el compositor elige el endpoint de envío según el canal de la conversación y
  reutiliza el aviso de ventana de 24 h; en Messenger se ocultan plantillas, audio y
  documentos.
- Barra lateral del contacto: si es de Messenger, muestra el nombre y el canal en vez
  del teléfono.
- Ajustes: sección «Messenger» para pegar ID de página y token, y mostrar la URL del
  webhook y el verify token. Un botón comprueba el token contra Meta.

### 5. Aislamiento (la parte que más importa)

Messenger **no debe** entrar a nada que asuma un teléfono:

- `/api/v1/conversations` y `/api/v1/contacts` devuelven solo `whatsapp` por defecto.
  Para ver los de Messenger hay que pedirlo con `?channel=messenger`. El contrato
  actual y el sondeo de Claudia no cambian. Se agrega `channel` a las respuestas.
- Envíos masivos, automatizaciones, flujos y la respuesta automática de IA filtran
  `channel = 'whatsapp'` y se prueban con un contacto de Messenger en la cuenta.
- Importación y formularios de contactos siguen creando solo contactos de WhatsApp.

### 6. Errores y casos límite

- Firma inválida: 401 (como WhatsApp).
- Token de página vencido o revocado: el envío falla con el error de Meta y la
  configuración pasa a `disconnected`, con aviso en Ajustes.
- Reintentos de Meta: la deduplicación por `mid` evita mensajes dobles.
- Fuera de la ventana de 24 h: el compositor lo avisa y el endpoint lo rechaza.

### 7. Pruebas

- Pruebas de unidad del webhook (firma, eco, deduplicación, página desconocida) y del
  envío (ventana, canal incorrecto, cuenta ajena), siguiendo `route.test.ts` del
  webhook de WhatsApp.
- Prueba de aislamiento: con un contacto de Messenger en la cuenta, la lista de
  `/api/v1/conversations`, los envíos masivos y las automatizaciones **no** lo
  devuelven ni lo tocan.
- Prueba de la restricción de base de datos: no se puede crear un contacto sin
  teléfono ni PSID.

## Requisitos del lado de Meta (los hace el usuario)

1. En la app de Meta, agregar el producto **Messenger** y asociar la página.
2. Generar el token de acceso de la página (permisos `pages_messaging` y
   `pages_manage_metadata`).
3. Configurar el webhook de Messenger con la URL `…/api/messenger/webhook`, el verify
   token y la suscripción al campo `messages`.

**Riesgo a verificar en el panel de Meta:** según la política de Meta, mientras la app
no tenga acceso avanzado a `pages_messaging` (revisión de la app), solo reciben
mensajes de personas con un rol en la app (administradores, desarrolladores,
probadores). Para pruebas internas basta; para público general hay que aprobar la
revisión. No lo he comprobado contra el estado actual de la app de Ambar.

## Decisiones abiertas

Ninguna que bloquee la implementación. Pendiente de confirmar con el panel de Meta: el
estado de la revisión de la app, que no cambia el diseño sino cuándo el público podrá
usarlo.
