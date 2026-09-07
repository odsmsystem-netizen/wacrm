# El agente de WhatsApp (`agente/`)

Este repositorio contiene dos programas que se despliegan juntos pero
corren por separado:

| Carpeta | Qué es | Lenguaje |
|---|---|---|
| raíz (`src/`, `supabase/`…) | El CRM | TypeScript / Next.js |
| `agente/` | El asistente que contesta WhatsApp | Python / FastAPI |

## Por qué son dos procesos y no uno

El agente encadena llamadas al modelo y a NetSuite que tardan segundos
—una cotización son cuatro o cinco idas y vueltas—. Dentro del CRM, ese
trabajo bloquearía peticiones de la bandeja mientras el modelo piensa.

Tampoco comparten lenguaje ni base de datos: el CRM vive en Supabase y
el agente en SQLite más NetSuite por OAuth1. Unificarlos en un solo
programa obligaría a reescribir unas 6.000 líneas ya probadas para
llegar exactamente al mismo comportamiento.

Se hablan por la **API pública v1 del CRM**, igual que lo haría una
integración de un tercero. El agente no toca la base de datos del CRM ni
al revés.

## Cómo se comunican

```
Cliente → Meta → CRM  (guarda el mensaje, lo muestra en la bandeja)
                  ↑ ↓
                  agente  (sondea, decide, responde por la API)
```

El agente **sondea** el CRM cada pocos segundos en vez de recibir
webhooks. La razón está en el código del CRM: entrega sus webhooks con un
solo intento y 5 segundos de plazo, y a los 15 fallos seguidos desactiva
el endpoint. El agente tarda más que eso, así que cada entrega se
marcaría como fallida. Sondeando, todas las llamadas salen del agente y
no hace falta exponerlo a internet.

## Arrancar los dos en local

```bash
docker compose up -d
```

Levanta el CRM y el agente. Necesitas dos archivos que **no están en el
repositorio** porque llevan credenciales:

- `.env.local` — configuración del CRM (ver `docs/docker.md`)
- `agente/.env` — configuración del agente (ver `agente/.env.example`)

Y dos bases de datos del agente, que tampoco se versionan porque llevan
datos de clientes:

- `agente/agentkit.db` — memoria de conversaciones
- `agente/netsuite_sync.db` — el catálogo, unos 2.5 MB sincronizados de
  NetSuite una vez al día

Sin la segunda el agente arranca sin quejarse y **no puede cotizar
nada**: no falla al iniciar, falla cuando un cliente pregunta un precio.
Los tests lo detectan y se saltan solos con un aviso, en vez de fingir
que pasan.

## Desplegar el agente en Easypanel

El CRM ya se despliega como una App apuntando a la raíz del repositorio.
El agente se añade como **una segunda App en el mismo proyecto**:

1. **Source** → el mismo repositorio, misma rama.
2. **Build** → tipo Dockerfile, con **Build context** `agente` y
   **Dockerfile path** `agente/Dockerfile`.
3. **Environment** → el contenido de `agente/.env`. Dentro del proyecto
   el CRM es alcanzable por el nombre de su servicio, así que
   `WACRM_URL` apunta ahí y no al dominio público — que en esta red no
   vuelve, por no haber hairpin NAT.
4. **Mounts** → volúmenes persistentes para `/app/agentkit.db`,
   `/app/netsuite_sync.db` y `/app/transcripts`. Sin esto se pierden en
   cada despliegue.

Con eso el agente arranca solo con el servidor y se reinicia si se cae,
igual que el CRM.

## Permisos que necesita su clave de API

Se crea en el CRM, en **Ajustes → Claves de API**, y no se pueden
editar después: si falta uno, hay que generar otra clave.

| Scope | Sin él |
|---|---|
| `messages:send` | no puede responder |
| `messages:read` | no ve lo que escribió el cliente |
| `conversations:read` | no sabe si un humano ya tomó el chat |
| `deals:write` | la cotización no aparece en el panel del contacto |
| `conversations:write` | no puede asignar sola una conversación |
| `contacts:read`, `contacts:write` | no puede etiquetar |

Los tres primeros son imprescindibles: sin ellos el agente no arranca y
lo dice al iniciar. Los demás son opcionales — arranca igual y avisa qué
queda deshabilitado.

## Qué NO tocar desde el agente

El agente usa la API pública, con las mismas reglas que cualquier
integración externa. No abre conexiones a la base del CRM ni comparte su
sesión. Si algo que necesita no está en la API, la solución es añadir el
endpoint, no saltarse la frontera.
