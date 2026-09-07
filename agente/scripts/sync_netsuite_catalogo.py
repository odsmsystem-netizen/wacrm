#!/usr/bin/env python3
# scripts/sync_netsuite_catalogo.py — Sincroniza catálogo de artículos, sus
# 5 escalas de precio (MXN), existencia y bandera de importado/nacional desde
# NetSuite hacia netsuite_sync.db (SQLite — ver scripts/db.py).
#
# NO se consulta NetSuite en vivo durante la conversación de WhatsApp: este
# script se corre diario a las 7am (ver scripts/sync_diario.bat + Task
# Scheduler) y el agente lee la base local (ver agent/tools.py: consultar_catalogo).
#
# Mismo patrón de autenticación (OAuth1 TBA) que los demás proyectos de
# NetSuite de Ambar Cargo (Indicadores_Ventas_Vendedor, Inventario Ambar
# Netsuite) — puedes reutilizar los mismos tokens.
#
# Uso:
#   1. cp scripts/config.ini.example scripts/config.ini
#   2. Llena scripts/config.ini con tus credenciales de NetSuite (TBA)
#   3. python scripts/sync_netsuite_catalogo.py
#
# Dependencias: pip install requests requests_oauthlib

import os
import re
import sys
import logging
from datetime import datetime, timezone

import requests
from requests_oauthlib import OAuth1

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db as ns_db
import credenciales

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
CONFIG_INI = os.path.join(SCRIPT_DIR, "config.ini")

PAGE_SIZE = 1000
REQUEST_TIMEOUT = 60
_NS_INTENTOS = 3
_NS_ESPERA = 5
SUBSIDIARY_ID = 2  # Ambar Cargo

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("sync_netsuite_catalogo")


def _cargar_config() -> dict:
    """Credenciales de NetSuite: archivo en local, entorno en Railway.

    Antes leia SOLO scripts/config.ini y salia con sys.exit(1) si faltaba.
    Eso rompia el sync en produccion: ese archivo esta en .gitignore (tiene
    los tokens en claro) y `railway up` respeta .gitignore, asi que nunca
    llega al contenedor — el catalogo se quedaba en 0 articulos.
    Ver scripts/credenciales.py.
    """
    try:
        return credenciales.cargar_netsuite(CONFIG_INI)
    except credenciales.CredencialesFaltantes as exc:
        log.error(str(exc))
        sys.exit(1)


def _ns_post(url, **kw):
    """requests.post con reintentos ante fallos transitorios."""
    ultimo = None
    for intento in range(1, _NS_INTENTOS + 1):
        try:
            r = requests.post(url, **kw)
            if r.status_code != 429 and r.status_code < 500:
                return r
            ultimo = f"HTTP {r.status_code}"
        except requests.exceptions.RequestException as exc:
            ultimo = exc
        if intento == _NS_INTENTOS:
            break
        import time
        espera = _NS_ESPERA * (2 ** (intento - 1))
        log.warning(f"NetSuite no respondió ({ultimo}). Reintento {intento}/{_NS_INTENTOS - 1} en {espera}s.")
        time.sleep(espera)
    raise requests.exceptions.ConnectionError(f"Sin respuesta de NetSuite tras {_NS_INTENTOS} intentos: {ultimo}")


def ejecutar_suiteql(cfg: dict, query: str) -> list:
    """Ejecuta SuiteQL paginando por limit/offset hasta traer el 100%."""
    account = cfg["ACCOUNT_ID"]
    auth = OAuth1(
        client_key=cfg["CONSUMER_KEY"],
        client_secret=cfg["CONSUMER_SECRET"],
        resource_owner_key=cfg["TOKEN_ID"],
        resource_owner_secret=cfg["TOKEN_SECRET"],
        realm=account,
        signature_method="HMAC-SHA256",
    )
    host = account.lower().replace("_", "-")
    url = f"https://{host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql"
    headers = {"Content-Type": "application/json", "Prefer": "transient"}

    registros, offset = [], 0
    while True:
        resp = _ns_post(
            url, params={"limit": PAGE_SIZE, "offset": offset},
            json={"q": query}, auth=auth, headers=headers, timeout=REQUEST_TIMEOUT,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"NetSuite respondió {resp.status_code}: {resp.text[:500]}")
        payload = resp.json()
        lote = payload.get("items", [])
        registros.extend(lote)
        log.info(f"  offset={offset} filas={len(lote)} acumulado={len(registros)}/{payload.get('totalResults', '?')}")
        if not payload.get("hasMore", False):
            break
        offset += PAGE_SIZE
    return registros


# Mapeo real de escalas de precio en esta cuenta de NetSuite (moneda MXN,
# currency=1). Confirmado por consulta directa: NO son consecutivos (falta
# el 5). Si NetSuite agrega/renombra escalas, vuelve a correr:
#   SELECT DISTINCT pr.pricelevel, BUILTIN.DF(pr.pricelevel)
#   FROM pricing pr WHERE pr.currency = 1
ESCALAS = {
    "Escala 1": 2,
    "Escala 2": 3,
    "Escala 3": 4,
    "Escala 4": 6,
    "Escala 5": 7,
}
# Tokens que delatan el origen del artículo en el nombre de NetSuite. Se
# quitan del nombre que ve el cliente: Claudia confirma disponibilidad y
# precio, nunca si es importado o nacional.
_RE_ORIGEN = re.compile(r"\b(IMPORTADO|IMP\.?|NACIONAL|NAL\.?)\b\s*", re.IGNORECASE)


def nombre_cliente(nombre_ns: str) -> str:
    """Nombre del artículo sin revelar si es importado o nacional."""
    limpio = _RE_ORIGEN.sub("", nombre_ns or "").strip()
    return re.sub(r"\s{2,}", " ", limpio) or nombre_ns


def sql_catalogo() -> str:
    """
    Artículos activos con: código, nombre, tipo/grupo/línea de clasificación
    (mismos campos custitem_imr_* que usa Inventario Ambar Netsuite — ver
    memoria del proyecto hermano), si requiere importación, y su precio en
    CADA una de las 5 escalas (MXN). Un LEFT JOIN por escala: el join a
    pricing es 1:1 por (item, pricelevel, currency), no multiplica filas.
    """
    joins = "\n".join(
        f"LEFT JOIN pricing pr{i} ON pr{i}.item = i.id AND pr{i}.pricelevel = {pid} AND pr{i}.currency = 1"
        for i, pid in enumerate(ESCALAS.values())
    )
    campos = ",\n    ".join(
        f"pr{i}.unitprice AS precio_{nombre.lower().replace(' ', '_')}"
        for i, nombre in enumerate(ESCALAS.keys())
    )
    return f"""
SELECT
    i.id                                        AS item_id,
    i.itemid                                     AS codigo,
    i.displayname                                AS nombre,
    BUILTIN.DF(i.custitem_imr_tipo_articulos)    AS tipo,
    BUILTIN.DF(i.custitem_imr_grupo_articulos)   AS grupo,
    BUILTIN.DF(i.custitem_imr_linea_articulos)   AS linea,
    i.custitem_requerir_ped_importacion          AS importado,
    {campos}
FROM item i
{joins}
WHERE i.isinactive = 'F'
-- ORDER BY UNICO Y DETERMINISTA: i.id es la clave interna, garantizada
-- unica y estable entre paginas. Ordenar por i.itemid (el codigo visible)
-- puede no ser estable entre llamadas paginadas y duplicar/saltar renglones
-- en el borde de una pagina (visto en la practica con AIR1000MO).
ORDER BY i.id
"""


def sql_existencias(sub: int) -> str:
    """Existencia DISPONIBLE total por artículo (suma de todos los almacenes
    de la subsidiaria), agregada aquí para no fan-out la consulta principal."""
    return f"""
SELECT
    ib.item                       AS item_id,
    SUM(NVL(ib.quantityavailable, 0)) AS disponible
FROM inventorybalance ib
INNER JOIN locationsubsidiarymap lsm ON lsm.location = ib.location
WHERE lsm.subsidiary = {sub}
GROUP BY ib.item
ORDER BY ib.item
"""


def main():
    cfg = _cargar_config()

    log.info("Consultando catálogo de artículos en NetSuite...")
    filas = ejecutar_suiteql(cfg, sql_catalogo())

    log.info("Consultando existencias en NetSuite...")
    filas_stock = ejecutar_suiteql(cfg, sql_existencias(SUBSIDIARY_ID))
    stock_por_item = {str(f["item_id"]): float(f.get("disponible") or 0) for f in filas_stock}

    filas_db = []
    for f in filas:
        item_id = str(f.get("item_id"))
        nombre_ns = f.get("nombre", "")
        precios = {}
        for nombre_escala in ESCALAS:
            clave = f"precio_{nombre_escala.lower().replace(' ', '_')}"
            valor = f.get(clave)
            precios[nombre_escala] = float(valor) if valor not in (None, "") else None

        filas_db.append((
            f.get("codigo", ""), item_id,
            nombre_cliente(nombre_ns),  # nombre que ve el CLIENTE, sin IMPORTADO/NACIONAL
            nombre_ns,                  # nombre_interno: crudo, solo uso interno
            f.get("tipo", ""), f.get("grupo", ""), f.get("linea", ""),
            1 if str(f.get("importado", "")).upper() == "T" else 0,
            stock_por_item.get(item_id, 0.0),
            precios["Escala 1"], precios["Escala 2"], precios["Escala 3"],
            precios["Escala 4"], precios["Escala 5"],
        ))

    con = ns_db.conectar()
    with con:
        con.execute("DELETE FROM articulos")
        con.executemany(
            "INSERT INTO articulos (codigo, item_id, nombre, nombre_interno, tipo, grupo, linea, "
            "importado, existencia, precio_escala_1, precio_escala_2, precio_escala_3, "
            "precio_escala_4, precio_escala_5) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            filas_db,
        )
        ns_db.set_meta(con, "articulos_actualizado", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    con.close()

    log.info(f"Catálogo sincronizado: {len(filas_db)} artículos -> {ns_db.DB_PATH}")


if __name__ == "__main__":
    main()
