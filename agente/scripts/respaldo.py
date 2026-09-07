#!/usr/bin/env python3
# scripts/respaldo.py — Respaldo de la configuración y los datos del negocio
# Generado por AgentKit

"""
Empaqueta en un .zip todo lo que NO se puede recuperar de ningún lado.

POR QUÉ EXISTE
--------------
El repositorio de GitHub (Hainrixz/whatsapp-agentkit) es la PLANTILLA
open source de AgentKit — no el despliegue de Ambar Cargo. La
configuración real del negocio está deliberadamente fuera de él:

    config/prompts.yaml        el system prompt de Claudia, afinado a mano
    config/business.yaml       datos del negocio
    config/clientes_escala.yaml
    config/vendedores_whatsapp.yaml
    .env                       llaves de Anthropic, Twilio, NetSuite
    scripts/config.ini         tokens de NetSuite
    agentkit.db                conversaciones, cotizaciones, vendedores,
                               usuarios del panel
    netsuite_sync.db           3,156 artículos + 8,772 clientes

Nada de eso está versionado, así que hoy existe en un solo disco. Este
script es la red.

LÍMITE IMPORTANTE — LÉELO
-------------------------
Un respaldo en la MISMA máquina protege contra borrados accidentales y
archivos corrompidos. NO protege contra que se muera el disco, se pierda
la laptop o pase algo peor. Para eso el .zip tiene que SALIR de aquí: a
Drive, a un disco externo, a donde guarden las cosas de la empresa. Este
script no lo manda a ningún lado a propósito — subir datos del negocio a
un servicio externo es una decisión tuya, no mía.

El .zip CONTIENE SECRETOS EN CLARO. Por eso respaldos/ está en .gitignore
y el hook de pre-commit lo bloquea. Trátalo como tratarías el .env.

Uso:
    python scripts/respaldo.py                 # crea, verifica y rota
    python scripts/respaldo.py --conservar 20  # cambia cuántos se guardan
    python scripts/respaldo.py --verificar <archivo.zip>
"""

import os
import sys
import glob
import zipfile
import argparse
from datetime import datetime

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CARPETA_RESPALDOS = os.path.join(ROOT_DIR, "respaldos")
PREFIJO = "agentkit-respaldo-"
CONSERVAR_POR_DEFECTO = 10

# Qué se respalda. Rutas relativas a la raíz del proyecto.
CONTENIDO = [
    "config/prompts.yaml",
    "config/business.yaml",
    "config/clientes_escala.yaml",
    "config/vendedores_whatsapp.yaml",
    ".env",
    "scripts/config.ini",
    "agentkit.db",
    "netsuite_sync.db",
]

# Sin estos el respaldo no sirve para restaurar: el agente no arranca sin
# .env, y sin prompts.yaml Claudia pierde toda su personalidad y reglas.
IMPRESCINDIBLES = [".env", "config/prompts.yaml"]


def crear_respaldo(raiz: str = ROOT_DIR, carpeta_destino: str = CARPETA_RESPALDOS) -> str:
    """Crea el .zip y devuelve su ruta.

    Un archivo que no exista simplemente se omite (una instalación nueva
    puede no tener netsuite_sync.db todavía) — no es motivo para abortar
    el respaldo de todo lo demás.
    """
    os.makedirs(carpeta_destino, exist_ok=True)
    sello = datetime.now().strftime("%Y%m%d-%H%M%S")
    destino = os.path.join(carpeta_destino, f"{PREFIJO}{sello}.zip")

    with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
        for relativo in CONTENIDO:
            completo = os.path.join(raiz, relativo)
            if os.path.isfile(completo):
                z.write(completo, arcname=relativo)

    return destino


def verificar(ruta_zip: str) -> tuple[bool, str]:
    """¿El respaldo sirve de verdad?

    Comprueba tres cosas, en orden de gravedad: que el zip no esté
    corrupto, que sus CRC cuadren, y que contenga lo imprescindible. Un
    respaldo que falla en silencio es peor que no tenerlo — da falsa
    tranquilidad justo hasta el día que lo necesitas.
    """
    if not os.path.isfile(ruta_zip):
        return False, f"no existe: {ruta_zip}"

    try:
        with zipfile.ZipFile(ruta_zip) as z:
            dañado = z.testzip()
            if dañado:
                return False, f"archivo corrupto dentro del zip: {dañado}"
            dentro = set(z.namelist())
    except zipfile.BadZipFile:
        return False, "no es un zip válido (archivo corrupto o incompleto)"

    faltantes = [f for f in IMPRESCINDIBLES if f not in dentro]
    if faltantes:
        return False, f"faltan archivos imprescindibles: {', '.join(faltantes)}"

    return True, "ok"


def rotar(carpeta: str = CARPETA_RESPALDOS, conservar: int = CONSERVAR_POR_DEFECTO) -> int:
    """Borra los respaldos más viejos. Devuelve cuántos borró.

    Solo toca archivos con NUESTRO prefijo: si guardaste otra cosa en esa
    carpeta, no es asunto de este script borrarla.
    """
    patron = os.path.join(carpeta, f"{PREFIJO}*.zip")
    # El nombre lleva la fecha, así que el orden lexicográfico ES cronológico
    archivos = sorted(glob.glob(patron))
    sobrantes = archivos[:-conservar] if len(archivos) > conservar else []

    for viejo in sobrantes:
        try:
            os.remove(viejo)
        except OSError:
            pass

    return len(sobrantes)


def _tamaño_legible(ruta: str) -> str:
    b = os.path.getsize(ruta)
    for unidad in ("B", "KB", "MB", "GB"):
        if b < 1024:
            return f"{b:.1f} {unidad}"
        b /= 1024
    return f"{b:.1f} TB"


def main() -> int:
    parser = argparse.ArgumentParser(description="Respaldo de configuración y datos de AgentKit")
    parser.add_argument("--conservar", type=int, default=CONSERVAR_POR_DEFECTO,
                        help=f"cuántos respaldos guardar (default: {CONSERVAR_POR_DEFECTO})")
    parser.add_argument("--verificar", metavar="ZIP", default=None,
                        help="solo verificar un respaldo existente")
    args = parser.parse_args()

    if args.verificar:
        ok, detalle = verificar(args.verificar)
        print(f"{'OK' if ok else 'FALLA'}: {detalle}")
        return 0 if ok else 1

    destino = crear_respaldo()
    ok, detalle = verificar(destino)

    if not ok:
        print(f"RESPALDO INVALIDO: {detalle}")
        return 1

    with zipfile.ZipFile(destino) as z:
        piezas = z.namelist()

    print(f"Respaldo creado: {destino}")
    print(f"  tamaño:    {_tamaño_legible(destino)}")
    print(f"  contenido: {len(piezas)} archivos")
    for p in piezas:
        print(f"    - {p}")

    borrados = rotar(conservar=args.conservar)
    if borrados:
        print(f"  rotación:  {borrados} respaldo(s) viejo(s) eliminado(s)")

    print()
    print("  RECUERDA: esto sigue en el MISMO disco. Copia el .zip a Drive")
    print("  o a un disco externo — ahi es donde de verdad te protege.")
    print("  Contiene secretos en claro: trátalo como el .env.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
