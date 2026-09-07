# scripts/credenciales.py — Credenciales de NetSuite: archivo o entorno
# Generado por AgentKit

"""
Un solo lugar para cargar las credenciales de NetSuite (TBA).

POR QUE EXISTE
--------------
El proyecto tenia DOS mecanismos para las mismas credenciales:

    agent/netsuite_client.py    -> os.getenv("NETSUITE_*")
    scripts/sync_netsuite_*.py  -> scripts/config.ini

En local los dos funcionan y la diferencia pasa desapercibida. En Railway
no: config.ini tiene los tokens en claro, esta en .gitignore, y
`railway up` respeta .gitignore — asi que el archivo nunca llega al
contenedor. El agente podia consultar NetSuite pero el sync no, y el
catalogo se quedaba en 0 articulos y 0 clientes, dejando a Claudia sin
nada que cotizar.

ORDEN DE BUSQUEDA
-----------------
  1. scripts/config.ini   — si existe. Es lo que el usuario edita a mano,
                            asi que manda cuando esta presente (local).
  2. Variables de entorno — NETSUITE_ACCOUNT_ID, NETSUITE_CONSUMER_KEY,
                            NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID,
                            NETSUITE_TOKEN_SECRET. Es como viajan los
                            demas secretos a produccion (Twilio, Anthropic).

Si no hay ninguna de las dos, lanza CredencialesFaltantes diciendo QUE
falta — no un 401 de NetSuite tres capas mas abajo, que no dice nada.
"""

import os
import configparser

CLAVES_REQUERIDAS = (
    "ACCOUNT_ID",
    "CONSUMER_KEY",
    "CONSUMER_SECRET",
    "TOKEN_ID",
    "TOKEN_SECRET",
)

SUBSIDIARY_POR_DEFECTO = "2"  # Ambar Cargo


class CredencialesFaltantes(RuntimeError):
    """No hay credenciales de NetSuite ni en archivo ni en entorno."""


def _del_archivo(ruta_ini: str) -> dict:
    """Lee la seccion [netsuite] del ini. Dict vacio si no sirve."""
    if not os.path.exists(ruta_ini):
        return {}
    cfg = configparser.ConfigParser()
    try:
        cfg.read(ruta_ini, encoding="utf-8")
    except configparser.Error:
        return {}
    if not cfg.has_section("netsuite"):
        return {}
    seccion = cfg["netsuite"]
    return {c: seccion.get(c, "").strip() for c in CLAVES_REQUERIDAS + ("SUBSIDIARY_ID",)
            if seccion.get(c, "").strip()}


def _del_entorno() -> dict:
    valores = {}
    for c in CLAVES_REQUERIDAS + ("SUBSIDIARY_ID",):
        v = (os.getenv(f"NETSUITE_{c}") or "").strip()
        if v:
            valores[c] = v
    return valores


def cargar_netsuite(ruta_ini: str = None) -> dict:
    """Devuelve las credenciales. Lanza CredencialesFaltantes si estan incompletas.

    El archivo gana sobre el entorno: en local es lo que el usuario edita
    y espera que mande. En produccion el archivo no existe y todo sale del
    entorno.
    """
    if ruta_ini is None:
        ruta_ini = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.ini")

    valores = _del_entorno()
    valores.update(_del_archivo(ruta_ini))  # el archivo pisa al entorno

    faltan = [c for c in CLAVES_REQUERIDAS if not valores.get(c)]
    if faltan:
        raise CredencialesFaltantes(
            "Credenciales de NetSuite incompletas — faltan: "
            + ", ".join(faltan)
            + ".\n"
            "  En local:     copia scripts/config.ini.example a scripts/config.ini "
            "y llena los valores.\n"
            "  En Railway:   configura las variables NETSUITE_ACCOUNT_ID, "
            "NETSUITE_CONSUMER_KEY, NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID "
            "y NETSUITE_TOKEN_SECRET."
        )

    valores.setdefault("SUBSIDIARY_ID", SUBSIDIARY_POR_DEFECTO)
    return valores
