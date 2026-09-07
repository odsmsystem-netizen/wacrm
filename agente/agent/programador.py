# agent/programador.py — Sync diario de NetSuite como tarea de fondo
# Generado por AgentKit

"""
Corre la sincronizacion de NetSuite una vez al dia, desde el propio proceso.

POR QUE AQUI Y NO EN UN CRON
----------------------------
En Windows esto lo dispara el Task Scheduler (tarea
"AgentKit_Ambar_SyncDiario"). En Railway no hay Task Scheduler, y el CLI
no expone el cron: habria que configurarlo a mano en el dashboard y
levantar un SEGUNDO servicio con su propio montaje del volumen, lo que
duplica el costo mensual. Para el volumen de Ambar Cargo no se justifica.

COMO SABE SI YA CORRIO
----------------------
No lleva un contador propio. Lee la marca 'articulos_actualizado' que el
propio sync deja en la tabla meta de netsuite_sync.db — que vive en el
volumen persistente. Eso lo hace idempotente entre reinicios: si el
contenedor se reinicia tres veces en una tarde, no sincroniza tres veces.

MODO DE FALLO
-------------
Si el proceso muere, el sync no corre (mismo punto ciego que el vigilante
del tunel). Railway reinicia el contenedor ante fallos, y al arrancar este
programador comprueba si hoy ya se sincronizo — asi que un reinicio se
pone al corriente solo. Ademas siempre queda el boton de sincronizar del
panel /admin.
"""

import os
import sys
import asyncio
import logging
from datetime import datetime

logger = logging.getLogger("agentkit")

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

HORA_POR_DEFECTO = 7          # 7:00 — misma hora que la tarea de Windows
INTERVALO_REVISION = 900      # revisar cada 15 min si ya toca
TIMEOUT_SYNC = 600            # 10 min: el sync completo tarda ~30s


def programador_activo() -> bool:
    """SYNC_PROGRAMADO_ENABLED=false lo apaga sin tocar codigo."""
    return (os.getenv("SYNC_PROGRAMADO_ENABLED", "true") or "").strip().lower() not in (
        "false", "0", "no", "off"
    )


def hora_objetivo() -> int:
    """Hora del dia (0-23) a la que debe correr. Un valor mal escrito cae
    al default en vez de dejar el sync sin correr nunca."""
    crudo = (os.getenv("SYNC_PROGRAMADO_HORA") or "").strip()
    if not crudo:
        return HORA_POR_DEFECTO
    try:
        h = int(crudo)
    except ValueError:
        logger.warning(f"SYNC_PROGRAMADO_HORA invalida ({crudo!r}), se usa {HORA_POR_DEFECTO}")
        return HORA_POR_DEFECTO
    if not 0 <= h <= 23:
        logger.warning(f"SYNC_PROGRAMADO_HORA fuera de rango ({h}), se usa {HORA_POR_DEFECTO}")
        return HORA_POR_DEFECTO
    return h


def interpretar_marca(valor: str | None) -> datetime | None:
    """Convierte la marca ISO de la tabla meta a datetime naive local.

    Una marca ilegible se trata como 'nunca sincronizado' en vez de tumbar
    el programador: peor que sincronizar de mas es no sincronizar nunca.
    """
    if not valor:
        return None
    try:
        d = datetime.fromisoformat(str(valor))
    except (ValueError, TypeError):
        logger.warning(f"marca de sincronizacion ilegible: {valor!r}")
        return None
    # CONVERTIR, no truncar: la marca viene en UTC y debe_correr la compara
    # contra datetime.now(), que es hora local. Quitarle la zona sin
    # convertir deja las dos fechas en husos distintos. Mientras el
    # contenedor corrio en UTC daba igual (mismo reloj); con
    # TZ=America/Mexico_City no: un sync de las 19:00 de Mexico se guarda
    # como 01:00 UTC del dia SIGUIENTE, y truncado haria que el programador
    # creyera que ya sincronizo manana — saltandose el sync de ese dia.
    return d.astimezone().replace(tzinfo=None) if d.tzinfo else d


def debe_correr(ultima: datetime | None, ahora: datetime, hora_objetivo: int) -> bool:
    """¿Toca sincronizar?

    Dos condiciones, ambas necesarias:
      1. Ya paso la hora objetivo de hoy.
      2. Hoy todavia no se ha sincronizado.

    La segunda es la critica: el bucle despierta cada 15 minutos, y sin
    ella traeria ~12,000 filas de NetSuite en cada vuelta.
    """
    if ahora.hour < hora_objetivo:
        return False
    if ultima is not None and ultima.date() >= ahora.date():
        return False
    return True


def leer_ultima_sincronizacion() -> datetime | None:
    """Marca que dejo el ultimo sync en la tabla meta del volumen."""
    try:
        sys.path.insert(0, os.path.join(ROOT_DIR, "scripts"))
        import db as ns_db
        con = ns_db.conectar()
        try:
            return interpretar_marca(ns_db.get_meta(con, "articulos_actualizado"))
        finally:
            con.close()
    except Exception as e:
        logger.warning(f"no pude leer la ultima sincronizacion: {type(e).__name__}: {e}")
        return None


async def correr_sync() -> bool:
    """Lanza scripts/sync_diario.py como subproceso. True si salio con 0.

    Subproceso y no import directo para que una fuga de memoria o un
    sys.exit() de los scripts no se lleve por delante al servidor web.
    """
    ruta = os.path.join(ROOT_DIR, "scripts", "sync_diario.py")
    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, ruta, cwd=ROOT_DIR,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as e:
        logger.error(f"[sync-programado] no pude lanzar el sync: {e}")
        return False

    try:
        salida, _ = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_SYNC)
    except asyncio.TimeoutError:
        proc.kill()
        logger.error(f"[sync-programado] el sync excedio {TIMEOUT_SYNC}s y se cancelo")
        return False

    texto = (salida or b"").decode("utf-8", errors="replace")
    for linea in texto.strip().splitlines()[-4:]:
        logger.info(f"[sync-programado] {linea}")

    ok = proc.returncode == 0
    logger.info(f"[sync-programado] {'termino bien' if ok else 'FALLO'} (codigo {proc.returncode})")

    if ok:
        # El catálogo nuevo puede traer abreviaturas que antes no existían
        # (ver agent/tools.py): sin esto, los artículos nuevos abreviados
        # quedarían invisibles hasta el siguiente reinicio del servidor.
        try:
            from agent.tools import invalidar_cache_raices
            invalidar_cache_raices()
        except Exception as e:
            logger.warning(f"[sync-programado] no pude refrescar abreviaturas: {e}")

    return ok


async def programar_sync_diario():
    """Bucle del programador. Se arranca desde el lifespan de main.py."""
    if not programador_activo():
        logger.info("[sync-programado] DESACTIVADO (SYNC_PROGRAMADO_ENABLED=false)")
        return

    hora = hora_objetivo()
    logger.info(f"[sync-programado] activo — sincroniza a las {hora}:00, revisa cada {INTERVALO_REVISION}s")
    await asyncio.sleep(30)  # dejar que el servidor termine de levantar

    while True:
        try:
            ultima = leer_ultima_sincronizacion()
            if debe_correr(ultima, datetime.now(), hora_objetivo()):
                ultimo_texto = ultima.isoformat(timespec="seconds") if ultima else "nunca"
                logger.info(f"[sync-programado] toca sincronizar (ultima vez: {ultimo_texto})")
                await correr_sync()
        except asyncio.CancelledError:
            logger.info("[sync-programado] detenido")
            raise
        except Exception as e:
            # Nunca dejar que un error mate el bucle.
            logger.error(f"[sync-programado] error inesperado: {type(e).__name__}: {e}")
        await asyncio.sleep(INTERVALO_REVISION)
