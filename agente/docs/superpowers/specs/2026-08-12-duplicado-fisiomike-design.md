# Duplicado de whatsapp-agentkit → Whatsapp-fisiomike

Fecha: 2026-08-12
Estado: aprobado, pendiente de plan de implementación

## Objetivo

Crear `C:\Users\odaniel\Whatsapp-fisiomike`, un proyecto independiente derivado de
`whatsapp-agentkit`, que conserve el motor del agente de WhatsApp y descarte todo
lo específico de Ambar Cargo: la integración con NetSuite, el catálogo de
artículos, las escalas de precio, el carrito de pedidos y el escalamiento a
vendedores.

El proyecto nuevo atiende a **otro negocio** (Fisiomike) y responde **solo con
archivos de conocimiento** — no consulta ningún sistema externo de datos vivos.

## Decisiones tomadas

| Decisión | Elección |
|---|---|
| Negocio destino | Otro negocio, distinto de Ambar Cargo |
| Alcance de la copia | Copia completa + limpieza quirúrgica |
| Ubicación y git | Carpeta hermana `C:\Users\odaniel\Whatsapp-fisiomike`, `git init` limpio, sin historial ni remotes heredados |
| Fuente de datos | Solo `/knowledge` — sin capa de datos externos |
| Panel de administración | Panel base, sin las pestañas de Ambar |

## Inventario: qué se copia, qué se opera, qué se elimina

### Se copia intacto

- `agent/main.py` — se le quitan los imports de `programador` y de las funciones de
  vendedores de `tools.py`, la llamada a `programar_sync_diario()` en el `lifespan`,
  y la ruta `GET /transcripts/{archivo}` (existía solo para adjuntar la
  transcripción al aviso del vendedor)
- `agent/providers/` — `base.py`, `twilio.py`, `__init__.py`
- `agent/health_tunel.py` — vigilante del túnel de Cloudflare, apagado por bandera
- `bin/cloudflared.exe`
- `scripts/respaldo.py`
- Infraestructura: `Dockerfile`, `docker-compose.yml`, `railway.toml`, `.gitignore`,
  `.githooks/pre-commit`, `start.sh`, `requirements.txt`, `requirements-dev.txt`,
  `.python-version`, `LICENSE`
- `CLAUDE.md` — es el template genérico de AgentKit, sirve tal cual

### Se copia y se opera

| Archivo | Líneas hoy | Objetivo | Qué se le quita |
|---|---|---|---|
| `agent/tools.py` | 1,164 | ~250 | catálogo, escalas de precio, abreviaturas, carrito, vendedores, oportunidades NetSuite |
| `agent/admin.py` | 955 | ~600 | endpoints `/api/indicadores`, `/api/indicadores/estrategicos`, `/api/sync`, `/api/sync/estado`, `/api/catalogo`, `/api/clientes`, `/api/vendedores*` |
| `agent/memory.py` | 717 | ~450 | tablas `carrito`, `clientes`, `notificaciones_vendedor`, `vendedores` y sus funciones |
| `agent/brain.py` | 359 | ~200 | 8 de las 16 definiciones de herramientas |
| `requirements.txt` | — | — | `requests` y `requests-oauthlib`, declaradas solo para NetSuite |
| `agent/static_admin/app.js` + `index.html` | 966 | ~600 | pestañas de catálogo, clientes, vendedores, indicadores y sync |
| `scripts/respaldo.py` | — | — | la entrada `netsuite_sync.db` de su lista de archivos y sus menciones en docstrings |
| `tests/test_dependencias.py` | — | — | la referencia a `agent/netsuite_client.py` en un ejemplo del docstring |
| `tests/test_respaldo.py` | — | — | las expectativas sobre `netsuite_sync.db` |

**Herramientas que sobreviven (8):** `obtener_horario`, `buscar_en_knowledge`,
`agendar_cita`, `ver_mis_citas`, `cancelar_cita`, `registrar_interes_venta`,
`crear_ticket_soporte`, `consultar_tickets_soporte`.

`registrar_interes_venta` conserva su firma pero **se reescribe el cuerpo**: hoy
sortea un vendedor, guarda una transcripción y le manda un WhatsApp. Queda
únicamente guardando el lead.

**Herramientas que se eliminan (8):** `consultar_catalogo`, `agregar_al_pedido`,
`ver_pedido_actual`, `confirmar_pedido`, `verificar_cliente_existente`,
`notificar_vendedor_cliente_existente`, `registrar_datos_cliente`,
`generar_oportunidad`.

**Tablas que sobreviven en `memory.py`:** `mensajes`, `citas`, `leads`,
`usuarios_admin`, `tickets`, `propuestas_aprendizaje`, `notas_claude_code`,
`eventos_tunel`.

### Se elimina por completo

- `agent/netsuite_client.py`
- `agent/programador.py` — su única razón de existir es el sync diario de NetSuite
- `scripts/sync_netsuite_catalogo.py`, `scripts/sync_netsuite_clientes.py`,
  `scripts/sync_diario.py`, `scripts/sync_diario.bat`, `scripts/db.py`,
  `scripts/credenciales.py`, `scripts/config.ini`, `scripts/config.ini.example`
- `config/clientes_escala.yaml`, `config/vendedores_whatsapp.yaml`
- Tests: `test_abreviaturas.py`, `test_aviso_vendedor.py`, `test_busqueda_flexible.py`,
  `test_catalogo.py`, `test_credenciales.py`, `test_programador.py`,
  `test_sync_diario.py`, `test_vendedores.py`

Quedan 5 tests de 13: `test_local.py`, `test_dependencias.py`,
`test_health_tunel.py`, `test_borrar_conversacion.py`, `test_respaldo.py`.

### No se copia — datos y secretos de Ambar Cargo

Esta sección no es una preferencia de limpieza: es la línea que separa un
proyecto nuevo de una fuga de datos de clientes reales.

- `agentkit.db` (163 KB) — conversaciones reales de clientes de Ambar
- `netsuite_sync.db` (2.5 MB) — 3,156 artículos y 8,772 clientes de Ambar
- `transcripts/` — transcripciones de conversaciones reales
- `respaldos/`, `simulaciones/`, `logs/`, `.pytest_cache/`, `__pycache__/`
- `.env` — claves de producción: Anthropic, Twilio, NetSuite, contraseña del panel
- Los remotes de git: `origin` (repo de Claudia) y `upstream` (template)

### Documentación

`APRENDIZAJE_CONOCIMIENTO.md` (36 KB) se copia **filtrado**: solo las lecciones
técnicas transversales (el incidente de `pandas`, el contenedor corriendo en UTC,
el comportamiento del auto-deploy de Railway, el sandbox que bloquea la
plantilla). Se descarta la historia específica de Ambar, el catálogo y los
vendedores. El propósito es que el proyecto nuevo no repita tropiezos ya pagados.

## Configuración resultante

`config/business.yaml` y `config/prompts.yaml` quedan como **plantilla vacía**.
El perfil de Fisiomike no se inventa en este trabajo: al terminar el duplicado,
la Fase 2 de AgentKit hace la entrevista de 10 preguntas y genera ambos archivos
a partir de las respuestas del usuario.

`.env.example` baja de 25 variables a 15:

```
ANTHROPIC_API_KEY
WHATSAPP_PROVIDER
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_PHONE_NUMBER
PUBLIC_BASE_URL
ADMIN_PASSWORD
ADMIN_SECRET_KEY
PORT
ENVIRONMENT
LOG_LEVEL
DATABASE_URL
HEALTH_TUNEL_ENABLED
HEALTH_TUNEL_INTERVALO
HEALTH_TUNEL_ALERTA_WHATSAPP
```

Se van las 6 variables `NETSUITE_*`, `NETSUITE_DB_PATH`, las 2 de
`SYNC_PROGRAMADO_*` y `TWILIO_CONTENT_SID_AVISO_VENDEDOR`.

El `.env` real nace de esta plantilla con los valores en blanco. El usuario los
llena durante la Fase 1 y 2 de AgentKit.

## Qué funciona el día uno

Sin escribir una línea de código adicional:

- Webhook de WhatsApp por Twilio (entrada y salida)
- Memoria de conversaciones por número de teléfono
- Panel de administración con login y gestión de usuarios
- Editor del system prompt desde el panel
- Carga y borrado de archivos de knowledge
- Borrado de conversaciones
- Respaldos de configuración y datos
- Agendado, consulta y cancelación de citas
- Chat de prueba en terminal (`python tests/test_local.py`)

## Riesgo: el auto-deploy de Railway

El repo `whatsapp-agentkit` despliega automáticamente a producción con cada push
a `main`. Por eso el proyecto nuevo nace con `git init` limpio y **sin ningún
remote configurado**. No se le asigna repositorio hasta que el usuario indique a
cuál va. Así no existe forma de empujar Fisiomike al Railway de Claudia.

Este documento de diseño se commitea en `whatsapp-agentkit` pero **no se
empuja**, para no disparar un redespliegue de producción por un cambio de
documentación.

## Verificación

El trabajo no se declara terminado sin esta evidencia, ejecutada dentro de
`C:\Users\odaniel\Whatsapp-fisiomike`:

1. `pytest` — los 5 tests en verde
2. `python -c "import agent.main"` — sin ImportError
3. `uvicorn agent.main:app --port 8000` arranca y `GET /` responde `{"status":"ok"}`
4. El panel abre en `/admin` y acepta login
5. `grep -ri "netsuite\|ambar\|vendedor\|catalogo" --include=*.py --include=*.js --include=*.yaml --include=*.html .` regresa vacío
6. `git remote -v` regresa vacío
7. No existen `agentkit.db`, `netsuite_sync.db`, `transcripts/` ni `.env` con secretos de Ambar

## Fuera de alcance

- Definir el perfil del agente de Fisiomike (lo hace la entrevista de Fase 2)
- Configurar Twilio, credenciales o número de WhatsApp para el proyecto nuevo
- Crear el repositorio de GitHub o el proyecto de Railway
- Cualquier cambio al proyecto `whatsapp-agentkit`, salvo este documento
