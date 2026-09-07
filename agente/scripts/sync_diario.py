#!/usr/bin/env python3
# scripts/sync_diario.py — Sincronización diaria de NetSuite (multiplataforma)
# Generado por AgentKit

"""
Corre las dos sincronizaciones de NetSuite: catálogo de artículos y roster
de clientes.

POR QUÉ EXISTE ESTE ARCHIVO
---------------------------
Reemplaza a scripts/sync_diario.bat, que solo funciona en Windows: invoca
`C:\\Python313\\python.exe` por ruta absoluta y usa sintaxis de cmd. En el
contenedor Linux de Railway eso no existe. Este script hace lo mismo en
Python puro, así que corre igual en Windows (Task Scheduler) y en Linux
(cron de Railway).

El .bat se conserva para no romper la tarea programada que ya tienes
funcionando; ahora simplemente llama a este archivo.

DIFERENCIA IMPORTANTE CON EL .BAT
---------------------------------
El .bat corría los dos scripts en secuencia sin mirar si el primero falló
(eso ya pasó: el 30/07 el catálogo reventó con un IntegrityError y el .bat
siguió como si nada, dejando la base a medias sin que nadie se enterara).
Aquí cada paso reporta su resultado y el proceso termina con código != 0
si alguno falló — que es lo que cron y Task Scheduler necesitan para poder
avisar de un fallo.

Uso:
    python scripts/sync_diario.py              # ambas sincronizaciones
    python scripts/sync_diario.py --solo catalogo
    python scripts/sync_diario.py --solo clientes
"""

import os
import sys
import time
import logging
import argparse
import importlib
import traceback
from datetime import datetime

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))

LOG_PATH = os.path.join(ROOT_DIR, "logs", "sync_diario.log")

PASOS = {
    "catalogo": ("sync_netsuite_catalogo", "Catálogo de artículos"),
    "clientes": ("sync_netsuite_clientes", "Roster de clientes"),
}


def configurar_log() -> logging.Logger:
    """Escribe a archivo Y a stdout: el archivo sirve en Windows, stdout es
    lo que captura el log de Railway (allá no hay carpeta logs/ persistente)."""
    os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
    log = logging.getLogger("sync_diario")
    log.setLevel(logging.INFO)
    log.handlers.clear()

    # Sin esto cada línea sale DOS veces: los scripts de sincronización
    # llaman a logging.basicConfig(), que le cuelga un handler al logger
    # raíz, y por propagación nuestros mensajes pasan por los dos.
    log.propagate = False

    formato = logging.Formatter("%(asctime)s  %(levelname)-5s %(message)s")

    archivo = logging.FileHandler(LOG_PATH, encoding="utf-8")
    archivo.setFormatter(formato)
    log.addHandler(archivo)

    consola = logging.StreamHandler(sys.stdout)
    consola.setFormatter(formato)
    log.addHandler(consola)

    return log


def importar_modulo(nombre: str):
    """Punto de importación aislado — existe para que los tests puedan
    sustituirlo sin parchear __import__ global (parchearlo rompe hasta
    traceback.format_exc, que usa linecache por dentro)."""
    return importlib.import_module(nombre)


def correr_paso(clave: str, log: logging.Logger) -> bool:
    """Ejecuta una sincronización. True si terminó bien.

    Se importa el módulo y se llama a su main() en vez de lanzar un
    subproceso: así una excepción llega entera al log, con su traceback,
    en lugar de perderse en el código de salida de otro proceso.
    """
    modulo_nombre, etiqueta = PASOS[clave]
    log.info(f"── {etiqueta} ──")
    inicio = time.time()
    try:
        modulo = importar_modulo(modulo_nombre)
        modulo.main()
        log.info(f"{etiqueta}: OK ({time.time() - inicio:.1f}s)")
        return True
    except Exception:
        log.error(f"{etiqueta}: FALLÓ tras {time.time() - inicio:.1f}s")
        for linea in traceback.format_exc().splitlines():
            log.error(f"    {linea}")
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Sincronización diaria de NetSuite")
    parser.add_argument("--solo", choices=sorted(PASOS), default=None,
                        help="correr solo una de las dos sincronizaciones")
    args = parser.parse_args()

    log = configurar_log()
    log.info("=" * 60)
    log.info(f"Sync diario iniciado — {datetime.now():%d/%m/%Y %H:%M:%S}")

    import db as ns_db
    log.info(f"Base de datos: {ns_db.DB_PATH}")

    claves = [args.solo] if args.solo else list(PASOS)
    resultados = {c: correr_paso(c, log) for c in claves}

    fallidos = [PASOS[c][1] for c, ok in resultados.items() if not ok]
    if fallidos:
        log.error(f"Sync diario TERMINÓ CON ERRORES: {', '.join(fallidos)}")
        return 1

    log.info("Sync diario terminado correctamente")
    return 0


if __name__ == "__main__":
    sys.exit(main())
