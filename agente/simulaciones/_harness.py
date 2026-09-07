# simulaciones/_harness.py — Arnés de simulación para probar a Claudia SIN
# gastar saldo de la API de Anthropic y SIN tocar NetSuite/Twilio de verdad.
#
# Cómo funciona: en estas simulaciones, "Claudia" la interpreta el asistente
# (Claude Code) siguiendo al pie de la letra las reglas de config/prompts.yaml,
# en vez de llamar a la API real de Claude. Pero las HERRAMIENTAS que Claudia
# invocaría sí se ejecutan de verdad contra la base local (netsuite_sync.db,
# agentkit.db) — así los precios, existencias y datos de cliente que aparecen
# en la conversación son reales, no inventados.
#
# Los dos únicos puntos que SÍ tocan sistemas externos de verdad —crear una
# Opportunity en NetSuite (agent.netsuite_client.crear_oportunidad) y mandar
# el WhatsApp real al vendedor (agent.providers.obtener_proveedor)— se
# interceptan aquí para no crear registros de prueba en sistemas reales,
# pero el resto de la función (plantilla de mensaje, selección de vendedor,
# registro en notificaciones_vendedor) corre 100% real.
#
# Todos los teléfonos de prueba usan el prefijo SIM- para poder limpiarlos
# de agentkit.db al terminar (ver limpiar_datos_prueba()).

import os
import sys
import asyncio
import unittest.mock as mock

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT_DIR)

from agent import memory, tools
from agent import netsuite_client as ns


class TranscriptWriter:
    """Escribe el transcript de una conversación simulada a un archivo de
    texto legible, y también refleja los mensajes cliente/Claudia en la
    base real (agentkit.db) para probar la integración end-to-end."""

    def __init__(self, escenario_id: str, titulo: str, telefono: str):
        self.escenario_id = escenario_id
        self.titulo = titulo
        self.telefono = telefono
        self.lineas = [f"ESCENARIO {escenario_id} — {titulo}", f"Teléfono simulado: {telefono}", "=" * 70, ""]

    def cliente(self, texto: str):
        self.lineas.append(f"[CLIENTE] {texto}")
        asyncio.run(memory.guardar_mensaje(self.telefono, "user", texto))

    def herramienta(self, nombre: str, args: dict, resultado):
        args_fmt = ", ".join(f"{k}={v!r}" for k, v in args.items())
        self.lineas.append(f"    -> herramienta: {nombre}({args_fmt})")
        self.lineas.append(f"       resultado: {resultado}")

    def claudia(self, texto: str):
        self.lineas.append(f"[CLAUDIA] {texto}")
        self.lineas.append("")
        asyncio.run(memory.guardar_mensaje(self.telefono, "assistant", texto))

    def nota(self, texto: str):
        """Nota de observación del analista (no es parte de la conversación)."""
        self.lineas.append(f"    [NOTA ANALISTA: {texto}]")

    def guardar(self):
        os.makedirs(os.path.join(ROOT_DIR, "simulaciones"), exist_ok=True)
        ruta = os.path.join(ROOT_DIR, "simulaciones", f"{self.escenario_id}.txt")
        with open(ruta, "w", encoding="utf-8") as f:
            f.write("\n".join(self.lineas))
        return ruta

    def imprimir(self):
        print("\n".join(self.lineas))


class _ProveedorFalso:
    """Sustituye al proveedor real de WhatsApp (Twilio) durante la simulación:
    no manda nada de verdad, solo confirma 'entregado' para que el flujo de
    Claudia complete con normalidad y podamos ver el mensaje final que
    hubiera recibido el vendedor."""
    async def enviar_mensaje(self, telefono, mensaje, media_url=None, confirmar_entrega=False):
        _ProveedorFalso.ultimo_mensaje = {"telefono": telefono, "mensaje": mensaje, "media_url": media_url}
        return True


_contador_opportunity = [0]


def _crear_oportunidad_falsa(lineas, memo, titulo):
    """Sustituye a agent.netsuite_client.crear_oportunidad: no crea nada en
    NetSuite, regresa un id de mentira con formato reconocible."""
    _contador_opportunity[0] += 1
    return {"ok": True, "opportunity_id": f"SIM-OPP-{_contador_opportunity[0]:03d}"}


def parche_externos():
    """Devuelve un contexto (usar con 'with') que intercepta NetSuite y Twilio
    mientras dura la simulación."""
    return mock.patch.object(ns, "crear_oportunidad", side_effect=_crear_oportunidad_falsa), \
           mock.patch("agent.providers.obtener_proveedor", return_value=_ProveedorFalso())


def run(coro):
    return asyncio.run(coro)


def limpiar_datos_prueba(prefijo: str = "SIM-"):
    """Borra todo rastro de teléfonos de prueba (SIM-*) de agentkit.db, para
    que las métricas reales del panel de administración no se contaminen
    con las 20 simulaciones. Se corre al final de todo el ejercicio."""
    import sqlite3
    ruta_db = os.path.join(ROOT_DIR, "agentkit.db")
    con = sqlite3.connect(ruta_db)
    tablas_con_telefono = ["mensajes", "citas", "leads", "carrito", "clientes", "notificaciones_vendedor", "tickets"]
    total = 0
    for tabla in tablas_con_telefono:
        cur = con.execute(f"DELETE FROM {tabla} WHERE telefono LIKE ?", (f"{prefijo}%",))
        total += cur.rowcount
    con.commit()
    con.close()
    return total
