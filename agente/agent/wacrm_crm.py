# agent/wacrm_crm.py — Lo que Claudia sabe y hace en el CRM

"""
Dos cosas que el proveedor de mensajes no cubre:

1. **Quién es quién.** Claudia razona en teléfonos; el CRM en ids de
   contacto y de conversación. El sondeo ya ve ambos cada vuelta, así que
   los apunta aquí y las herramientas los consultan cuando los necesitan
   — sin tener que buscar el contacto otra vez por teléfono.

2. **Registrar la cotización y repartir el chat.** Cuando Claudia termina
   de cotizar, la cotización debe aparecer en el panel del contacto, y si
   nadie toma la conversación en un rato, asignarla sola.

El estado vive en memoria a propósito: es una foto de lo que está pasando
ahora, no un registro. Si Claudia se reinicia se pierde, y está bien —
el sondeo vuelve a llenarlo en la primera vuelta, y una cotización de
hace media hora que nadie tomó no debería asignarse de golpe al arrancar.
"""

import asyncio
import logging
import os
import time
import httpx

logger = logging.getLogger("agentkit")

_TIMEOUT = 20.0

# Segundos que se le dan a una persona para tomar la conversación antes
# de asignarla automáticamente. 30 s es un valor de pruebas; en operación
# real conviene bastante más — es el tiempo que tiene un vendedor para
# reaccionar antes de que el sistema decida por él.
def _segundos_para_asignar() -> float:
    try:
        return float(os.getenv("WACRM_ASIGNAR_TRAS_SEGUNDOS", "30"))
    except ValueError:
        return 30.0


# telefono -> {"conversation_id": str, "contact_id": str}
_conversaciones: dict[str, dict] = {}

# conversation_id -> {"telefono": str, "cotizado_en": float}
# Solo entra aquí lo que Claudia cotizó y sigue sin dueño.
_pendientes: dict[str, dict] = {}

_candado = asyncio.Lock()


def _config() -> tuple[str, str]:
    return (
        os.getenv("WACRM_URL", "").rstrip("/"),
        os.getenv("WACRM_API_KEY", "").strip(),
    )


def activo() -> bool:
    """True si Claudia está operando a través del CRM."""
    url, key = _config()
    return bool(url and key) and os.getenv("WHATSAPP_PROVIDER", "").lower().strip() == "wacrm"


def recordar(telefono: str, conversation_id: str, contact_id: str) -> None:
    """Lo llama el sondeo en cada mensaje que atiende."""
    _conversaciones[telefono] = {
        "conversation_id": conversation_id,
        "contact_id": contact_id,
    }


def datos_de(telefono: str) -> dict | None:
    """Ids del CRM para ese teléfono, o None si no se ha visto."""
    return _conversaciones.get(telefono)


async def _llamar(metodo: str, ruta: str, cuerpo: dict | None = None) -> dict | None:
    url, key = _config()
    if not (url and key):
        return None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as c:
            r = await c.request(
                metodo,
                f"{url}{ruta}",
                json=cuerpo,
                headers={"Authorization": f"Bearer {key}"},
            )
    except Exception as e:
        logger.error(f"No se pudo llamar al CRM ({metodo} {ruta}): {e}")
        return None

    if r.status_code in (200, 201):
        return r.json()

    # 403 casi siempre significa que a la clave le falta un permiso. Se
    # nombra el que corresponde a ESTA ruta: decir "revisa los scopes" a
    # secas manda a buscar entre siete, y nombrar el equivocado es peor
    # todavía — se descarta el correcto por creerlo ya revisado.
    if r.status_code == 403:
        if "/deals" in ruta:
            falta = "deals:write"
        elif "/conversations/" in ruta and metodo == "PATCH":
            falta = "conversations:write"
        elif "/contacts/" in ruta:
            falta = "contacts:read y contacts:write"
        else:
            falta = "el scope de esta ruta"
        logger.error(
            f"El CRM rechazó {metodo} {ruta} por permisos (403). "
            f"A la clave le falta {falta}."
        )
    else:
        logger.error(f"El CRM respondió {r.status_code} a {metodo} {ruta}: {r.text[:200]}")
    return None


async def registrar_cotizacion(telefono: str, titulo: str, importe: float) -> bool:
    """Crea la cotización en el panel del contacto y deja la conversación
    en espera de que alguien la tome.

    Devuelve False si no se pudo, sin lanzar: la cotización YA está en
    NetSuite y el cliente ya tiene su folio, así que no poder reflejarla
    en el CRM es un problema de visibilidad, no una razón para tumbar la
    respuesta al cliente.
    """
    if not activo():
        return False

    datos = datos_de(telefono)
    if not datos:
        logger.warning(
            f"No sé qué contacto del CRM es {telefono}; la cotización no se "
            "reflejará en el panel. (Pasa si el mensaje no vino del sondeo.)"
        )
        return False

    resp = await _llamar("POST", "/api/v1/deals", {
        "contact_id": datos["contact_id"],
        "conversation_id": datos["conversation_id"],
        "title": titulo,
        "value": round(float(importe), 2),
    })
    if not resp:
        return False

    async with _candado:
        _pendientes[datos["conversation_id"]] = {
            "telefono": telefono,
            "cotizado_en": time.monotonic(),
        }

    logger.info(f"Cotización registrada en el CRM para {telefono}: {titulo}")
    return True


async def etiquetar(telefono: str, etiquetas: list[str]) -> bool:
    """Reemplaza las etiquetas del contacto en el CRM.

    OJO: la API las reemplaza, no las suma. Se leen las que ya tiene y se
    añaden las nuevas, para no borrar lo que alguien puso a mano.
    """
    if not activo() or not etiquetas:
        return False
    datos = datos_de(telefono)
    if not datos:
        return False

    actuales: list[str] = []
    previo = await _llamar("GET", f"/api/v1/contacts/{datos['contact_id']}")
    if previo:
        actuales = [t.get("name") for t in (previo.get("data", {}).get("tags") or []) if t.get("name")]

    unidas = list(dict.fromkeys([*actuales, *etiquetas]))
    if unidas == actuales:
        return True

    resp = await _llamar("PATCH", f"/api/v1/contacts/{datos['contact_id']}", {"tags": unidas})
    return resp is not None


async def asignar_pendientes_vencidas() -> None:
    """Reparte las conversaciones cotizadas que nadie tomó a tiempo.

    La llama el sondeo en cada vuelta, así que el retraso real es de unos
    segundos más que el plazo configurado — suficiente para lo que hace, y
    sin necesitar un cron ni una cola: el bucle del sondeo ya está vivo.
    """
    if not activo() or not _pendientes:
        return

    plazo = _segundos_para_asignar()
    ahora = time.monotonic()

    async with _candado:
        vencidas = [
            (cid, info) for cid, info in _pendientes.items()
            if ahora - info["cotizado_en"] >= plazo
        ]
        # Se sacan de la lista ANTES de llamar al CRM: si la llamada
        # falla, es preferible no reintentar en bucle cada 5 segundos
        # contra un CRM que ya dijo que no. Queda en el log y una persona
        # la toma a mano, que es lo que habría pasado igual.
        for cid, _ in vencidas:
            _pendientes.pop(cid, None)

    for cid, info in vencidas:
        resp = await _llamar("PATCH", f"/api/v1/conversations/{cid}", {
            "assigned_agent_id": "auto",
        })
        if resp:
            agente = (resp.get("data") or {}).get("assigned_agent_id")
            logger.info(
                f"Nadie tomó la conversación de {info['telefono']} en {plazo:.0f}s; "
                f"asignada automáticamente a {agente}"
            )
        else:
            logger.warning(
                f"No se pudo asignar automáticamente la conversación de "
                f"{info['telefono']}. Hay que tomarla a mano en la bandeja."
            )


async def marcar_tomada(conversation_id: str) -> None:
    """Alguien la tomó por su cuenta: ya no hay que asignarla."""
    async with _candado:
        _pendientes.pop(conversation_id, None)
