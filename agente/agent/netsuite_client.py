# agent/netsuite_client.py — Cliente NetSuite para el agente EN VIVO
# Generado por AgentKit

"""
A diferencia de scripts/sync_netsuite_catalogo.py (que corre periódicamente
y NO se usa durante la conversación), este módulo SÍ se llama en vivo, pero
solo para UNA cosa: generar la cotización (Estimate) cuando el cliente ya
aceptó un precio. No se usa para consultar catálogo ni precios — eso sigue
viniendo del archivo sincronizado, para no depender de NetSuite en cada
mensaje.

Credenciales: variables NETSUITE_* en .env (mismos tokens que
scripts/config.ini, reutilizados de Indicadores_Ventas_Vendedor).
"""

import os
import re
import logging
import requests
from requests_oauthlib import OAuth1
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("agentkit")

REQUEST_TIMEOUT = 30


def _config_lista() -> bool:
    return all([
        os.getenv("NETSUITE_ACCOUNT_ID"), os.getenv("NETSUITE_CONSUMER_KEY"),
        os.getenv("NETSUITE_CONSUMER_SECRET"), os.getenv("NETSUITE_TOKEN_ID"),
        os.getenv("NETSUITE_TOKEN_SECRET"),
    ])


def _auth_y_base():
    account = os.getenv("NETSUITE_ACCOUNT_ID", "")
    auth = OAuth1(
        client_key=os.getenv("NETSUITE_CONSUMER_KEY"),
        client_secret=os.getenv("NETSUITE_CONSUMER_SECRET"),
        resource_owner_key=os.getenv("NETSUITE_TOKEN_ID"),
        resource_owner_secret=os.getenv("NETSUITE_TOKEN_SECRET"),
        realm=account,
        signature_method="HMAC-SHA256",
    )
    host = account.lower().replace("_", "-")
    base = f"https://{host}.suitetalk.api.netsuite.com/services/rest"
    return auth, base


def suiteql(query: str, limit: int = 100) -> list:
    """Consulta SuiteQL puntual (una sola página — para lookups chicos, no
    para catálogos completos; eso lo hace scripts/sync_netsuite_catalogo.py)."""
    if not _config_lista():
        raise RuntimeError("Faltan variables NETSUITE_* en .env")
    auth, base = _auth_y_base()
    r = requests.post(
        f"{base}/query/v1/suiteql", params={"limit": limit, "offset": 0},
        json={"q": query}, auth=auth,
        headers={"Content-Type": "application/json", "Prefer": "transient"},
        timeout=REQUEST_TIMEOUT,
    )
    if r.status_code != 200:
        raise RuntimeError(f"NetSuite SuiteQL {r.status_code}: {r.text[:400]}")
    return r.json().get("items", [])


def crear_registro(tipo: str, cuerpo: dict) -> str:
    """POST a /record/v1/{tipo}. Retorna el internal id del registro creado."""
    if not _config_lista():
        raise RuntimeError("Faltan variables NETSUITE_* en .env")
    auth, base = _auth_y_base()
    r = requests.post(
        f"{base}/record/v1/{tipo}", json=cuerpo, auth=auth,
        headers={"Content-Type": "application/json"}, timeout=REQUEST_TIMEOUT,
    )
    if r.status_code not in (200, 201, 204):
        raise RuntimeError(f"NetSuite crear_registro({tipo}) {r.status_code}: {r.text[:500]}")
    # NetSuite devuelve el id nuevo en el header Location, no en el body.
    location = r.headers.get("Location", "")
    if "/" in location:
        return location.rstrip("/").split("/")[-1]
    raise RuntimeError(f"NetSuite no devolvió Location al crear {tipo}: headers={dict(r.headers)}")


# Nombre EXACTO del customer que hay que crear una sola vez, A MANO, en
# NetSuite (con sus datos fiscales correctos — RFC, Régimen Fiscal, Forma y
# Método de pago). Claudia NUNCA crea customers: NetSuite exige varios campos
# de cumplimiento fiscal mexicano (CFDI) para guardar un Customer nuevo, y
# adivinarlos por API es un riesgo real si ese registro se llegara a usar
# para facturar. Se decidió que un humano lo dé de alta una única vez.
_CUSTOMER_GENERICO_NOMBRE = "LEADS WHATSAPP AMBAR CARGO"

# Forma que puede tener un codigo de articulo de NetSuite: letras, numeros
# y los separadores que usa el catalogo. Deja fuera comillas, punto y coma
# y espacios de mas — todo lo que haria falta para salirse de la cadena
# entre comillas de la consulta.
_CODIGO_ITEM_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,79}$")
_customer_generico_id_cache = None


def obtener_customer_generico() -> str:
    """
    Todas las cotizaciones generadas por Claudia se cargan sobre UN customer
    genérico en NetSuite (decisión de negocio: no crear un Customer nuevo por
    cada conversación de WhatsApp). Los datos reales del cliente van en el
    memo del Estimate. Se busca una sola vez y se cachea en memoria del proceso.

    Si no existe, lanza un error claro: hay que crearlo A MANO en NetSuite
    (Lists > Customers > New) con el nombre exacto de _CUSTOMER_GENERICO_NOMBRE
    y sus datos fiscales (RFC, Régimen Fiscal, Forma/Método de pago) — no se
    crea automáticamente por API.
    """
    global _customer_generico_id_cache
    if _customer_generico_id_cache:
        return _customer_generico_id_cache

    filas = suiteql(
        f"SELECT id FROM customer WHERE companyname = '{_CUSTOMER_GENERICO_NOMBRE}'", limit=1
    )
    if not filas:
        raise RuntimeError(
            f"No existe el customer '{_CUSTOMER_GENERICO_NOMBRE}' en NetSuite. "
            f"Créalo a mano (Lists > Customers > New) con sus datos fiscales "
            f"correctos (RFC, Régimen Fiscal, Forma y Método de pago) antes de "
            f"generar cotizaciones."
        )
    _customer_generico_id_cache = str(filas[0]["id"])
    return _customer_generico_id_cache


def crear_estimate(items: list, memo: str) -> dict:
    """
    Crea un Estimate (cotización) en NetSuite sobre el customer genérico de
    leads de WhatsApp.

    Args:
        items: [{"item_id": <internal id de NetSuite>, "cantidad": float, "precio": float}, ...]
        memo: texto con los datos reales del cliente y quién lo atendió.

    Returns:
        {"ok": True, "estimate_id": "..."} o {"ok": False, "error": "..."}
    """
    try:
        customer_id = obtener_customer_generico()
        subsidiary = os.getenv("NETSUITE_SUBSIDIARY_ID", "2")
        cuerpo = {
            "entity": {"id": customer_id},
            "subsidiary": {"id": subsidiary},
            "memo": memo,
            "item": {"items": [
                {"item": {"id": it["item_id"]}, "quantity": it["cantidad"], "rate": it["precio"]}
                for it in items
            ]},
        }
        estimate_id = crear_registro("estimate", cuerpo)
        return {"ok": True, "estimate_id": estimate_id}
    except Exception as exc:
        logger.exception("Error creando Estimate en NetSuite")
        return {"ok": False, "error": str(exc)}


def crear_oportunidad(items: list, memo: str, titulo: str) -> dict:
    """
    Crea un Opportunity en NetSuite sobre el customer genérico de leads de
    WhatsApp — es lo que se genera para un LEAD NUEVO (cliente que no está
    dado de alta todavía). Si ya es cliente conocido, NO se crea nada aquí:
    se canaliza directo a su vendedor (ver agent/tools.py).

    Args:
        items: [{"item_id": <internal id de NetSuite>, "cantidad": float, "precio": float}, ...]
        memo: texto con los datos reales del cliente y quién lo atendió.
        titulo: título corto de la oportunidad (ej. con el nombre del cliente).

    Returns:
        {"ok": True, "opportunity_id": "..."} o {"ok": False, "error": "..."}
    """
    try:
        customer_id = obtener_customer_generico()
        subsidiary = os.getenv("NETSUITE_SUBSIDIARY_ID", "2")
        cuerpo = {
            "entity": {"id": customer_id},
            "subsidiary": {"id": subsidiary},
            "title": titulo,
            "memo": memo,
            "item": {"items": [
                {"item": {"id": it["item_id"]}, "quantity": it["cantidad"], "rate": it["precio"]}
                for it in items
            ]},
        }
        opportunity_id = crear_registro("opportunity", cuerpo)

        # El folio (tranid) es el número que la gente usa: es lo que ve el
        # cliente, lo que busca el vendedor en NetSuite y lo que aparece
        # impreso. El id interno es de la base de datos y no le sirve a
        # nadie fuera del sistema. Al crear, NetSuite solo devuelve el id
        # interno, así que el folio se consulta aparte.
        folio = None
        try:
            filas = suiteql(
                f"SELECT tranid FROM transaction WHERE id = {int(opportunity_id)}",
                limit=1,
            )
            if filas:
                folio = str(filas[0]["tranid"])
        except Exception:
            # La oportunidad YA está creada: si el folio no se puede leer,
            # se sigue sin él. Perder la cotización por no poder mostrar su
            # número sería absurdo.
            logger.warning(
                "Opportunity %s creada, pero no se pudo leer su folio",
                opportunity_id,
            )

        return {"ok": True, "opportunity_id": opportunity_id, "folio": folio}
    except Exception as exc:
        logger.exception("Error creando Opportunity en NetSuite")
        return {"ok": False, "error": str(exc)}


def buscar_item_id(codigo: str):
    """Resuelve el internal id de NetSuite de un artículo por su código
    (itemid). Necesario porque el catálogo local no guarda el internal id
    de forma consistente para todos los flujos — se resuelve al vuelo, una
    sola vez por cotización, no por cada mensaje."""
    # El endpoint REST de SuiteQL solo acepta el campo `q`: no admite
    # parámetros vinculados (comprobado — responde 400 INVALID_CONTENT si
    # se le manda `params`). Como no se puede parametrizar, se valida la
    # entrada con lista blanca antes de construir la consulta.
    #
    # `codigo` lo arma el modelo a partir de lo que dijo el cliente, así
    # que aunque casi siempre sea un código del catálogo, no es una
    # entrada de confianza. Duplicar comillas sola es frágil: basta que
    # alguien toque esta línea y olvide el escape.
    if not _CODIGO_ITEM_OK.match(codigo or ""):
        logger.warning("Código de artículo con formato inesperado, no se busca: %r", codigo)
        return None
    filas = suiteql(f"SELECT id FROM item WHERE itemid = '{codigo}'", limit=1)
    return str(filas[0]["id"]) if filas else None
