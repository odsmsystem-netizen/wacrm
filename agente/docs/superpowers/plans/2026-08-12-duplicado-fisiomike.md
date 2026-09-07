# Duplicado Whatsapp-fisiomike — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crear `C:\Users\odaniel\Whatsapp-fisiomike` como proyecto independiente derivado de `whatsapp-agentkit`, conservando el motor del agente de WhatsApp y eliminando toda la lógica de NetSuite, catálogo, escalas de precio, carrito de pedidos y vendedores.

**Architecture:** Se exporta el árbol rastreado con `git archive HEAD` (que por construcción excluye secretos y datos de clientes, porque ninguno está versionado), se hace `git init` limpio sin remotes, y luego se opera archivo por archivo de afuera hacia adentro — `main.py` → `brain.py` → `tools.py` → `admin.py` → `memory.py` → panel — de modo que el árbol quede importable después de cada commit. Los módulos huérfanos se borran al final, cuando ya nadie los referencia.

**Tech Stack:** Python 3.11+, FastAPI, Uvicorn, SQLAlchemy async + aiosqlite, Anthropic SDK, Twilio, pytest.

## Global Constraints

- **Directorio de trabajo:** todas las tareas de la 2 en adelante se ejecutan dentro de `C:\Users\odaniel\Whatsapp-fisiomike`. Nunca se modifica `C:\Users\odaniel\whatsapp-agentkit`.
- **Sin remotes:** el repo nuevo no lleva `git remote` de ningún tipo hasta que el usuario lo indique. `git push` está prohibido en todo el plan.
- **Cero rastro de Ambar en código:** al terminar, `grep -ri` de `netsuite|ambar|vendedor|catalogo|carrito|escala` sobre `*.py`, `*.js`, `*.yaml` y `*.html` debe regresar vacío.
- **Idioma:** todo comentario, docstring y mensaje de commit va en español, siguiendo el estilo del repo original (mensajes de commit que describen el síntoma, no el cambio).
- **El perfil del negocio NO se inventa:** `config/business.yaml` y `config/prompts.yaml` quedan como plantilla vacía. Fisiomike se define después, con la entrevista de Fase 2 de AgentKit.
- **Shell:** los comandos van en Git Bash (herramienta Bash), no PowerShell, salvo donde se indique.

---

### Task 1: Crear el proyecto nuevo con git limpio

**Files:**
- Create: `C:\Users\odaniel\Whatsapp-fisiomike\` (árbol completo exportado)
- Test: verificación por comandos (no hay pytest todavía porque el árbol aún no es coherente)

**Interfaces:**
- Consumes: nada
- Produces: el directorio `C:\Users\odaniel\Whatsapp-fisiomike` con el árbol rastreado de `whatsapp-agentkit` en su commit actual, un repo git inicializado sin remotes, y un commit inicial.

- [ ] **Step 1: Exportar el árbol rastreado**

`git archive` exporta solo lo versionado. Como `.env`, `agentkit.db`, `netsuite_sync.db`, `transcripts/`, `respaldos/` y `simulaciones/` están en `.gitignore`, quedan fuera por construcción — no hace falta una lista de exclusiones que se pueda escapar.

```bash
mkdir -p /c/Users/odaniel/Whatsapp-fisiomike
cd /c/Users/odaniel/whatsapp-agentkit
git archive HEAD | tar -x -C /c/Users/odaniel/Whatsapp-fisiomike
```

- [ ] **Step 2: Verificar que no viajó nada sensible**

```bash
cd /c/Users/odaniel/Whatsapp-fisiomike
ls -la
find . -name "*.db" -o -name ".env" -o -type d -name transcripts -o -type d -name respaldos
```

Esperado: el `find` no imprime NADA. Si aparece cualquier `.db` o `.env`, **detenerse** y borrarlo antes de seguir — son datos de clientes reales de Ambar.

- [ ] **Step 3: Copiar el binario del túnel**

`bin/cloudflared.exe` no está versionado (es un binario), pero `health_tunel.py` lo necesita para el túnel local. Es una herramienta, no un dato — es seguro copiarla.

```bash
mkdir -p /c/Users/odaniel/Whatsapp-fisiomike/bin
cp /c/Users/odaniel/whatsapp-agentkit/bin/cloudflared.exe /c/Users/odaniel/Whatsapp-fisiomike/bin/
```

- [ ] **Step 4: Inicializar git sin remotes**

```bash
cd /c/Users/odaniel/Whatsapp-fisiomike
git init
git add -A
git commit -m "chore: punto de partida, copiado de whatsapp-agentkit

Arbol exportado con git archive para que no viajen las bases de datos,
las transcripciones ni el .env de Ambar Cargo. Todavia trae el codigo de
NetSuite y vendedores; se amputa en los commits siguientes."
```

- [ ] **Step 5: Verificar que no hay remotes**

```bash
git remote -v
```

Esperado: salida vacía. Si aparece cualquier remote, ejecutar `git remote remove <nombre>`.

- [ ] **Step 6: Crear el .env de trabajo**

```bash
cp .env.example .env
```

El `.env` queda con los valores de ejemplo (vacíos). Se llena en la Fase 1/2 de AgentKit, fuera de este plan.

---

### Task 2: Limpiar `agent/main.py`

**Files:**
- Modify: `agent/main.py`
- Test: `tests/test_main_limpio.py` (crear)

**Interfaces:**
- Consumes: nada de tareas previas
- Produces: `agent.main.app` sin la ruta `/transcripts/{archivo}`, sin `programar_sync_diario()` en el `lifespan` y sin sembrado de vendedores. Las rutas que quedan: `GET /`, `GET /webhook`, `POST /webhook`, más las de `admin_router`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_main_limpio.py`:

```python
# tests/test_main_limpio.py — El servidor no expone rutas de Ambar
"""
main.py servia /transcripts/{archivo} solo para que Twilio pudiera adjuntar
la transcripcion al aviso del vendedor. Sin vendedores, esa ruta es una
fuga de conversaciones esperando a que alguien adivine un nombre de archivo.
"""

import ast
import os

MAIN_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "agent", "main.py")


def _fuente_main() -> str:
    with open(MAIN_PATH, "r", encoding="utf-8") as f:
        return f.read()


def test_no_importa_modulos_de_netsuite():
    fuente = _fuente_main()
    assert "programador" not in fuente
    assert "vendedor" not in fuente.lower()


def test_no_expone_la_ruta_de_transcripciones():
    fuente = _fuente_main()
    assert "/transcripts/" not in fuente
    assert "TRANSCRIPTS_DIR" not in fuente


def test_main_sigue_siendo_python_valido():
    ast.parse(_fuente_main())
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
cd /c/Users/odaniel/Whatsapp-fisiomike
python -m pytest tests/test_main_limpio.py -v
```

Esperado: FALLAN `test_no_importa_modulos_de_netsuite` y `test_no_expone_la_ruta_de_transcripciones`.

- [ ] **Step 3: Quitar los imports muertos**

En `agent/main.py`, reemplazar el bloque de imports (líneas 17–24):

```python
from agent.brain import generar_respuesta
from agent.memory import (inicializar_db, guardar_mensaje, obtener_historial,
                          migrar_vendedores)
from agent.tools import leer_vendedores_semilla, refrescar_cache_vendedores
from agent.providers import obtener_proveedor
from agent.admin import router as admin_router, sembrar_usuario_inicial
from agent.health_tunel import vigilar_tunel
from agent.programador import programar_sync_diario
```

por:

```python
from agent.brain import generar_respuesta
from agent.memory import inicializar_db, guardar_mensaje, obtener_historial
from agent.providers import obtener_proveedor
from agent.admin import router as admin_router, sembrar_usuario_inicial
from agent.health_tunel import vigilar_tunel
```

También quitar `FileResponse` de la línea 14 (solo lo usaba la ruta de transcripciones):

```python
from fastapi.responses import PlainTextResponse
```

- [ ] **Step 4: Quitar el bloque TRANSCRIPTS_DIR**

Borrar completo el bloque de las líneas 43–47 (el comentario de 3 líneas más `TRANSCRIPTS_DIR = ...` y `os.makedirs(...)`).

- [ ] **Step 5: Simplificar el `lifespan`**

Reemplazar el cuerpo del `lifespan` (líneas 50–87) por:

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Inicializa la base de datos y arranca el vigilante del túnel."""
    await inicializar_db()
    await sembrar_usuario_inicial()
    logger.info("Base de datos inicializada")
    logger.info(f"Servidor AgentKit corriendo en puerto {PORT}")
    logger.info(f"Proveedor de WhatsApp: {proveedor.__class__.__name__}")

    # Tareas de fondo. Trae su propio interruptor en .env:
    #   HEALTH_TUNEL_ENABLED — vigilante del túnel (solo aplica en local)
    tareas_fondo = [
        asyncio.create_task(vigilar_tunel()),
    ]

    yield

    # Apagado limpio: cancelar todas para que no queden colgadas
    for tarea in tareas_fondo:
        tarea.cancel()
    for tarea in tareas_fondo:
        try:
            await tarea
        except asyncio.CancelledError:
            pass
```

- [ ] **Step 6: Cambiar el título de la app**

Línea 91: reemplazar `title="AgentKit — WhatsApp AI Agent (Ambar Cargo)"` por `title="AgentKit — WhatsApp AI Agent"`.

- [ ] **Step 7: Borrar la ruta de transcripciones**

Borrar completo el decorador y la función `descargar_transcripcion` (líneas 114–127), incluyendo su docstring.

- [ ] **Step 8: Correr el test**

```bash
python -m pytest tests/test_main_limpio.py -v
```

Esperado: los 3 tests PASAN.

- [ ] **Step 9: Commit**

```bash
git add agent/main.py tests/test_main_limpio.py
git commit -m "fix: el servidor servia transcripciones de clientes por HTTP

La ruta /transcripts/{archivo} existia solo para que Twilio adjuntara la
conversacion al aviso del vendedor. Sin vendedores no tiene consumidor, y
deja conversaciones accesibles a quien adivine un nombre de archivo."
```

---

### Task 3: Recortar el registro de herramientas en `agent/brain.py`

**Files:**
- Modify: `agent/brain.py`
- Test: `tests/test_herramientas.py` (crear)

**Interfaces:**
- Consumes: nada
- Produces: `agent.brain._FUNCIONES` con exactamente 8 llaves: `obtener_horario`, `buscar_en_knowledge`, `agendar_cita`, `ver_mis_citas`, `cancelar_cita`, `registrar_interes_venta`, `crear_ticket_soporte`, `consultar_tickets_soporte`. La lista `HERRAMIENTAS` (los esquemas que se le mandan a la API) tiene esas mismas 8 entradas, y `_REQUIERE_TELEFONO` solo nombra herramientas que existen.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_herramientas.py`:

```python
# tests/test_herramientas.py — El cerebro solo ofrece herramientas que existen
"""
brain.py declara tres cosas que tienen que coincidir entre si: los esquemas
que se le mandan a la API (HERRAMIENTAS), el mapa nombre->funcion (_FUNCIONES)
y el conjunto que necesita el telefono inyectado (_REQUIERE_TELEFONO). Si se
borra una herramienta de una lista y no de las otras, el agente promete algo
que truena en tiempo de ejecucion, delante del cliente.
"""

from agent import brain

ESPERADAS = {
    "obtener_horario",
    "buscar_en_knowledge",
    "agendar_cita",
    "ver_mis_citas",
    "cancelar_cita",
    "registrar_interes_venta",
    "crear_ticket_soporte",
    "consultar_tickets_soporte",
}


def test_las_funciones_registradas_son_las_esperadas():
    assert set(brain._FUNCIONES.keys()) == ESPERADAS


def test_los_esquemas_coinciden_con_las_funciones():
    nombres_esquema = {h["name"] for h in brain.HERRAMIENTAS}
    assert nombres_esquema == ESPERADAS


def test_requiere_telefono_no_nombra_fantasmas():
    assert brain._REQUIERE_TELEFONO <= ESPERADAS


def test_toda_funcion_registrada_es_invocable():
    for nombre, fn in brain._FUNCIONES.items():
        assert callable(fn), f"{nombre} no es invocable"
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
python -m pytest tests/test_herramientas.py -v
```

Esperado: FALLAN los primeros tres (hoy hay 16 funciones, no 8).

- [ ] **Step 3: Borrar los esquemas de las 8 herramientas amputadas**

En la lista `HERRAMIENTAS` de `agent/brain.py`, borrar las entradas completas (desde su `{` hasta su `},`) cuyo `"name"` sea uno de estos:

```
consultar_catalogo
agregar_al_pedido
ver_pedido_actual
confirmar_pedido
verificar_cliente_existente
notificar_vendedor_cliente_existente
registrar_datos_cliente
generar_oportunidad
```

- [ ] **Step 4: Reescribir `_REQUIERE_TELEFONO`**

Reemplazar el conjunto completo por:

```python
# Herramientas que necesitan el teléfono del cliente inyectado automáticamente
_REQUIERE_TELEFONO = {
    "agendar_cita", "ver_mis_citas", "cancelar_cita", "registrar_interes_venta",
    "crear_ticket_soporte", "consultar_tickets_soporte",
}
```

- [ ] **Step 5: Reescribir `_FUNCIONES`**

Reemplazar el diccionario completo por:

```python
_FUNCIONES = {
    "obtener_horario": biz_tools.obtener_horario,
    "buscar_en_knowledge": biz_tools.buscar_en_knowledge,
    "agendar_cita": biz_tools.agendar_cita,
    "ver_mis_citas": biz_tools.ver_mis_citas,
    "cancelar_cita": biz_tools.cancelar_cita,
    "registrar_interes_venta": biz_tools.registrar_interes_venta,
    "crear_ticket_soporte": biz_tools.crear_ticket_soporte,
    "consultar_tickets_soporte": biz_tools.consultar_tickets_soporte,
}
```

- [ ] **Step 6: Revisar el resto del archivo**

```bash
grep -n "netsuite\|catalogo\|vendedor\|carrito\|pedido\|cotiza\|Ambar" agent/brain.py
```

Cualquier línea que salga (comentarios, docstrings, descripciones residuales) se reescribe en términos genéricos. Esperado al final: salida vacía.

- [ ] **Step 7: Correr el test**

```bash
python -m pytest tests/test_herramientas.py -v
```

Esperado: los 4 tests PASAN.

- [ ] **Step 8: Commit**

```bash
git add agent/brain.py tests/test_herramientas.py
git commit -m "fix: el agente ofrecia herramientas de un negocio que no es el suyo

Le quedaban las 8 herramientas de catalogo, pedidos y vendedores de Ambar.
Un test nuevo amarra los tres registros de brain.py entre si, para que
borrar una herramienta de una lista y no de las otras deje de compilar."
```

---

### Task 4: Cirugía de `agent/tools.py`

**Files:**
- Modify: `agent/tools.py` (de 1,164 líneas a ~250)
- Test: `tests/test_herramientas.py` (extender), `tests/test_tools_limpio.py` (crear)

**Interfaces:**
- Consumes: `agent.brain._FUNCIONES` de la Task 3 — las 8 funciones que quedan tienen que seguir existiendo con la misma firma.
- Produces: `agent/tools.py` sin `import netsuite_client`, sin `import db as ns_db`, sin `sys.path.insert`. Firmas que se conservan tal cual:
  - `cargar_info_negocio() -> dict`
  - `obtener_horario() -> dict`
  - `buscar_en_knowledge(consulta: str) -> str`
  - `agendar_cita(telefono, servicio, fecha, hora, nombre_cliente="", direccion="") -> dict`
  - `ver_mis_citas(telefono) -> dict`
  - `cancelar_cita(telefono, cita_id) -> dict`
  - `crear_ticket_soporte(telefono, problema) -> dict`
  - `consultar_tickets_soporte(telefono) -> dict`
  - `registrar_interes_venta(telefono, interes, nombre="", empresa="") -> dict` — **firma igual, cuerpo reescrito**: ahora solo guarda el lead y regresa `{"ok": True, "lead_id": int}`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_tools_limpio.py`:

```python
# tests/test_tools_limpio.py — tools.py ya no depende de NetSuite
"""
tools.py hacia sys.path.insert("scripts") para importar el motor SQLite del
catalogo sincronizado. Ese motor no existe en este proyecto: si el import
sobrevive, el agente entero no arranca.
"""

import ast
import os

TOOLS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "agent", "tools.py")


def _fuente_tools() -> str:
    with open(TOOLS_PATH, "r", encoding="utf-8") as f:
        return f.read()


def test_no_importa_netsuite_ni_el_motor_del_catalogo():
    fuente = _fuente_tools()
    assert "netsuite_client" not in fuente
    assert "ns_db" not in fuente
    assert "sys.path.insert" not in fuente


def test_no_quedan_rastros_del_negocio_anterior():
    fuente = _fuente_tools().lower()
    for palabra in ("catalogo", "vendedor", "carrito", "escala", "ambar", "netsuite"):
        assert palabra not in fuente, f"quedo '{palabra}' en tools.py"


def test_tools_sigue_siendo_python_valido():
    ast.parse(_fuente_tools())
```

Y agregar a `tests/test_herramientas.py`:

```python
def test_registrar_interes_venta_solo_guarda_el_lead():
    """Ya no sortea vendedor ni manda WhatsApp: solo deja el lead anotado."""
    import inspect
    from agent import tools
    fuente = inspect.getsource(tools.registrar_interes_venta)
    assert "_sortear_vendedor" not in fuente
    assert "_notificar_vendedor" not in fuente
    assert "registrar_notificacion_vendedor" not in fuente
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

```bash
python -m pytest tests/test_tools_limpio.py tests/test_herramientas.py -v
```

Esperado: FALLAN los 3 de `test_tools_limpio.py` y el nuevo de `test_herramientas.py`.

- [ ] **Step 3: Reescribir el encabezado de `tools.py`**

Reemplazar todo desde la línea 1 hasta la línea 43 (el bloque que termina con `RANGOS_METRO`) por:

```python
# agent/tools.py — Herramientas del agente
# Generado por AgentKit

"""
Herramientas del negocio. Cada función aquí puede ser invocada por Claude
durante la conversación (ver agent/brain.py, que define los esquemas de
estas herramientas para el tool-use de la API).
"""

import os
import yaml
import logging

from agent import memory

logger = logging.getLogger("agentkit")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
```

- [ ] **Step 4: Borrar todo el bloque de catálogo**

Borrar desde `def _cargar_excepciones_escala()` hasta el final de `def consultar_catalogo(...)` — es decir, todas estas funciones:

```
_cargar_excepciones_escala      escala_para_cliente         _escala_por_cantidad
_escala_efectiva                _precio_en_escala           _prioridad_disponibilidad
_numeros_enteros_busqueda       _tiene_numero_exacto        _prioridad_busqueda
extraer_raices_abreviadas       nombres_del_catalogo        raices_abreviadas_del_catalogo
invalidar_cache_raices          alternativas_con_raices     _sin_acentos
_normalizar_palabras_busqueda   _es_sacrificable            _selectividad
_alternativas_de                consultar_catalogo
```

Conservar `cargar_info_negocio`, `obtener_horario` y `buscar_en_knowledge`, que están antes de ese bloque.

- [ ] **Step 5: Conservar el bloque de citas tal cual**

Las tres funciones `agendar_cita`, `ver_mis_citas` y `cancelar_cita` se quedan exactamente como están. No tocarlas.

- [ ] **Step 6: Reescribir `registrar_interes_venta`**

Reemplazar la función completa por:

```python
# ── Leads / ventas ──────────────────────────────────────────────────────

async def registrar_interes_venta(telefono: str, interes: str, nombre: str = "", empresa: str = "") -> dict:
    """
    Registra un interés de compra o proyecto para que alguien del equipo le
    dé seguimiento. Úsala cuando el cliente muestre intención de compra
    clara (no aplica a soporte post-venta — para eso usa crear_ticket_soporte).
    """
    lead_id = await memory.registrar_lead(telefono, interes, nombre, empresa)
    return {"ok": True, "lead_id": lead_id}
```

- [ ] **Step 7: Borrar todo el bloque de clientes, vendedores y oportunidades**

Borrar desde `def _vendedor_por_netsuite_id(...)` hasta justo antes del comentario `# ── Soporte post-venta ──`. Son estas funciones:

```
_vendedor_por_netsuite_id        verificar_cliente_existente     registrar_datos_cliente
_datos_cliente_completos         agregar_al_pedido               ver_pedido_actual
confirmar_pedido                 normalizar_vendedor             poblar_cache_vendedores
refrescar_cache_vendedores       leer_vendedores_yaml            leer_vendedores_semilla
_cargar_vendedores               _sortear_vendedor               _notificar_vendedor
_primer_nombre                   _saludo_hora                    _variables_plantilla
_cierre_para_cliente             _lineas_articulos               _url_estimate
_url_opportunity                 _guardar_transcripcion          _media_url_transcripcion
notificar_vendedor_cliente_existente                             generar_oportunidad
```

- [ ] **Step 8: Conservar el bloque de soporte tal cual**

`crear_ticket_soporte` y `consultar_tickets_soporte` se quedan como están. Son las últimas del archivo.

- [ ] **Step 9: Verificar que ya no quedan imports huérfanos**

```bash
grep -nE "^import |^from |random|secrets|json|re\.|datetime" agent/tools.py
```

Si `random`, `secrets`, `json`, `re`, `sys` o `datetime` ya no se usan en el cuerpo, borrar su import. `os`, `yaml`, `logging` y `memory` sí se siguen usando.

- [ ] **Step 10: Correr los tests**

```bash
python -m pytest tests/test_tools_limpio.py tests/test_herramientas.py -v
```

Esperado: TODOS PASAN.

- [ ] **Step 11: Commit**

```bash
git add agent/tools.py tests/test_tools_limpio.py tests/test_herramientas.py
git commit -m "fix: tools.py no arrancaba sin el catalogo sincronizado de Ambar

Hacia sys.path.insert('scripts') para importar el motor SQLite de NetSuite.
Ese motor no existe aqui, asi que el import tumbaba al agente entero antes
de atender el primer mensaje. Se va con catalogo, escalas, carrito,
vendedores y oportunidades: de 1,164 lineas a las 8 herramientas reales."
```

---

### Task 5: Cirugía de `agent/admin.py`

**Files:**
- Modify: `agent/admin.py` (de 955 líneas a ~600)
- Test: `tests/test_admin_limpio.py` (crear)

**Interfaces:**
- Consumes: nada de tareas previas.
- Produces: `agent.admin.router` sin los endpoints de indicadores, sync, catálogo, clientes y vendedores. Los que quedan: `/api/login`, `/api/logout`, `/api/whoami`, `/api/usuarios` (GET/POST), `/api/usuarios/{usuario}/password`, `/api/usuarios/{usuario}` (DELETE), `""` (el HTML), `/app.js`, `/api/config` (GET/POST), `/api/metricas`, `/api/knowledge` (GET), `/api/knowledge/upload`, `/api/knowledge/link`, `/api/knowledge/{nombre}` (DELETE), `/api/conversaciones/{telefono}` (DELETE), `/api/health-tunel`, y los 6 de `/api/aprendizaje/*`. También expone `sembrar_usuario_inicial()`, que `main.py` importa.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_admin_limpio.py`:

```python
# tests/test_admin_limpio.py — El panel no ofrece botones que truenan
"""
El panel heredo endpoints que consultan el catalogo y los vendedores de
NetSuite. Sin esas tablas responden 500. Un boton que truena es peor que
un boton ausente: el dueño del negocio no sabe si fallo el, el panel o el
agente.
"""

from agent.admin import router

RUTAS_PROHIBIDAS = {
    "/admin/api/indicadores",
    "/admin/api/indicadores/estrategicos",
    "/admin/api/sync",
    "/admin/api/sync/estado",
    "/admin/api/catalogo",
    "/admin/api/clientes",
    "/admin/api/vendedores",
}

RUTAS_REQUERIDAS = {
    "/admin/api/login",
    "/admin/api/config",
    "/admin/api/metricas",
    "/admin/api/knowledge",
    "/admin/api/health-tunel",
}


def _rutas() -> set[str]:
    return {r.path for r in router.routes}


def test_no_quedan_endpoints_de_netsuite():
    assert _rutas() & RUTAS_PROHIBIDAS == set()


def test_no_quedan_endpoints_de_vendedores():
    assert not [p for p in _rutas() if "vendedores" in p]


def test_sobreviven_los_endpoints_del_panel_base():
    assert RUTAS_REQUERIDAS <= _rutas()


def test_el_router_expone_el_sembrado_inicial():
    from agent import admin
    assert callable(admin.sembrar_usuario_inicial)
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
python -m pytest tests/test_admin_limpio.py -v
```

Esperado: FALLAN `test_no_quedan_endpoints_de_netsuite` y `test_no_quedan_endpoints_de_vendedores`.

- [ ] **Step 3: Quitar el import del motor de NetSuite**

Borrar estas tres líneas del encabezado (líneas 38–40):

```python
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))
import db as ns_db  # noqa: E402  motor SQLite de catálogo/clientes sincronizados
```

y dejar solo:

```python
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
```

- [ ] **Step 4: Quitar la constante de vendedores**

Borrar la línea `VENDEDORES_PATH = os.path.join(ROOT_DIR, "config", "vendedores_whatsapp.yaml")`.

- [ ] **Step 5: Actualizar el docstring del módulo**

Reemplazar el docstring de las líneas 4–16 por:

```python
"""
Panel web para que el dueño del negocio (no un programador) pueda:
  - Editar los parámetros del agente (datos del negocio, prompt).
  - Ver métricas de clientes contactados.
  - Subir archivos o ligas de conocimiento para que el agente los use.
  - Administrar los usuarios que entran al panel.

Todo bajo /admin, protegido con una sesión firmada con HMAC (contraseña
en .env — ADMIN_PASSWORD). Nunca se exponen secretos (tokens, API keys) en
ninguna respuesta de este router.
"""
```

- [ ] **Step 6: Borrar los endpoints amputados**

Borrar la función completa (decorador + cuerpo + docstring) de cada uno:

| Endpoint | Ubicación aproximada en el archivo original |
|---|---|
| `@router.get("/api/indicadores")` | línea 347 |
| `@router.get("/api/indicadores/estrategicos")` | línea 407 |
| `@router.post("/api/sync")` | línea 642 |
| `@router.get("/api/sync/estado")` | línea 676 |
| `@router.get("/api/catalogo")` | línea 698 |
| `@router.get("/api/clientes")` | línea 735 |
| `@router.get("/api/vendedores")` | línea 796 |
| `@router.post("/api/vendedores")` | línea 802 |
| `@router.put("/api/vendedores/{netsuite_id}")` | línea 822 |
| `@router.delete("/api/vendedores/{netsuite_id}")` | línea 835 |

Junto con cualquier función auxiliar que solo esas usaban (entre las líneas 835 y 879 hay helpers de vendedores sin decorador — borrarlos también).

- [ ] **Step 7: Revisar `/api/metricas`**

```bash
grep -n "vendedor\|ns_db\|catalogo" agent/admin.py
```

`/api/metricas` (línea 285 del original) puede contar mensajes por vendedor. Si sale en el grep, reescribir esa parte para que solo cuente lo que existe: total de conversaciones, mensajes, citas, leads y tickets. Esperado al final: salida vacía.

- [ ] **Step 8: Correr el test**

```bash
python -m pytest tests/test_admin_limpio.py -v
```

Esperado: los 4 tests PASAN.

- [ ] **Step 9: Commit**

```bash
git add agent/admin.py tests/test_admin_limpio.py
git commit -m "fix: el panel tenia pestañas que respondian 500

Catalogo, clientes, vendedores, sync e indicadores consultaban tablas de
NetSuite que aqui no existen. Un boton que truena es peor que uno ausente:
el dueño no sabe si fallo el, el panel o el agente."
```

---

### Task 6: Cirugía de `agent/memory.py`

**Files:**
- Modify: `agent/memory.py` (de 717 líneas a ~450)
- Test: `tests/test_memoria_limpia.py` (crear)

**Interfaces:**
- Consumes: `agent/tools.py` (Task 4) y `agent/admin.py` (Task 5) ya no llaman a las funciones de vendedores ni de clientes.
- Produces: `agent.memory` con 8 tablas — `mensajes`, `citas`, `leads`, `usuarios_admin`, `tickets`, `propuestas_aprendizaje`, `notas_claude_code`, `eventos_tunel` — y sin las funciones `listar_vendedores`, `contar_vendedores`, `migrar_vendedores`, `crear_vendedor`, `actualizar_vendedor`, `eliminar_vendedor`, `agregar_al_carrito`, `ver_carrito`, `confirmar_pedido`, `guardar_cliente`, `obtener_cliente`, `registrar_notificacion_vendedor`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_memoria_limpia.py`:

```python
# tests/test_memoria_limpia.py — El esquema no arrastra tablas del negocio anterior
"""
Cada tabla que sobra se crea en cada arranque y aparece en los respaldos.
Peor: 'clientes' guardaba el roster sincronizado de NetSuite, datos de un
negocio que no es este.
"""

from agent.memory import Base

TABLAS_ESPERADAS = {
    "mensajes",
    "citas",
    "leads",
    "usuarios_admin",
    "tickets",
    "propuestas_aprendizaje",
    "notas_claude_code",
    "eventos_tunel",
}

FUNCIONES_PROHIBIDAS = [
    "listar_vendedores", "contar_vendedores", "migrar_vendedores",
    "crear_vendedor", "actualizar_vendedor", "eliminar_vendedor",
    "agregar_al_carrito", "ver_carrito", "confirmar_pedido",
    "guardar_cliente", "obtener_cliente", "registrar_notificacion_vendedor",
]


def test_el_esquema_tiene_exactamente_las_tablas_esperadas():
    assert set(Base.metadata.tables.keys()) == TABLAS_ESPERADAS


def test_no_sobreviven_las_funciones_del_negocio_anterior():
    from agent import memory
    for nombre in FUNCIONES_PROHIBIDAS:
        assert not hasattr(memory, nombre), f"quedo memory.{nombre}"
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
python -m pytest tests/test_memoria_limpia.py -v
```

Esperado: FALLAN los dos (hoy hay 12 tablas y las 12 funciones existen).

- [ ] **Step 3: Borrar las clases de las tablas amputadas**

Borrar las cuatro clases completas: `ItemCarrito` (línea 75), `Cliente` (89), `NotificacionVendedor` (102) y `Vendedor` (177).

- [ ] **Step 4: Borrar las funciones de vendedores**

Borrar `listar_vendedores`, `contar_vendedores`, `migrar_vendedores`, `crear_vendedor`, `actualizar_vendedor` y `eliminar_vendedor` (líneas 197–271 del original).

- [ ] **Step 5: Borrar las funciones de carrito y clientes**

Borrar `agregar_al_carrito`, `ver_carrito`, `confirmar_pedido`, `guardar_cliente`, `obtener_cliente` y `registrar_notificacion_vendedor` (líneas 471–562 del original).

- [ ] **Step 6: Revisar la migración**

```bash
grep -n "vendedor\|carrito\|cliente" agent/memory.py
```

La función `_migrar(conn)` (línea 319) puede tener `ALTER TABLE` sobre las tablas borradas. Quitar esas sentencias. Esperado al final: salida vacía.

- [ ] **Step 7: Correr el test**

```bash
python -m pytest tests/test_memoria_limpia.py -v
```

Esperado: los 2 tests PASAN.

- [ ] **Step 8: Commit**

```bash
git add agent/memory.py tests/test_memoria_limpia.py
git commit -m "fix: el esquema creaba tablas de clientes de otro negocio

carrito, clientes, notificaciones_vendedor y vendedores se creaban en cada
arranque y entraban a los respaldos. 'clientes' ademas guardaba el roster
sincronizado de NetSuite de Ambar."
```

---

### Task 7: Recortar el panel (`agent/static_admin/`)

**Files:**
- Modify: `agent/static_admin/index.html` (215 líneas → ~160)
- Modify: `agent/static_admin/app.js` (751 líneas → ~450)
- Test: `tests/test_panel_limpio.py` (crear)

**Interfaces:**
- Consumes: los endpoints que sobrevivieron a la Task 5. El panel no debe llamar a ninguno que ya no exista.
- Produces: un panel con 5 secciones — `sec-resumen`, `sec-config`, `sec-conocimiento`, `sec-aprendizaje`, `sec-usuarios`.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_panel_limpio.py`:

```python
# tests/test_panel_limpio.py — El frontend no llama endpoints que ya no existen
"""
Si el HTML dibuja una pestaña de catalogo y el backend ya no la sirve, el
usuario ve una pantalla en blanco sin explicacion. El panel y el router
tienen que contar la misma historia.
"""

import os
import re

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "agent", "static_admin")


def _leer(nombre: str) -> str:
    with open(os.path.join(STATIC_DIR, nombre), "r", encoding="utf-8") as f:
        return f.read()


def test_el_html_solo_tiene_las_secciones_vivas():
    html = _leer("index.html")
    secciones = set(re.findall(r'id="(sec-[a-z]+)"', html))
    assert secciones == {"sec-resumen", "sec-config", "sec-conocimiento",
                         "sec-aprendizaje", "sec-usuarios"}


def test_el_js_no_llama_endpoints_amputados():
    js = _leer("app.js")
    for ruta in ("/api/catalogo", "/api/clientes", "/api/vendedores",
                 "/api/indicadores", "/api/sync"):
        assert ruta not in js, f"app.js todavia llama {ruta}"


def test_el_panel_no_menciona_el_negocio_anterior():
    for nombre in ("index.html", "app.js"):
        texto = _leer(nombre).lower()
        for palabra in ("ambar", "netsuite", "vendedor", "catalogo"):
            assert palabra not in texto, f"quedo '{palabra}' en {nombre}"
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
python -m pytest tests/test_panel_limpio.py -v
```

Esperado: FALLAN los 3.

- [ ] **Step 3: Borrar las secciones del HTML**

En `index.html`, borrar estas tres líneas (203–205) y el botón de navegación que apunta a cada una:

```html
<section class="seccion" id="sec-catalogo"></section>
<section class="seccion" id="sec-vendedores"></section>
<section class="seccion" id="sec-indicadores"></section>
```

Buscar los botones con `grep -n "catalogo\|vendedores\|indicadores" agent/static_admin/index.html` y borrarlos también.

- [ ] **Step 4: Borrar los renderizadores en `app.js`**

```bash
grep -n "catalogo\|vendedor\|indicadores\|sync\|clientes" agent/static_admin/app.js
```

Borrar cada función de render, su entrada en el enrutador de secciones y cualquier `fetch` a los endpoints amputados.

- [ ] **Step 5: Reemplazar cualquier mención al negocio**

Cambiar títulos y textos que digan "Ambar Cargo" o "Claudia" por texto genérico ("el agente", "el negocio"). El nombre real se toma de `business.yaml` en tiempo de ejecución.

- [ ] **Step 6: Correr el test**

```bash
python -m pytest tests/test_panel_limpio.py -v
```

Esperado: los 3 tests PASAN.

- [ ] **Step 7: Commit**

```bash
git add agent/static_admin/ tests/test_panel_limpio.py
git commit -m "fix: el panel dibujaba pestañas que el backend ya no sirve

Catalogo, vendedores e indicadores quedaban como pantallas en blanco sin
explicacion. El frontend y el router ahora cuentan la misma historia."
```

---

### Task 8: Borrar los módulos, scripts, tests y configs huérfanos

**Files:**
- Delete: `agent/netsuite_client.py`, `agent/programador.py`
- Delete: `scripts/sync_netsuite_catalogo.py`, `scripts/sync_netsuite_clientes.py`, `scripts/sync_diario.py`, `scripts/sync_diario.bat`, `scripts/db.py`, `scripts/credenciales.py`, `scripts/config.ini`, `scripts/config.ini.example`
- Delete: `config/clientes_escala.yaml`, `config/vendedores_whatsapp.yaml`
- Delete: `tests/test_abreviaturas.py`, `tests/test_aviso_vendedor.py`, `tests/test_busqueda_flexible.py`, `tests/test_catalogo.py`, `tests/test_credenciales.py`, `tests/test_programador.py`, `tests/test_sync_diario.py`, `tests/test_vendedores.py`
- Modify: `scripts/respaldo.py`, `tests/test_respaldo.py`, `tests/test_dependencias.py`, `requirements.txt`

**Interfaces:**
- Consumes: las tareas 2–7 ya quitaron toda referencia a estos módulos.
- Produces: un árbol donde `python -c "import agent.main"` corre sin `ImportError`.

- [ ] **Step 1: Confirmar que nadie los referencia**

```bash
cd /c/Users/odaniel/Whatsapp-fisiomike
grep -rn "netsuite_client\|programador\|import db\|ns_db\|credenciales" --include="*.py" agent/ tests/ scripts/
```

Esperado: solo salen líneas *dentro* de los archivos que se van a borrar. Si algo en `agent/` los sigue nombrando, **volver a la tarea correspondiente** antes de borrar.

- [ ] **Step 2: Borrar los archivos**

```bash
git rm agent/netsuite_client.py agent/programador.py
git rm scripts/sync_netsuite_catalogo.py scripts/sync_netsuite_clientes.py \
       scripts/sync_diario.py scripts/sync_diario.bat scripts/db.py \
       scripts/credenciales.py
git rm --ignore-unmatch scripts/config.ini scripts/config.ini.example
git rm config/clientes_escala.yaml config/vendedores_whatsapp.yaml
git rm tests/test_abreviaturas.py tests/test_aviso_vendedor.py \
       tests/test_busqueda_flexible.py tests/test_catalogo.py \
       tests/test_credenciales.py tests/test_programador.py \
       tests/test_sync_diario.py tests/test_vendedores.py
```

- [ ] **Step 3: Ajustar `scripts/respaldo.py`**

Quitar `"netsuite_sync.db"` de la lista de archivos a respaldar (línea 66) y las dos menciones en los docstrings (líneas 22 y 78). El docstring de la línea 22 debe quedar describiendo solo `agentkit.db`.

- [ ] **Step 4: Ajustar `tests/test_respaldo.py`**

```bash
grep -n "netsuite" tests/test_respaldo.py
```

Quitar las expectativas sobre `netsuite_sync.db`. El test debe seguir verificando que el respaldo incluye `agentkit.db` y `config/`.

- [ ] **Step 5: Soltar las dependencias que solo existían para NetSuite**

`requests` y `requests-oauthlib` se declararon únicamente para `agent/netsuite_client.py` y `scripts/sync_netsuite_*.py` — el propio comentario de `requirements.txt` lo dice. Sin esos archivos quedan como peso muerto que el contenedor instala en cada build.

Borrar de `requirements.txt` el bloque final completo:

```
# NetSuite (agent/netsuite_client.py y scripts/sync_netsuite_*.py).
# Faltaban: en local funcionaban porque estaban instaladas globalmente, pero
# el contenedor arranca limpio y reventaba con ModuleNotFoundError.
requests>=2.31.0,<3.0.0
requests-oauthlib>=1.3.1,<3.0.0
```

**No tocar las cotas superiores del resto.** El comentario de las líneas 1–13 explica por qué existen (el incidente de `pandas` que tumbó los reportes 4 días); esa lección aplica igual aquí y se queda.

- [ ] **Step 6: Ajustar `tests/test_dependencias.py`**

Dos cambios:
1. Línea 12: el docstring cita `/app/agent/netsuite_client.py` como ejemplo de traceback. Cambiarlo por `/app/agent/tools.py`.
2. Línea 13: quitar el `import requests` — esa dependencia ya no se declara, así que el test fallaría al verificarla.

Verificar que el test sigue cubriendo las dependencias que sí quedan:

```bash
grep -n "import" tests/test_dependencias.py
```

- [ ] **Step 7: Verificar que el agente importa**

```bash
python -c "import agent.main; print('ok')"
```

Esperado: imprime `ok`. Si sale `ImportError`, leerlo con cuidado: nombra exactamente qué quedó colgando.

- [ ] **Step 8: Correr la suite completa**

```bash
python -m pytest -v
```

Esperado: todos los tests PASAN. Deben quedar `test_local.py`, `test_dependencias.py`, `test_health_tunel.py`, `test_borrar_conversacion.py`, `test_respaldo.py` más los 6 nuevos de este plan (`test_main_limpio`, `test_herramientas`, `test_tools_limpio`, `test_admin_limpio`, `test_memoria_limpia`, `test_panel_limpio`).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: borrar los modulos que ya nadie llamaba

netsuite_client, programador y los cuatro scripts de sync quedaron sin
consumidor tras la cirugia. respaldo.py seguia buscando netsuite_sync.db
y avisando que no lo encontraba en cada respaldo."
```

---

### Task 9: Plantillas de configuración, `.env.example` y documentación

**Files:**
- Modify: `.env.example`
- Modify: `config/business.yaml`, `config/prompts.yaml`
- Modify: `README.md`, `RAILWAY.md`, `APRENDIZAJE_CONOCIMIENTO.md`
- Delete: `docs/superpowers/specs/` y `docs/superpowers/plans/` heredados de Ambar (excepto los de este trabajo)
- Test: `tests/test_configuracion.py` (crear)

**Interfaces:**
- Consumes: nada.
- Produces: `config/business.yaml` y `config/prompts.yaml` como plantilla vacía, lista para que la Fase 2 de AgentKit la llene.

- [ ] **Step 1: Escribir el test que falla**

Crear `tests/test_configuracion.py`:

```python
# tests/test_configuracion.py — La configuracion no trae datos de otro negocio
"""
business.yaml y prompts.yaml se copiaron con el perfil de Claudia IA de
Ambar Cargo. Si se quedan asi, el agente nuevo saluda como una empresa de
gruas viajeras al primer cliente que escriba.
"""

import os
import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _leer_yaml(ruta: str) -> dict:
    with open(os.path.join(ROOT, ruta), "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def test_business_no_trae_el_negocio_anterior():
    texto = open(os.path.join(ROOT, "config", "business.yaml"), encoding="utf-8").read().lower()
    for palabra in ("ambar", "claudia", "grua", "malacate", "netsuite"):
        assert palabra not in texto, f"quedo '{palabra}' en business.yaml"


def test_prompts_no_trae_el_negocio_anterior():
    texto = open(os.path.join(ROOT, "config", "prompts.yaml"), encoding="utf-8").read().lower()
    for palabra in ("ambar", "claudia", "grua", "vendedor", "catalogo"):
        assert palabra not in texto, f"quedo '{palabra}' en prompts.yaml"


def test_prompts_conserva_las_llaves_que_brain_lee():
    config = _leer_yaml("config/prompts.yaml")
    assert "system_prompt" in config
    assert "fallback_message" in config
    assert "error_message" in config


def test_env_example_no_pide_credenciales_de_netsuite():
    texto = open(os.path.join(ROOT, ".env.example"), encoding="utf-8").read()
    for variable in ("NETSUITE_", "SYNC_PROGRAMADO_", "TWILIO_CONTENT_SID_AVISO_VENDEDOR"):
        assert variable not in texto, f"quedo {variable} en .env.example"
```

- [ ] **Step 2: Correr el test para verificar que falla**

```bash
python -m pytest tests/test_configuracion.py -v
```

Esperado: FALLAN los 3 primeros y el último.

- [ ] **Step 3: Vaciar `config/business.yaml`**

Reemplazar el archivo completo por:

```yaml
# Configuración del negocio — Generado por AgentKit
# Este archivo lo llena la Fase 2 (entrevista del negocio). No editarlo a mano
# a menos que sepas lo que haces: el panel de administración también lo escribe.
negocio:
  nombre: ""
  descripcion: ""
  horario: ""

agente:
  nombre: ""
  tono: ""
  casos_de_uso: []

metadata:
  creado: ""
  version: "1.0"
```

- [ ] **Step 4: Vaciar `config/prompts.yaml`**

Reemplazar el archivo completo por:

```yaml
# System prompt del agente — Generado por AgentKit
# Lo escribe la Fase 2 (entrevista del negocio) y se puede editar después
# desde el panel de administración, en la pestaña de Configuración.
system_prompt: |
  Eres el asistente virtual de este negocio.

  La entrevista de AgentKit (Fase 2) reemplaza este texto por un prompt
  completo: identidad, descripción del negocio, capacidades, horario,
  información de /knowledge y reglas de comportamiento.

fallback_message: "Disculpa, no entendí tu mensaje. ¿Podrías reformularlo?"
error_message: "Lo siento, estoy teniendo problemas técnicos. Por favor intenta de nuevo en unos minutos."
```

- [ ] **Step 5: Recortar `.env.example`**

Borrar los bloques de las 10 variables amputadas: las 6 `NETSUITE_*` (`ACCOUNT_ID`, `CONSUMER_KEY`, `CONSUMER_SECRET`, `TOKEN_ID`, `TOKEN_SECRET`, `SUBSIDIARY_ID`), más `NETSUITE_DB_PATH`, `SYNC_PROGRAMADO_ENABLED`, `SYNC_PROGRAMADO_HORA` y `TWILIO_CONTENT_SID_AVISO_VENDEDOR`, junto con sus comentarios explicativos.

Deben quedar exactamente 15 variables:

```
ANTHROPIC_API_KEY          WHATSAPP_PROVIDER          TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN          TWILIO_PHONE_NUMBER        PUBLIC_BASE_URL
ADMIN_PASSWORD             ADMIN_SECRET_KEY           PORT
ENVIRONMENT                LOG_LEVEL                  DATABASE_URL
HEALTH_TUNEL_ENABLED       HEALTH_TUNEL_INTERVALO     HEALTH_TUNEL_ALERTA_WHATSAPP
```

Verificar con:

```bash
grep -cE "^[A-Z_]+=" .env.example
```

Esperado: `15`.

- [ ] **Step 6: Regenerar el `.env` de trabajo**

```bash
cp .env.example .env
```

- [ ] **Step 7: Filtrar `APRENDIZAJE_CONOCIMIENTO.md`**

Conservar solo las lecciones técnicas transversales — las que aplican a cualquier agente de AgentKit:

- el incidente de `pandas` y el acotado de dependencias
- el contenedor corriendo en UTC y la zona horaria
- el comportamiento del auto-deploy de Railway
- el sandbox que bloquea la plantilla de WhatsApp
- que `railway up` respeta `.gitignore` (por eso las credenciales van por variable de entorno, no por archivo)

Borrar todo lo que hable del catálogo, los vendedores, las escalas de precio, la búsqueda de artículos o el negocio de Ambar. Agregar al inicio una nota de una línea: `> Lecciones heredadas del proyecto del que se derivó este. Se conservan las que aplican a cualquier agente.`

- [ ] **Step 8: Actualizar `README.md` y `RAILWAY.md`**

```bash
grep -n "Ambar\|Claudia\|NetSuite\|catalogo\|vendedor" README.md RAILWAY.md
```

Reescribir cada mención en términos genéricos. En `RAILWAY.md`, quitar las `NETSUITE_*` y `SYNC_PROGRAMADO_*` de la lista de variables a configurar.

- [ ] **Step 9: Limpiar `docs/` heredado**

```bash
ls docs/superpowers/specs/ docs/superpowers/plans/
```

Conservar `2026-08-12-duplicado-fisiomike-design.md` y `2026-08-12-duplicado-fisiomike.md` (documentan de dónde viene este proyecto). Borrar con `git rm` cualquier otro spec o plan heredado de Ambar.

- [ ] **Step 10: Correr el test**

```bash
python -m pytest tests/test_configuracion.py -v
```

Esperado: los 4 tests PASAN.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "chore: la configuracion todavia describia el negocio anterior

business.yaml y prompts.yaml traian el perfil de Claudia IA de Ambar Cargo:
el agente nuevo habria saludado como una empresa de gruas al primer cliente
que escribiera. Quedan como plantilla para la entrevista de Fase 2."
```

---

### Task 10: Verificación integral

**Files:**
- Modify: ninguno (salvo lo que la verificación revele)
- Test: la suite completa más las comprobaciones manuales del spec

**Interfaces:**
- Consumes: todas las tareas anteriores.
- Produces: la evidencia que autoriza a declarar el trabajo terminado.

- [ ] **Step 1: Suite completa en verde**

```bash
cd /c/Users/odaniel/Whatsapp-fisiomike
python -m pytest -v
```

Esperado: todos PASAN, 0 fallidos, 0 errores. Copiar la línea de resumen.

- [ ] **Step 2: El agente importa**

```bash
python -c "import agent.main; print('import ok')"
```

Esperado: `import ok`.

- [ ] **Step 3: El servidor arranca y responde**

```bash
python -m uvicorn agent.main:app --port 8123 &
sleep 5
curl -s http://127.0.0.1:8123/
```

Esperado: `{"status":"ok","service":"agentkit"}`. Después, matar el proceso.

- [ ] **Step 4: El panel abre**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8123/admin
```

Esperado: `200`.

- [ ] **Step 5: Cero rastro de Ambar en el código**

```bash
grep -rniE "netsuite|ambar|vendedor|catalogo|carrito|escala" \
  --include="*.py" --include="*.js" --include="*.yaml" --include="*.html" . \
  | grep -v "^./docs/"
```

Esperado: **salida vacía**. Los `docs/` sí mencionan Ambar a propósito — documentan de dónde viene el proyecto.

- [ ] **Step 6: Sin remotes**

```bash
git remote -v
```

Esperado: salida vacía.

- [ ] **Step 7: Sin datos ni secretos de Ambar**

```bash
find . -name "*.db" -o -type d -name transcripts -o -type d -name respaldos -o -type d -name simulaciones
git ls-files | grep -iE "\.env$|\.db$" || echo "nada sensible rastreado"
```

Esperado: el `find` no imprime nada (salvo `agentkit.db` si ya se corrió el servidor, que es la base nueva y vacía de Fisiomike — verificar que pesa pocos KB). El segundo comando imprime `nada sensible rastreado`.

- [ ] **Step 8: Commit final**

```bash
git add -A
git commit -m "chore: verificacion integral del duplicado" --allow-empty
git log --oneline
```

- [ ] **Step 9: Reportar al usuario**

Entregar la evidencia real de los pasos 1–7 — la salida de pytest, el JSON del health check, el resultado del grep. Si algún paso falló, decirlo con su salida en vez de darlo por bueno. Después indicar el siguiente paso fuera de este plan: correr la Fase 1 y 2 de AgentKit en `C:\Users\odaniel\Whatsapp-fisiomike` para definir el perfil de Fisiomike.

---

## Notas de ejecución

- **Nada de `git push`.** El repo nace sin remotes a propósito. Configurar uno es decisión del usuario, fuera de este plan.
- **Si un test de una tarea previa se pone rojo**, no seguir adelante: alguna cirugía posterior tocó algo que no debía. Arreglarlo en esa tarea.
- **El perfil de Fisiomike no se inventa aquí.** Si al terminar la Task 9 alguien siente la tentación de escribir un `system_prompt` de fisioterapia "para que no quede vacío", no hacerlo: ese texto lo genera la entrevista, con las respuestas reales del usuario.
