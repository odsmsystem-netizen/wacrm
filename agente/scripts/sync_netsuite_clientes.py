#!/usr/bin/env python3
# scripts/sync_netsuite_clientes.py — Sincroniza el roster de clientes de
# NetSuite (nombre, RFC, vendedor asignado) hacia netsuite_sync.db (SQLite).
#
# Se usa para que Claudia pueda reconocer si quien le escribe YA es cliente
# de Ambar Cargo y de qué vendedor es cartera — sin consultar NetSuite en
# vivo durante la conversación (ver agent/tools.py: verificar_cliente_existente).
#
# Uso:
#   python scripts/sync_netsuite_clientes.py
# (usa las mismas credenciales de scripts/config.ini que sync_netsuite_catalogo.py)

import os
import sys
import logging
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import db as ns_db
from sync_netsuite_catalogo import _cargar_config, ejecutar_suiteql

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("sync_netsuite_clientes")


def sql_clientes() -> str:
    """
    Roster de clientes activos con su RFC y el vendedor (salesrep) al que
    pertenecen. isperson=F y T ambos se incluyen (empresa o persona física),
    companyname/entityid cubren ambos casos vía altname.
    """
    return """
SELECT
    c.id                        AS netsuite_id,
    c.altname                   AS nombre,
    c.custentity_ce_rfc         AS rfc,
    c.salesrep                  AS salesrep_id,
    e.entityid                  AS salesrep_nombre
FROM customer c
LEFT JOIN employee e ON e.id = c.salesrep
WHERE c.isinactive = 'F'
  AND c.altname IS NOT NULL
ORDER BY c.id
"""


def main():
    cfg = _cargar_config()
    log.info("Consultando roster de clientes en NetSuite...")
    filas = ejecutar_suiteql(cfg, sql_clientes())

    filas_db = []
    for f in filas:
        nombre = f.get("nombre") or ""
        rfc = f.get("rfc") or ""
        filas_db.append((
            str(f.get("netsuite_id")), nombre, ns_db.normalizar(nombre),
            rfc, ns_db.normalizar(rfc),
            str(f.get("salesrep_id")) if f.get("salesrep_id") else None,
            f.get("salesrep_nombre") or "",
        ))

    con = ns_db.conectar()
    with con:
        con.execute("DELETE FROM clientes")
        con.executemany(
            "INSERT INTO clientes (netsuite_id, nombre, nombre_normalizado, rfc, "
            "rfc_normalizado, salesrep_id, salesrep_nombre) VALUES (?,?,?,?,?,?,?)",
            filas_db,
        )
        ns_db.set_meta(con, "clientes_actualizado", datetime.now(timezone.utc).isoformat(timespec="seconds"))
    con.close()

    log.info(f"Clientes sincronizados: {len(filas_db)} -> {ns_db.DB_PATH}")


if __name__ == "__main__":
    main()
