# agent/conversacion.py — Cómo se atiende un mensaje entrante

"""
Un solo camino para responderle a un cliente, sin importar por dónde entró
el mensaje (webhook del proveedor o sondeo al CRM).

Vive fuera de main.py a propósito: cuando la lógica estaba dentro del
handler del webhook, cualquier otra vía de entrada tenía que copiarla, y
copiarla significa que el orden de guardado —que es delicado, ver abajo— se
desincroniza en cuanto alguien toca una de las dos copias.
"""

import logging

from agent.brain import generar_respuesta
from agent.memory import guardar_mensaje, obtener_historial
from agent.providers import obtener_proveedor

logger = logging.getLogger("agentkit")


async def atender_mensaje(telefono: str, texto: str, proveedor=None) -> str | None:
    """Genera la respuesta a un mensaje y la envía. Devuelve lo respondido,
    o None si no hubo nada que responder.

    `proveedor` se puede inyectar para reutilizar la instancia que ya tenga
    quien llama; si no viene, se resuelve con la configuración de siempre.
    """
    if not texto:
        return None

    proveedor = proveedor or obtener_proveedor()

    # El historial se pide ANTES de guardar el mensaje actual: brain.py
    # agrega el mensaje de ahora por su cuenta, y si ya estuviera en el
    # historial saldría duplicado.
    historial = await obtener_historial(telefono)

    # El mensaje del cliente se guarda ANTES de responder, no después:
    # durante la respuesta hay herramientas que leen la conversación de la
    # base (la transcripción que se le manda al vendedor). Si se guardara al
    # final, esa transcripción saldría siempre sin el último mensaje del
    # cliente — justo el que disparó el aviso.
    await guardar_mensaje(telefono, "user", texto)

    respuesta = await generar_respuesta(texto, historial, telefono=telefono)

    await guardar_mensaje(telefono, "assistant", respuesta)

    # El resultado del envío NO se puede ignorar. `enviar_mensaje`
    # devuelve False —sin lanzar— en casos reales y frecuentes: la
    # ventana de 24 horas cerrada, el CRM reiniciándose, Meta
    # rechazando. Descartarlo dejaba al cliente sin respuesta mientras
    # todo el sistema —la memoria, el CRM, el sondeo— quedaba convencido
    # de que sí se le había contestado.
    #
    # Se lanza en vez de devolver un valor porque quien llama debe
    # enterarse: el sondeo NO avanza el estado cuando esto falla, así que
    # el mensaje sigue pendiente y se reintenta en la próxima vuelta. Sin
    # la excepción, se marcaba como atendido y se perdía para siempre.
    entregado = await proveedor.enviar_mensaje(telefono, respuesta)
    if not entregado:
        raise RuntimeError(
            f"La respuesta a {telefono} no se pudo entregar. "
            "Queda pendiente para el siguiente intento."
        )

    logger.info(f"Respuesta a {telefono}: {respuesta}")
    return respuesta
