# Identificación del cliente y derivación — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que Claudia identifique al cliente por su razón social y pueda derivar la conversación al representante de ventas que ya lo atiende en NetSuite.

**Architecture:** El código garantiza lo que debe ocurrir siempre (el comando `/agente`, la asignación, el estado de identificación); el prompt decide cómo se conversa. wacrm traduce el `salesrep_id` de NetSuite al usuario del CRM dentro del mismo `PATCH`, para no exponer la lista del equipo en un endpoint nuevo.

**Tech Stack:** Next.js 16 + Supabase + Vitest (wacrm); Python 3.11 + FastAPI + pytest (whatsapp-agentkit); SQLite local para el catálogo sincronizado de NetSuite.

**Spec:** `docs/superpowers/specs/2026-09-29-identificacion-cliente-y-derivacion-design.md`

## Global Constraints

- Los dos repos están en **producción con Autodeploy**: un push a `main` reconstruye. Cada tarea termina en commit, pero el push lo decide el humano.
- La migración `046_salesrep_netsuite.sql` **ya está aplicada y poblada** para 8 personas. No hay que volver a crearla.
- `netsuite_salesrep_id` es **TEXT**, no entero. Llega como cadena del JSON de NetSuite.
- Los mensajes que ve el cliente van en **español de México**, sin signos de apertura omitidos.
- En wacrm las pruebas corren con `npm test` (vitest). En el agente, con `python -m pytest tests/ -q`.
- `requirements.txt` del agente usa cotas superiores (`>=x,<y`). No añadir dependencias nuevas: todo lo que hace falta ya está.
- Ningún cambio debe tocar el comportamiento de `assigned_agent_id`, que ya usan las automatizaciones.

## Review Focus

Entradas que la spec implica pero que ningún flujo feliz ejercita, en orden de probabilidad de morder:

1. **`assigned_salesrep_id` con un id que existe en otra cuenta** — debe responder 409 `salesrep_not_mapped`, no asignar a alguien de otra empresa. Cubierto en Tarea 1.
2. **Los dos campos de asignación a la vez** — `400`, no adivinar cuál gana. Cubierto en Tarea 2.
3. **Razón social con acentos, mayúsculas y sufijos societarios** (`"ferreteria el tornillo sa de cv"` vs `FERRETERÍA EL TORNILLO S.A. DE C.V.`) — debe encontrarla. Cubierto en Tarea 4.
4. **`/agente` con espacios, mayúsculas o signos** (`" /Agente "`, `"/agente?"`) — debe reconocerse igual. Cubierto en Tarea 6.
5. **El CRM no responde al derivar** — Claudia no debe decirle al cliente que ya lo pasó. Cubierto en Tarea 5.

---

## Tarea 1: `resolveBySalesrep` en wacrm

**Files:**
- Modify: `src/lib/conversations/assign.ts`
- Test: `src/lib/conversations/assign.test.ts`

**Interfaces:**
- Consumes: `ResolvedAssignee` y el patrón de `resolveAssignee`, ya en ese archivo.
- Produces: `resolveBySalesrep(db, accountId, salesrepId): Promise<ResolvedAssignee>`, donde el fallo nuevo es `{ ok: false; reason: 'salesrep_not_mapped' }`.

- [ ] **Step 1: Ampliar el tipo de fallo**

En `src/lib/conversations/assign.ts`, añade la variante al tipo existente:

```ts
export type ResolvedAssignee =
  | { ok: true; agentId: string | null }
  /** `'auto'` ran and the account has nobody eligible. */
  | { ok: false; reason: 'no_agent_available' }
  /** An explicit id that doesn't belong to this account. */
  | { ok: false; reason: 'not_a_member' }
  /** A NetSuite salesrep id that no profile in this account claims. */
  | { ok: false; reason: 'salesrep_not_mapped' };
```

- [ ] **Step 2: Escribir la prueba que falla**

Añade al final de `src/lib/conversations/assign.test.ts`. Fíjate que el
stand-in de `makeDb` responde `profiles` por `maybeSingle()`, así que la
prueba extiende ese mismo mecanismo con un campo nuevo:

```ts
describe('resolveBySalesrep', () => {
  it('encuentra al perfil que reclama ese salesrep', async () => {
    const { db } = makeDb({
      reps: [{ accountId: ACCOUNT, userId: 'agent-1', salesrepId: '147' }],
    });
    expect(await resolveBySalesrep(db, ACCOUNT, '147')).toEqual({
      ok: true,
      agentId: 'agent-1',
    });
  });

  it('no cruza cuentas: un salesrep de otra cuenta no vale', async () => {
    const { db } = makeDb({
      reps: [{ accountId: 'otra-cuenta', userId: 'agent-9', salesrepId: '147' }],
    });
    expect(await resolveBySalesrep(db, ACCOUNT, '147')).toEqual({
      ok: false,
      reason: 'salesrep_not_mapped',
    });
  });

  it('avisa cuando nadie lo reclama', async () => {
    const { db } = makeDb({ reps: [] });
    expect(await resolveBySalesrep(db, ACCOUNT, '999')).toEqual({
      ok: false,
      reason: 'salesrep_not_mapped',
    });
  });
});
```

Y extiende `makeDb` para que `profiles` también responda por
`netsuite_salesrep_id`. Dentro de `makeDb`, añade `reps` a las opciones y
amplía `maybeSingle`:

```ts
function makeDb(opts: {
  members?: { accountId: string; userId: string }[];
  reps?: { accountId: string; userId: string; salesrepId: string }[];
  rpcResult?: string | null;
  rpcError?: boolean;
}) {
```

```ts
        maybeSingle: async () => {
          if (table !== 'profiles') return { data: null, error: null };
          if (filters.netsuite_salesrep_id !== undefined) {
            const rep = (opts.reps ?? []).find(
              (r) =>
                r.accountId === filters.account_id &&
                r.salesrepId === filters.netsuite_salesrep_id
            );
            return { data: rep ? { user_id: rep.userId } : null, error: null };
          }
          const hit = members.find(
            (m) =>
              m.accountId === filters.account_id && m.userId === filters.user_id
          );
          return { data: hit ? { user_id: hit.userId } : null, error: null };
        },
```

Actualiza también el import del principio del archivo:

```ts
import { resolveAssignee, resolveBySalesrep, assignConversation } from './assign';
```

- [ ] **Step 3: Correr la prueba y ver que falla**

Run: `npm test -- src/lib/conversations/assign.test.ts`
Expected: FAIL — `resolveBySalesrep is not a function`

- [ ] **Step 4: Implementar**

En `src/lib/conversations/assign.ts`, junto a `resolveAssignee`:

```ts
/**
 * Resolve a NetSuite salesrep id into the profile that claims it.
 *
 * Scoped by account because those ids are only unique inside the
 * NetSuite instance that issued them — two accounts could legitimately
 * use the same one.
 */
export async function resolveBySalesrep(
  db: SupabaseClient,
  accountId: string,
  salesrepId: string
): Promise<ResolvedAssignee> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('netsuite_salesrep_id', salesrepId)
    .maybeSingle();

  if (!data?.user_id) return { ok: false, reason: 'salesrep_not_mapped' };
  return { ok: true, agentId: data.user_id };
}
```

- [ ] **Step 5: Correr la prueba y ver que pasa**

Run: `npm test -- src/lib/conversations/assign.test.ts`
Expected: PASS, 0 failed

- [ ] **Step 6: Commit**

```bash
git add src/lib/conversations/assign.ts src/lib/conversations/assign.test.ts
git commit -m "feat: resolver un representante de NetSuite al usuario del CRM"
```

---

## Tarea 2: El `PATCH` acepta `assigned_salesrep_id` y `ai_autoreply_disabled`

**Files:**
- Modify: `src/app/api/v1/conversations/[id]/route.ts`

**Interfaces:**
- Consumes: `resolveBySalesrep` de la Tarea 1.
- Produces: el contrato que el agente usará en la Tarea 5 — `{ assigned_salesrep_id: string, ai_autoreply_disabled?: boolean }`, con `409 salesrep_not_mapped` cuando nadie lo reclama y `400` si se mandan los dos campos de asignación.

- [ ] **Step 1: Leer el handler actual**

Abre `src/app/api/v1/conversations/[id]/route.ts` y localiza el bloque
que empieza en `const wantsAssign = 'assigned_agent_id' in body;`. Ahí es
donde entran los campos nuevos.

- [ ] **Step 2: Aceptar los campos nuevos**

Reemplaza la detección de campos y su validación:

```ts
    const wantsAssign = 'assigned_agent_id' in body;
    const wantsSalesrep = 'assigned_salesrep_id' in body;
    const wantsStatus = 'status' in body;
    const wantsPause = 'ai_autoreply_disabled' in body;

    if (!wantsAssign && !wantsSalesrep && !wantsStatus && !wantsPause) {
      return fail(
        'bad_request',
        "Nothing to update: send 'assigned_agent_id', 'assigned_salesrep_id', 'status' and/or 'ai_autoreply_disabled'",
        400
      );
    }

    // Mutuamente excluyentes a propósito: con los dos puestos habría que
    // adivinar cuál gana, y adivinar a quién llega un cliente es peor
    // que rechazar la petición.
    if (wantsAssign && wantsSalesrep) {
      return fail(
        'bad_request',
        "Send either 'assigned_agent_id' or 'assigned_salesrep_id', not both",
        400
      );
    }

    if (wantsSalesrep && typeof body.assigned_salesrep_id !== 'string') {
      return fail('bad_request', "'assigned_salesrep_id' must be a string", 400);
    }

    if (wantsPause && typeof body.ai_autoreply_disabled !== 'boolean') {
      return fail('bad_request', "'ai_autoreply_disabled' must be a boolean", 400);
    }
```

- [ ] **Step 3: Resolver el representante antes de asignar**

Donde hoy se resuelve el destino con `resolveAssignee`, añade la rama del
representante. Importa la función junto a las que ya se usan:

```ts
import { resolveAssignee, resolveBySalesrep, assignConversation } from '@/lib/conversations/assign';
```

Y resuelve según el campo recibido:

```ts
    let resolved;
    if (wantsSalesrep) {
      resolved = await resolveBySalesrep(
        ctx.supabase,
        ctx.accountId,
        body.assigned_salesrep_id
      );
      if (!resolved.ok && resolved.reason === 'salesrep_not_mapped') {
        // 409 y no 404: la conversación existe y la petición es válida;
        // lo que falta es que alguien del equipo reclame ese id. Quien
        // llama decide si reparte de otra forma — el CRM no elige por su
        // cuenta a quién mandar un cliente.
        return fail('conflict', 'No profile claims that salesrep id', 409, {
          reason: 'salesrep_not_mapped',
        });
      }
    } else if (wantsAssign) {
      resolved = await resolveAssignee(ctx.supabase, ctx.accountId, target);
    }
```

- [ ] **Step 4: Escribir también la pausa**

En el objeto que se manda a la actualización, incluye el campo cuando
venga:

```ts
    if (wantsPause) {
      update.ai_autoreply_disabled = body.ai_autoreply_disabled;
    }
```

- [ ] **Step 5: Comprobar que no se rompió lo anterior**

Run: `npm test && npm run typecheck`
Expected: ambos exit 0, 0 failed

- [ ] **Step 6: Probarlo contra la base real**

```bash
# Sustituye <CONV_ID> por una conversación real y usa tu WACRM_API_KEY.
curl -s -X PATCH "https://crm.ambar-apps.cloud/api/v1/conversations/<CONV_ID>" \
  -H "Authorization: Bearer $WACRM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"assigned_salesrep_id":"147","ai_autoreply_disabled":true}' | head -c 300
```

Expected: 200 y `assigned_agent_id` con el usuario de Alejandra.
Prueba también el rechazo:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "https://crm.ambar-apps.cloud/api/v1/conversations/<CONV_ID>" \
  -H "Authorization: Bearer $WACRM_API_KEY" -H 'Content-Type: application/json' \
  -d '{"assigned_salesrep_id":"999"}'
```

Expected: `409`

- [ ] **Step 7: Commit**

```bash
git add src/app/api/v1/conversations/\[id\]/route.ts
git commit -m "feat: derivar una conversación al representante de NetSuite"
```

---

## Tarea 3: Buscar un cliente por razón social en el catálogo

**Files:**
- Modify: `agent/tools.py` (repo `whatsapp-agentkit`)
- Test: `tests/test_identificar_cliente.py` (crear)

**Interfaces:**
- Consumes: `netsuite_sync.db`, tabla `clientes` con `netsuite_id, nombre, nombre_normalizado, rfc, rfc_normalizado, salesrep_id, salesrep_nombre`.
- Produces: `buscar_cliente_por_razon_social(razon_social: str, limite: int = 5) -> list[dict]`, cada dict con `netsuite_id, nombre, rfc, salesrep_id, salesrep_nombre, es_representante_real`.

- [ ] **Step 1: Escribir la prueba que falla**

Crea `tests/test_identificar_cliente.py`:

```python
import sqlite3
import pytest
from agent.tools import buscar_cliente_por_razon_social


@pytest.fixture
def catalogo(tmp_path, monkeypatch):
    """Catálogo mínimo con los casos que importan."""
    db = tmp_path / "netsuite_sync.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE clientes (netsuite_id TEXT, nombre TEXT, "
        "nombre_normalizado TEXT, rfc TEXT, rfc_normalizado TEXT, "
        "salesrep_id TEXT, salesrep_nombre TEXT)"
    )
    filas = [
        ("1", "FERRETERIA EL TORNILLO S.A. DE C.V.", "ferreteria el tornillo sa de cv",
         "FET010101AAA", "fet010101aaa", "147", "ALEJANDRA CASTELLANOS FRANCO"),
        ("2", "TORNILLOS DEL NORTE SA DE CV", "tornillos del norte sa de cv",
         "TDN020202BBB", "tdn020202bbb", "5200", "AMBAR CARGO"),
        ("3", "TORNILLOS DEL NORTE DE OCCIDENTE", "tornillos del norte de occidente",
         "TNO030303CCC", "tno030303ccc", "122", "VALERIA SARAHI SILVA RUIZ"),
    ]
    con.executemany("INSERT INTO clientes VALUES (?,?,?,?,?,?,?)", filas)
    con.commit()
    con.close()
    monkeypatch.setenv("NETSUITE_DB_PATH", str(db))
    return db


def test_encuentra_pese_a_acentos_mayusculas_y_sufijos(catalogo):
    r = buscar_cliente_por_razon_social("ferretería el tornillo")
    assert len(r) == 1
    assert r[0]["nombre"] == "FERRETERIA EL TORNILLO S.A. DE C.V."
    assert r[0]["salesrep_id"] == "147"
    assert r[0]["es_representante_real"] is True


def test_ambar_cargo_no_cuenta_como_representante(catalogo):
    r = buscar_cliente_por_razon_social("tornillos del norte sa de cv")
    assert r[0]["salesrep_nombre"] == "AMBAR CARGO"
    assert r[0]["es_representante_real"] is False


def test_devuelve_varios_candidatos_cuando_hay_ambiguedad(catalogo):
    r = buscar_cliente_por_razon_social("tornillos del norte")
    assert len(r) == 2


def test_sin_coincidencia_devuelve_lista_vacia(catalogo):
    assert buscar_cliente_por_razon_social("Panadería La Espiga") == []


def test_texto_vacio_no_devuelve_todo_el_catalogo(catalogo):
    assert buscar_cliente_por_razon_social("   ") == []
```

- [ ] **Step 2: Correr y ver que falla**

Run: `python -m pytest tests/test_identificar_cliente.py -q`
Expected: FAIL — `ImportError: cannot import name 'buscar_cliente_por_razon_social'`

- [ ] **Step 3: Implementar**

En `agent/tools.py`, junto a las demás funciones de catálogo. Reutiliza
`_sin_acentos`, que ya existe en ese archivo:

```python
# Sufijos societarios: nadie escribe su razón social con ellos, y están
# en casi todas las del catálogo. Quitarlos de los dos lados evita que
# "ferretería el tornillo" falle contra "FERRETERIA EL TORNILLO S.A. DE C.V.".
_SUFIJOS_SOCIETARIOS = (
    "sa de cv", "s a de c v", "sapi de cv", "s de rl de cv",
    "sa", "sc", "ac", "srl",
)


def _normalizar_razon_social(texto: str) -> str:
    t = _sin_acentos((texto or "").lower())
    t = "".join(c if c.isalnum() or c.isspace() else " " for c in t)
    t = " ".join(t.split())
    for suf in _SUFIJOS_SOCIETARIOS:
        if t.endswith(" " + suf):
            t = t[: -(len(suf) + 1)].strip()
    return t


def buscar_cliente_por_razon_social(razon_social: str, limite: int = 5) -> list[dict]:
    """Busca una empresa en el catálogo sincronizado de NetSuite.

    Devuelve varios candidatos a propósito cuando la búsqueda es ambigua:
    quien decide cuál es el correcto es el cliente, no esta función.
    """
    consulta = _normalizar_razon_social(razon_social)
    if not consulta:
        # Sin esto, un mensaje en blanco haría un LIKE '%%' y devolvería
        # el catálogo entero como si todos fueran el cliente.
        return []

    ruta = os.getenv("NETSUITE_DB_PATH") or os.path.join(ROOT_DIR, "netsuite_sync.db")
    if not os.path.exists(ruta):
        logger.warning("Catálogo de NetSuite no encontrado en %s", ruta)
        return []

    con = sqlite3.connect(ruta)
    con.row_factory = sqlite3.Row
    try:
        filas = con.execute(
            "SELECT netsuite_id, nombre, rfc, salesrep_id, salesrep_nombre "
            "FROM clientes WHERE nombre_normalizado LIKE ? LIMIT ?",
            (f"%{consulta}%", limite),
        ).fetchall()
    finally:
        con.close()

    return [
        {
            "netsuite_id": f["netsuite_id"],
            "nombre": f["nombre"],
            "rfc": f["rfc"],
            "salesrep_id": f["salesrep_id"],
            "salesrep_nombre": f["salesrep_nombre"],
            # AMBAR CARGO es la empresa, no una persona: 9 de cada 10
            # clientes lo tienen. Decirle a alguien que su representante
            # es Ambar Cargo no le aporta nada.
            "es_representante_real": (f["salesrep_nombre"] or "").strip().upper() != "AMBAR CARGO",
        }
        for f in filas
    ]
```

Asegúrate de que `agent/tools.py` tenga al principio `import os`,
`import sqlite3` y `import logging` con su `logger`. Si alguno falta,
añádelo junto a los imports existentes.

- [ ] **Step 4: Correr y ver que pasa**

Run: `python -m pytest tests/test_identificar_cliente.py -q`
Expected: PASS, 5 passed

- [ ] **Step 5: Commit**

```bash
git add agent/tools.py tests/test_identificar_cliente.py
git commit -m "feat: buscar un cliente por razón social en el catálogo de NetSuite"
```

---

## Tarea 4: Exponer la búsqueda como herramienta de Claudia

**Files:**
- Modify: `agent/brain.py` (lista de herramientas y el mapa de despacho)
- Modify: `agent/tools.py`

**Interfaces:**
- Consumes: `buscar_cliente_por_razon_social` de la Tarea 3.
- Produces: la herramienta `identificar_cliente` visible para el modelo, que devuelve `{"encontrado": bool, "candidatos": [...]}`.

- [ ] **Step 1: Añadir el envoltorio en `tools.py`**

```python
def identificar_cliente(razon_social: str) -> dict:
    """Herramienta: busca al cliente por su razón social."""
    candidatos = buscar_cliente_por_razon_social(razon_social)
    return {
        "encontrado": bool(candidatos),
        "candidatos": candidatos,
        "varios": len(candidatos) > 1,
    }
```

- [ ] **Step 2: Declarar la herramienta para el modelo**

En `agent/brain.py`, dentro de la lista donde están `consultar_catalogo`
y las demás, añade:

```python
    {
        "name": "identificar_cliente",
        "description": (
            "Busca a una empresa en el catálogo de clientes de NetSuite por su razón "
            "social. Úsala cuando el cliente te diga el nombre de su empresa.\n"
            "- 'encontrado': false significa que no está registrado; trátalo como "
            "cliente nuevo sin hacerlo sentir mal.\n"
            "- 'varios': true significa que hay más de una empresa parecida. "
            "Pregúntale cuál es la suya antes de seguir; no elijas por él.\n"
            "- 'es_representante_real': false significa que no tiene un asesor "
            "asignado de verdad. NO le menciones representante: ofrécele seguir "
            "contigo o pasar con alguien del equipo.\n"
            "- NO le recites el RFC. Confirma la razón social y ya; cualquiera "
            "puede escribir el nombre de una empresa que no es suya."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "razon_social": {
                    "type": "string",
                    "description": "Nombre de la empresa tal como lo escribió el cliente",
                }
            },
            "required": ["razon_social"],
        },
    },
```

- [ ] **Step 3: Conectarla al despacho**

En el diccionario de `agent/brain.py` que mapea nombres a funciones
(donde está `"consultar_catalogo": biz_tools.consultar_catalogo`), añade:

```python
    "identificar_cliente": biz_tools.identificar_cliente,
```

- [ ] **Step 4: Comprobar que el agente sigue arrancando**

Run: `python -c "import agent.brain"` y luego `python -m pytest tests/ -q`
Expected: ambos exit 0, 0 failed

- [ ] **Step 5: Commit**

```bash
git add agent/tools.py agent/brain.py
git commit -m "feat: herramienta identificar_cliente para Claudia"
```

---

## Tarea 5: Derivar la conversación desde el agente

**Files:**
- Modify: `agent/wacrm_crm.py`
- Test: `tests/test_derivar.py` (crear)

**Interfaces:**
- Consumes: `_llamar`, `datos_de` y `activo`, ya en `wacrm_crm.py`.
- Produces: `async derivar(telefono: str, salesrep_id: str | None) -> bool` — `True` solo si el CRM confirmó la asignación.

- [ ] **Step 1: Escribir la prueba que falla**

Crea `tests/test_derivar.py`:

```python
import pytest
from agent import wacrm_crm


@pytest.fixture(autouse=True)
def crm_activo(monkeypatch):
    monkeypatch.setenv("WACRM_URL", "http://crm.test")
    monkeypatch.setenv("WACRM_API_KEY", "clave-de-prueba")
    wacrm_crm.recordar("+5213330000000", "conv-1", "cont-1")


@pytest.mark.asyncio
async def test_deriva_al_representante_y_pausa_a_claudia(monkeypatch):
    enviados = {}

    async def fake_llamar(metodo, ruta, cuerpo=None):
        enviados.update({"metodo": metodo, "ruta": ruta, "cuerpo": cuerpo})
        return {"data": {"assigned_agent_id": "user-alejandra"}}

    monkeypatch.setattr(wacrm_crm, "_llamar", fake_llamar)
    assert await wacrm_crm.derivar("+5213330000000", "147") is True
    assert enviados["cuerpo"]["assigned_salesrep_id"] == "147"
    # Sin la pausa, la bandeja seguiría diciendo que Claudia responde.
    assert enviados["cuerpo"]["ai_autoreply_disabled"] is True


@pytest.mark.asyncio
async def test_sin_representante_reparte_entre_el_equipo(monkeypatch):
    enviados = {}

    async def fake_llamar(metodo, ruta, cuerpo=None):
        enviados.update({"cuerpo": cuerpo})
        return {"data": {"assigned_agent_id": "user-quien-sea"}}

    monkeypatch.setattr(wacrm_crm, "_llamar", fake_llamar)
    assert await wacrm_crm.derivar("+5213330000000", None) is True
    assert enviados["cuerpo"]["assigned_agent_id"] == "auto"
    assert "assigned_salesrep_id" not in enviados["cuerpo"]


@pytest.mark.asyncio
async def test_si_el_crm_falla_no_dice_que_derivo(monkeypatch):
    async def fake_llamar(metodo, ruta, cuerpo=None):
        return None

    monkeypatch.setattr(wacrm_crm, "_llamar", fake_llamar)
    assert await wacrm_crm.derivar("+5213330000000", "147") is False


@pytest.mark.asyncio
async def test_telefono_desconocido_no_revienta(monkeypatch):
    async def fake_llamar(metodo, ruta, cuerpo=None):
        raise AssertionError("no debería llamar al CRM sin conversación")

    monkeypatch.setattr(wacrm_crm, "_llamar", fake_llamar)
    assert await wacrm_crm.derivar("+5219999999999", "147") is False
```

- [ ] **Step 2: Correr y ver que falla**

Run: `python -m pytest tests/test_derivar.py -q`
Expected: FAIL — `AttributeError: module 'agent.wacrm_crm' has no attribute 'derivar'`

- [ ] **Step 3: Implementar**

En `agent/wacrm_crm.py`, junto a `asignar_pendientes_vencidas`:

```python
async def derivar(telefono: str, salesrep_id: str | None) -> bool:
    """Pasa la conversación a una persona. True solo si el CRM lo confirmó.

    Manda también `ai_autoreply_disabled`: el banner de la bandeja se
    pinta mirando esa bandera, no la asignación. Sin ella el equipo vería
    "Claudia IA está respondiendo" en un chat que Claudia ya dejó, y el
    vendedor podría no contestar creyéndose cubierto.

    Devuelve False en vez de lanzar porque quien llama le está hablando a
    un cliente: es mejor decir "se lo paso al equipo" y que alguien lo
    tome a mano, que afirmar una derivación que no ocurrió.
    """
    if not activo():
        return False

    datos = datos_de(telefono)
    if not datos or not datos.get("conversation_id"):
        logger.warning("No hay conversación conocida para %s; no se puede derivar", telefono)
        return False

    cuerpo: dict = {"ai_autoreply_disabled": True}
    if salesrep_id:
        cuerpo["assigned_salesrep_id"] = str(salesrep_id)
    else:
        cuerpo["assigned_agent_id"] = "auto"

    resp = await _llamar("PATCH", f"/api/v1/conversations/{datos['conversation_id']}", cuerpo)

    if not resp:
        # Puede ser un 409 salesrep_not_mapped (el representante no tiene
        # usuario) o un fallo de red. En los dos casos se intenta repartir:
        # es mejor que atienda alguien a que no atienda nadie.
        if salesrep_id:
            logger.warning(
                "No se pudo derivar a %s al representante %s; se reparte entre el equipo",
                telefono, salesrep_id,
            )
            return await derivar(telefono, None)
        logger.warning("No se pudo derivar la conversación de %s", telefono)
        return False

    await marcar_tomada(datos["conversation_id"])
    agente = (resp.get("data") or {}).get("assigned_agent_id")
    logger.info("Conversación de %s derivada a %s", telefono, agente)
    return True
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `python -m pytest tests/test_derivar.py -q`
Expected: PASS, 4 passed

- [ ] **Step 5: Commit**

```bash
git add agent/wacrm_crm.py tests/test_derivar.py
git commit -m "feat: derivar la conversación a un representante o al equipo"
```

---

## Tarea 5b: Exponer la derivación como herramienta de Claudia

**Files:**
- Modify: `agent/tools.py`
- Modify: `agent/brain.py`

**Interfaces:**
- Consumes: `derivar` de la Tarea 5.
- Produces: la herramienta `pasar_con_representante`, que el modelo usa
  cuando el cliente acepta que lo pasen con alguien.

Sin esta tarea el flujo se queda a medias: Claudia sabría decir "¿te paso
con Alejandra?" pero no tendría forma de hacerlo. El comando `/agente`
solo cubre el caso en que el cliente lo pide por su cuenta.

- [ ] **Step 1: Envoltorio en `tools.py`**

```python
async def pasar_con_representante(telefono: str, salesrep_id: str = "") -> dict:
    """Herramienta: entrega la conversación a una persona.

    `salesrep_id` vacío significa "cualquiera del equipo": es lo que toca
    con un cliente nuevo, o cuando su representante en NetSuite es AMBAR
    CARGO, que es la empresa y no una persona.
    """
    from agent import wacrm_crm

    ok = await wacrm_crm.derivar(telefono, salesrep_id or None)
    return {
        "derivado": ok,
        "mensaje": (
            "Listo, ya está con una persona del equipo."
            if ok
            else "No se pudo derivar ahora mismo. Dile que les dejas su caso y "
                 "que lo contactan en cuanto puedan; tú sigues atendiéndolo mientras."
        ),
    }
```

- [ ] **Step 2: Declararla para el modelo**

En la lista de herramientas de `agent/brain.py`:

```python
    {
        "name": "pasar_con_representante",
        "description": (
            "Entrega la conversación a una persona del equipo y tú dejas de "
            "responder. Úsala SOLO cuando el cliente ya dijo que sí quiere "
            "hablar con alguien.
"
            "- Si tiene representante real (es_representante_real true), pasa su "
            "'salesrep_id' para que le toque su propio asesor.
"
            "- Si no lo tiene, o es cliente nuevo, déjalo vacío y se reparte "
            "entre el equipo.
"
            "- Si 'derivado' viene false, NO le digas que ya lo pasaste."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "salesrep_id": {
                    "type": "string",
                    "description": "salesrep_id del representante, de identificar_cliente. Vacío para repartir.",
                }
            },
        },
    },
```

- [ ] **Step 3: Conectarla al despacho**

Esta herramienta necesita el teléfono del cliente, que las demás no usan.
Localiza en `agent/brain.py` cómo se invocan las funciones del mapa y
pásale `telefono` igual que se hace con las herramientas que ya lo
reciben (`agendar_cita`, `ver_mis_citas`). Añade al diccionario:

```python
    "pasar_con_representante": biz_tools.pasar_con_representante,
```

- [ ] **Step 4: Comprobar**

Run: `python -c "import agent.brain"` y `python -m pytest tests/ -q`
Expected: ambos exit 0, 0 failed

- [ ] **Step 5: Commit**

```bash
git add agent/tools.py agent/brain.py
git commit -m "feat: herramienta para que Claudia derive al representante"
```

---

## Tarea 6: El comando `/agente`

**Files:**
- Modify: `agent/conversacion.py`
- Test: `tests/test_comando_agente.py` (crear)

**Interfaces:**
- Consumes: `derivar` de la Tarea 5.
- Produces: `es_peticion_de_humano(texto: str) -> bool`, usada por `atender_mensaje` antes de llamar al modelo.

- [ ] **Step 1: Escribir la prueba que falla**

Crea `tests/test_comando_agente.py`:

```python
import pytest
from agent.conversacion import es_peticion_de_humano


@pytest.mark.parametrize("texto", [
    "/agente",
    " /Agente ",
    "/agente?",
    "/AGENTE",
    "quiero hablar con una persona",
    "pásame con un asesor",
    "me pueden comunicar con un vendedor",
])
def test_reconoce_las_formas_de_pedir_un_humano(texto):
    assert es_peticion_de_humano(texto) is True


@pytest.mark.parametrize("texto", [
    "¿tienen agentes de limpieza?",
    "necesito un polipasto de 3 toneladas",
    "hola",
    "",
])
def test_no_confunde_mensajes_normales(texto):
    assert es_peticion_de_humano(texto) is False
```

- [ ] **Step 2: Correr y ver que falla**

Run: `python -m pytest tests/test_comando_agente.py -q`
Expected: FAIL — `ImportError: cannot import name 'es_peticion_de_humano'`

- [ ] **Step 3: Implementar el reconocedor**

En `agent/conversacion.py`, antes de `atender_mensaje`:

```python
# Frases con las que un cliente pide una persona. El comando con barra es
# jerga de sistemas: se acepta porque se le anuncia, pero cerrarlo solo a
# "/agente" haría que casi nadie lo encontrara.
_PIDE_HUMANO = (
    "hablar con una persona",
    "hablar con alguien",
    "con un asesor",
    "con un vendedor",
    "con un agente",
    "con un humano",
    "comunicar con un",
    "atienda una persona",
)


def es_peticion_de_humano(texto: str) -> bool:
    """¿El cliente está pidiendo que lo atienda una persona?"""
    t = _sin_acentos((texto or "").lower()).strip()
    t = t.strip("¿?¡!.,;: ")
    if t == "/agente":
        return True
    # "agentes de limpieza" no es una petición de humano: se exige que la
    # frase completa aparezca, no solo la palabra "agente".
    return any(frase in t for frase in _PIDE_HUMANO)
```

Si `_sin_acentos` no está en `conversacion.py`, impórtalo de `tools.py`:

```python
from agent.tools import _sin_acentos
```

- [ ] **Step 4: Correr y ver que pasa**

Run: `python -m pytest tests/test_comando_agente.py -q`
Expected: PASS, 11 passed

- [ ] **Step 5: Interceptar antes del modelo**

Al principio de `atender_mensaje`, justo después de recibir `texto`:

```python
    if es_peticion_de_humano(texto):
        # Antes de llamar al modelo: es un comando, no una conversación.
        # Gastar una llamada a Claude para interpretarlo es caro y menos
        # fiable que una comparación de cadenas.
        #
        # Va sin representante (reparto) a propósito: este atajo se salta
        # al modelo, así que no sabe a quién identificó. Cuando el cliente
        # SÍ eligió a su asesor, quien deriva es la herramienta
        # `pasar_con_representante` de la Tarea 5b, que sí lleva el id.
        if await wacrm_crm.derivar(telefono, None):
            return "Con gusto, te paso con una persona del equipo. En un momento te contactan. 🙌"
        return ("Ahora mismo no tengo a nadie disponible para pasarte, "
                "pero les dejo tu caso y te contactan en cuanto puedan. "
                "Mientras tanto, aquí sigo si necesitas algo.")
```

- [ ] **Step 6: Correr toda la suite**

Run: `python -m pytest tests/ -q`
Expected: exit 0, 0 failed (las 200 anteriores más las nuevas)

- [ ] **Step 7: Commit**

```bash
git add agent/conversacion.py tests/test_comando_agente.py
git commit -m "feat: comando /agente para pasar con una persona"
```

---

## Tarea 7: Las instrucciones del flujo en el prompt

**Files:**
- Modify: `config/prompts.yaml`

**Interfaces:**
- Consumes: la herramienta `identificar_cliente` (Tarea 4) y el comando de la Tarea 6.
- Produces: nada que otro código consuma — es la capa conversacional.

- [ ] **Step 1: Añadir la sección al system prompt**

En `config/prompts.yaml`, justo después del bloque `## Cómo presentarte`:

```yaml
  ## A quién tienes enfrente
  Después de saludar, pregúntale si es cliente nuevo o si ya nos compra.
  Una sola pregunta, natural, no un formulario.

  Si dice que ya es cliente: pídele su razón social y búscala con
  `identificar_cliente`. Según lo que te devuelva:
  - Varios candidatos: pregúntale cuál es el suyo. No elijas tú.
  - Uno con representante real: confírmale que lo tienes registrado, dile
    el nombre de su asesor, y pregúntale si prefiere seguir contigo o que
    lo pase con él.
  - Uno sin representante real: NO le menciones representante ninguno.
    Ofrécele seguir contigo o pasar con alguien del equipo.
  - Ninguno: trátalo como cliente nuevo, sin hacerlo sentir mal por no
    estar registrado.

  Si dice que es nuevo: pídele su razón social para registrarlo y
  ofrécele lo mismo — seguir contigo o pasar con alguien del equipo.

  Cuando decida seguir contigo, dile una vez que puede escribir /agente
  cuando quiera para que lo atienda una persona. Una vez, no en cada
  mensaje.

  Dos reglas por encima de todo esto:
  - Si ya te preguntó algo concreto, respóndele PRIMERO. La
    identificación puede esperar al siguiente mensaje, o no pasar.
  - Nunca le recites el RFC. Confirma la razón social y basta: cualquiera
    puede escribir el nombre de una empresa que no es suya.
```

- [ ] **Step 2: Comprobar que el YAML sigue siendo válido**

```bash
python -c "import yaml, io; d = yaml.safe_load(io.open('config/prompts.yaml', encoding='utf-8')); print('claves:', list(d)); print('largo:', len(d['system_prompt']))"
```

Expected: imprime las tres claves y un largo mayor que antes.

- [ ] **Step 3: Correr la suite**

Run: `python -m pytest tests/ -q`
Expected: exit 0, 0 failed

- [ ] **Step 4: Commit**

```bash
git add config/prompts.yaml
git commit -m "feat: instrucciones del flujo de identificación para Claudia"
```

---

## Tarea 8: Prueba de punta a punta contra producción

**Files:**
- Ninguno. Es verificación manual con el sistema desplegado.

- [ ] **Step 1: Desplegar los dos repos**

```bash
cd /d/wacrm && git push origin main
cd /c/Users/odaniel/whatsapp-agentkit && git push origin main
```

Espera a que Dokploy termine ambos (unos 3 min cada uno).

- [ ] **Step 2: Comprobar que siguen en pie**

```bash
curl -s -o /dev/null -w 'CRM %{http_code}\n' https://crm.ambar-apps.cloud/login
curl -s -w ' <- Claudia\n' https://claudia.ambar-apps.cloud/
```

Expected: `CRM 200` y `{"status":"ok","service":"agentkit"}`

- [ ] **Step 3: Probar el flujo desde WhatsApp**

Escribe al número del negocio desde un teléfono que no esté registrado y
comprueba, en orden:

1. Claudia saluda según la hora y pregunta si eres nuevo o habitual.
2. Responde "ya soy cliente" y dale una razón social del catálogo con
   representante real (p. ej. una de Alejandra).
3. Claudia debe confirmar la empresa, nombrar a la asesora y ofrecerte
   elegir. **No debe decir el RFC.**
4. Pide que te pase con ella. La conversación debe aparecer asignada a
   Alejandra en la bandeja y Claudia debe dejar de responder.

- [ ] **Step 4: Probar el camino sin representante**

Repite con una razón social cuyo representante sea AMBAR CARGO. Claudia
**no debe mencionar ningún representante**; solo ofrecer pasar con el
equipo. Al aceptar, debe quedar asignada a alguien por reparto.

- [ ] **Step 5: Probar la vuelta atrás**

En la bandeja, con la conversación asignada, pulsa **Devolver a la IA**.
Escribe otro mensaje desde el teléfono: Claudia debe volver a responder.
