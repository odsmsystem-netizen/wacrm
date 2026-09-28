# Despliegue en Dokploy (ambar-apps.cloud)

Este documento describe el despliegue **de esta instalación** —el CRM y
el agente Claudia— en un VPS con [Dokploy](https://dokploy.com). Para el
despliegue genérico del template ver [easypanel.md](easypanel.md) y
[docker.md](docker.md).

## Panorama

Dos aplicaciones, **dos repositorios**, y una base de datos que no vive
en el VPS:

| Pieza | Qué es | Repositorio | Dominio |
| --- | --- | --- | --- |
| CRM (`wacrm`) | Next.js 16, imagen `standalone` | `odsmsystem-netizen/wacrm` | `crm.ambar-apps.cloud` |
| Agente (Claudia) | FastAPI/Python, puerto 8000 | `odsmsystem-netizen/whatsapp-agentkit` | `claudia.ambar-apps.cloud` |
| Supabase | Postgres + Auth gestionados | — | externo (`*.supabase.co`) |

Supabase es un servicio **gestionado, ajeno al VPS**. No hay base de
datos que migrar ni respaldar en el servidor: mover el CRM de Easypanel
a Dokploy no toca los datos. Eso también significa que un VPS caído no
pierde información.

En Dokploy se crean **dos aplicaciones dentro del mismo proyecto**, cada
una apuntando a su propio repositorio de GitHub. Comparten la red interna
para hablarse sin salir a internet.

## La diferencia que rompe el primer intento

Easypanel reenvía **todas** las variables del servicio al constructor
como build args. **Dokploy no.** Tiene un campo aparte, *Build Time
Arguments*, en la pestaña **Environment**, y el `Dockerfile` solo recibe
lo que ahí se declare.

Esto importa porque los cuatro valores `NEXT_PUBLIC_*` se **incrustan en
el bundle de JavaScript durante `npm run build`**: ponerlos únicamente
como variables de entorno no tiene ningún efecto sobre la imagen. El
`Dockerfile` corta el build con un error explícito si falta alguno, así
que el síntoma es un build rojo con este texto —no una app rota en
silencio:

```
ERROR: missing required build-time variable(s): NEXT_PUBLIC_SITE_URL
```

Si ves ese error, faltan *Build Time Arguments*, no variables de entorno.

## Aplicación 1 — el CRM

### Source

- **Provider:** GitHub
- **Repositorio:** `odsmsystem-netizen/wacrm`
- **Rama:** `main`
- **Docker Context Path:** `.` (el contexto por omisión; el `Dockerfile` copia desde la raíz del repositorio)

### Build

- **Build Type:** `Dockerfile`
- **Dockerfile Path:** `Dockerfile`
- **Docker Build Stage:** vacío (la imagen ya termina en el stage
  `runner`; fijar un stage intermedio produce una imagen sin servidor)

### Dominio — antes del primer deploy

- **Host:** `crm.ambar-apps.cloud`
- **Container Port:** `3000`
- **HTTPS:** activado (Let's Encrypt)

Hazlo **antes** de construir. El hostname entra en `NEXT_PUBLIC_SITE_URL`,
que es un valor de build: configurarlo después cuesta una reconstrucción
completa.

### Environment

Pestaña **Environment**, campo principal (sintaxis dotenv):

```dotenv
# Sustituye CADA valor por el real antes de guardar.
# Si pegas este bloque tal cual, el panel acepta los marcadores como si
# fueran claves: la aplicación construye, arranca y solo falla al iniciar
# sesión, con una clave que no existe inlineada en el bundle.
NEXT_PUBLIC_SUPABASE_URL=https://PROYECTO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_SITE_URL=https://crm.ambar-apps.cloud
NEXT_PUBLIC_APP_LOCALE=es

SUPABASE_SERVICE_ROLE_KEY=eyJ...
ENCRYPTION_KEY=64_CARACTERES_HEX
META_APP_SECRET=APP_SECRET_DE_META
AUTOMATION_CRON_SECRET=CADENA_LARGA_ALEATORIA
```

Comprobación rápida tras guardar: ningún valor debe contener `<`, `>`,
puntos suspensivos ni espacios. Un marcador copiado por error no da
ningún aviso — el build pasa el guard, porque el guard comprueba que la
variable no esté *vacía*, no que sea válida.

**No pongas `PORT`.** La imagen escucha en 3000 y liga `0.0.0.0`;
sobrescribirlo solo desincroniza el proceso del puerto del dominio y
produce un 502.

### Build-time Arguments

La pestaña **Environment** tiene tres campos, y conviene saber cuál es
cuál antes de pegar nada:

| Campo | Cuándo se lee | Qué va aquí |
| --- | --- | --- |
| **Environment Settings** | En ejecución | Todo: los cuatro públicos y los tres secretos |
| **Build-time Arguments** | Durante el build, **queda en las capas** | Solo los cuatro `NEXT_PUBLIC_*` |
| **Build-time Secrets** | Durante el build, **no deja rastro** | Nada en este proyecto |

*Build-time Secrets* usa el mecanismo de secretos de BuildKit, que monta
el valor solo mientras corre la instrucción y no lo graba en ninguna
capa. Es el campo correcto para algo como un `NPM_TOKEN` de un registro
privado. Este repositorio no lo necesita: el `Dockerfile` no declara
ningún `--mount=type=secret`, así que **se queda vacío**.

En **Build-time Arguments** repite **solo** los cuatro públicos, con los
mismos valores reales que pusiste arriba:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://PROYECTO.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_SITE_URL=https://crm.ambar-apps.cloud
NEXT_PUBLIC_APP_LOCALE=es
```

Que estos cuatro viajen en el bundle del cliente no es un descuido: son
públicos por diseño. La protección de la base no es esconder el `anon
key`, es Row Level Security. El `service role key`, que sí salta RLS,
nunca aparece aquí.

Para verificar que el valor llegó de verdad, una vez desplegado:

```bash
curl -s https://crm.ambar-apps.cloud/login \
  | grep -oE '/_next/static/[^"]+\.js' | sort -u \
  | while read c; do curl -s "https://crm.ambar-apps.cloud$c"; done \
  | grep -o 'PROYECTO\.supabase\.co","[^"]\{0,12\}'
```

Debe imprimir la URL seguida del principio de una clave (`eyJ...`). Si
imprime la URL seguida de otra cosa, lo que se guardó no era la clave.

#### Por qué los secretos no se repiten aquí

Un build arg queda grabado en los metadatos de la imagen y en las capas:
cualquiera que corra `docker history` sobre esa imagen lo lee. El
`Dockerfile` de este repositorio declara `ARG` **únicamente** para los
cuatro `NEXT_PUBLIC_*`, y esa omisión es la defensa: un constructor no
puede entregar a una instrucción de build un argumento que el
`Dockerfile` nunca declaró.

`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY` y `META_APP_SECRET` se leen
en tiempo de ejecución y **no deben aparecer en Build-time Arguments**.
Agregar un `ARG` para cualquiera de ellos anularía la protección sin
ningún aviso.

### Create Environment File

Ese interruptor, activado por omisión, escribe un `.env` con todas las
variables junto al `Dockerfile` durante el build. Aquí no hace falta —
los públicos llegan por build args y los secretos por el entorno del
contenedor— y conviene **apagarlo** para no dejar un archivo con
secretos en el contexto de build.

Si se deja encendido tampoco es una fuga: el `.dockerignore` de este
repositorio excluye `.env*`, así que ese archivo nunca entra al contexto
y el `COPY . .` del stage `builder` no lo ve. Vale la pena saberlo antes
de tocar esa línea del `.dockerignore`, porque es lo único que separa
ambos casos.

## Aplicación 2 — el agente Claudia

> **Atención: el agente NO se despliega desde `wacrm/agente`.**
>
> Este repositorio contiene una copia del agente bajo `agente/`, traída
> en el commit `9b28219`, pero **quedó congelada el 2026-09-08**. La
> fuente de verdad es el repositorio aparte
> `odsmsystem-netizen/whatsapp-agentkit`, que siguió recibiendo trabajo
> —entre otros el commit `4c9717c`, *«que un reinicio no haga contestar
> de nuevo lo ya contestado»*, que suma 78 líneas a `sondeo_wacrm.py`
> (434 líneas en la copia de wacrm contra 580 en el repo aparte).
>
> Construir desde `wacrm/agente` haría retroceder al agente y devolvería
> ese fallo —un cliente recibiendo dos veces la misma respuesta tras cada
> redespliegue— a producción. Mientras las dos copias no se unifiquen,
> el agente se despliega desde `whatsapp-agentkit`.

- **Repositorio:** `odsmsystem-netizen/whatsapp-agentkit`
- **Rama:** `main`
- **Docker Context Path:** `.`
- **Dockerfile Path:** `Dockerfile`
- **Dominio:** `claudia.ambar-apps.cloud`, **Container Port `8000`**, HTTPS activado

Recuerda que **un push a `main` de ese repositorio es un despliegue a
producción**: el panel baja el código y levanta el contenedor nuevo sin
pedir nada más. Empujar ahí exige la misma cautela que desplegar.

El agente no necesita Build Time Arguments: Python no incrusta nada en
tiempo de compilación, todas sus variables se leen en ejecución.

### Variables

Las de su `.env.example` (NetSuite, Twilio, Anthropic, admin), más estas
que cambian respecto al entorno local:

```dotenv
WACRM_URL=http://<nombre-del-servicio-crm>:3000
PUBLIC_BASE_URL=https://claudia.ambar-apps.cloud
TZ=America/Mexico_City
HEALTH_TUNEL_ENABLED=false
```

`WACRM_URL` usa la red interna de Dokploy (`dokploy-network`, a la que se
conectan todos los servicios para que Traefik pueda enrutarlos), así que
el agente habla con el CRM **sin salir a internet**: no depende del DNS
público ni de que el certificado resuelva. Es el mismo razonamiento que
ya aplica el `docker-compose.yml` local con `http://app:3000`.

### Los datos que no están en el repositorio

Esto es lo que hay que hacer a mano y nadie avisa si falta. El agente
guarda su estado en SQLite, y esos archivos **están excluidos del
repositorio a propósito** (llevan datos de clientes y el repo es
público):

| Archivo | Qué contiene | Si falta |
| --- | --- | --- |
| `netsuite_sync.db` | ~2.5 MB de catálogo de productos | El agente arranca bien y **falla cuando un cliente pregunta un precio** |
| `agentkit.db` | Memoria de conversaciones | Claudia pierde el hilo de cada charla |
| `config/` | Configuración viva editable | Vuelve a valores por omisión |
| `knowledge/` | Base de conocimiento | Responde sin contexto de negocio |

El modo de fallo es cruel: el contenedor queda **healthy** y el error solo
aparece frente a un cliente real.

#### Un volumen de directorio, no de archivos

En *Advanced → Volumes* crea **un** volumen (`Volume Mount`) llamado
`claudia-data` montado en **`/app/data`**, y manda las dos bases ahí por
variable de entorno:

```dotenv
NETSUITE_DB_PATH=/app/data/netsuite_sync.db
DATABASE_URL=sqlite+aiosqlite:////app/data/agentkit.db
```

Cuatro barras en `DATABASE_URL`: tres son el separador del esquema y la
cuarta es la raíz. Con tres, SQLAlchemy lee la ruta como relativa y la
base acaba dentro de la imagen, donde se pierde en cada despliegue.

Montar los archivos uno a uno —`/app/netsuite_sync.db` y compañía— parece
más directo y es justo lo que no hay que hacer: si el archivo todavía no
existe en el host, Docker crea un **directorio** con ese nombre, y SQLite
falla con un error que no menciona el montaje por ningún lado.

#### El catálogo se regenera, no se copia

No hace falta subir los 2.5 MB por `scp` (ni tener acceso SSH). El agente
sabe reconstruirlo desde NetSuite con las credenciales que ya tiene en su
entorno. Crea un Schedule —sirve como sincronización diaria de todos
modos— y ejecútalo una vez a mano tras el primer despliegue:

| Campo | Valor |
| --- | --- |
| Cron | `0 7 * * *` |
| Timezone | `America/Mexico_City` |
| Shell | `bash` |
| Command | `python scripts/sync_diario.py` |

Tarda unos diez segundos y deja constancia en su log: `Catálogo
sincronizado: 3161 artículos`, `Clientes sincronizados: 8985`. El botón de
ejecución manual es el **segundo** de la fila de iconos de la tarea; el
primero abre el historial.

`agentkit.db` sí empieza vacío: se pierde la memoria de conversaciones
anteriores, no el catálogo. `config/` y `knowledge/` vienen del propio
repositorio, así que no necesitan volumen.

#### Orden de arranque

Despliega con **`SONDEO_WACRM_ENABLED=false`**, sincroniza, comprueba que
el agente responde, y solo entonces enciende el sondeo y reinicia. Si lo
levantas con el sondeo activo, Claudia empieza a atender conversaciones
antes de tener catálogo — y como no falla al arrancar sino al cotizar, el
primero en notarlo sería un cliente.

### `health_tunel.py` ya no aplica

El agente trae un mecanismo que **reescribe `PUBLIC_BASE_URL` dentro de su
propio `.env`** cuando detecta que la URL del túnel cambió. Existía porque
esa URL era la de un túnel efímero.

En el VPS el dominio es fijo, así que ese camino sobra — y además es
dañino: en Dokploy las variables vienen del panel, de modo que escribir el
`.env` del contenedor no tiene efecto sobre el proceso ni sobrevive a un
redespliegue. De ahí `HEALTH_TUNEL_ENABLED=false`.

## Después del primer despliegue

1. **Migraciones de Supabase.** El contenedor no las corre. Aplica los
   archivos de `supabase/` con la CLI, como describe el README. Si el CRM
   ya venía funcionando contra este mismo proyecto de Supabase, ya están
   aplicadas: no hay nada que hacer.
2. **Webhook de Meta** → `https://crm.ambar-apps.cloud/api/whatsapp/webhook`.
3. **Webhook de Twilio** (el agente) → `https://claudia.ambar-apps.cloud/webhook`.
4. **Supabase → Authentication → URL Configuration:** agrega
   `https://crm.ambar-apps.cloud` como *Site URL* y en *Redirect URLs*. Sin esto los
   correos de confirmación e invitación apuntan al dominio viejo.
5. **Cron.** Programa `GET /api/automations/cron` y `GET /api/flows/cron`
   con la cabecera `x-cron-secret: <AUTOMATION_CRON_SECRET>`. Ambos
   devuelven 503 mientras esa variable no exista. Dokploy trae
   *Schedules*, así que no hace falta un pinger externo.

## Reconstruir o reiniciar

| Cambio | Qué se necesita |
| --- | --- |
| Cualquier valor `NEXT_PUBLIC_*` | **Redeploy** (reconstrucción completa) |
| Todo lo demás en el CRM | Reiniciar el servicio |
| Cualquier variable del agente | Reiniciar el servicio |

Los `NEXT_PUBLIC_*` se incrustan en el JavaScript durante el build:
editarlos en el panel y reiniciar no cambia absolutamente nada. Incluye a
`NEXT_PUBLIC_APP_LOCALE`, que sorprende porque `src/i18n/request.ts` lo lee
en el *servidor* — pero el prefijo `NEXT_PUBLIC_` hace que Next lo incruste
igual. Cambiar de idioma exige reconstruir.

## Diferencias con Easypanel

| | Easypanel | Dokploy |
| --- | --- | --- |
| Variables al build | Todas, automáticamente | Solo las de *Build Time Arguments* |
| Programador de tareas | No tiene (cron del host) | *Schedules* integrado |
| Red entre servicios | Red del proyecto | `dokploy-network` |
| Dominio | Domains + target port | Domains + container port |

## Problemas frecuentes

**El build se detiene nombrando una variable.** Falta en *Build Time
Arguments*, no en Environment. Son campos distintos.

**La app carga pero el inicio de sesión falla, o la consola del navegador
muestra errores de Supabase.** La imagen se construyó sin las variables de
Supabase, así que el bundle del cliente lleva cadenas vacías. Reiniciar no
lo arregla: hay que reconstruir.

**502 / bad gateway.** El container port no es `3000` (CRM) u `8000`
(agente), o una variable `PORT` suelta movió el listener.

**El contenedor del agente reinicia en bucle nada más desplegar.** Mira
sus *Logs*: si dice `ModuleNotFoundError: No module named 'greenlet'`, le
falta esa librería. `DATABASE_URL` usa `sqlite+aiosqlite`, que entra por
el motor asíncrono de SQLAlchemy, y SQLAlchemy 2.x dejó de instalar
greenlet como dependencia obligatoria. Se arregla pidiendo el extra en
`requirements.txt`:

```
sqlalchemy[asyncio]>=2.0.0,<3.0.0
```

El síntoma en el panel confunde: el estado alterna entre `created` y
`running` con "Up Less than a second" y el ID del contenedor cambia en
cada vistazo. Eso es Swarm reintentando, no un arranque lento.

**El agente responde pero no cotiza precios.** Falta `netsuite_sync.db` en
el volumen. El contenedor se ve sano porque el catálogo solo se consulta
cuando alguien pregunta.

**Los correos de Supabase llevan al dominio anterior.** Falta actualizar
*URL Configuration* en Supabase (paso 4).
