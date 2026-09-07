# agent/providers/wacrm.py — Adaptador para wacrm (CRM propio)

"""
Habla con el CRM, no con WhatsApp.

A diferencia de Twilio o Meta, aquí wacrm es quien tiene el número de
WhatsApp: recibe de Meta, guarda el mensaje, se lo muestra al vendedor en
su bandeja y entrega la respuesta. Claudia solo aporta el cerebro.

Ventaja concreta: el vendedor ve TODA la conversación —lo que preguntó el
cliente y lo que contestó Claudia— en la misma bandeja donde atiende a
mano, y puede tomar el control de un chat sin apagar nada más.

Los mensajes entrantes NO llegan por webhook sino por sondeo
(agent/sondeo_wacrm.py). La razón está en el código de wacrm: entrega sus
webhooks con UN SOLO intento y 5 segundos de plazo, sin reintentos, y a
los 15 fallos seguidos desactiva el endpoint solo. Claudia tarda más que
eso (hasta 8 turnos de herramientas, más NetSuite en vivo), así que un
webhook se marcaría como fallido en cada mensaje y se apagaría a los
quince. Sondear también evita tener que exponer este servidor a internet.
"""

import os
import logging
import httpx
from fastapi import Request
from agent.providers.base import ProveedorWhatsApp, MensajeEntrante

logger = logging.getLogger("agentkit")

# Timeout de las llamadas al CRM. Generoso a propósito: es la red local,
# pero un envío que falla por impaciencia pierde la respuesta al cliente.
_TIMEOUT = 20.0

# Extensiones que WhatsApp trata como imagen; el resto va como documento.
# wacrm exige el tipo correcto — mandar un PDF como "image" lo rechaza Meta.
_EXT_IMAGEN = (".jpg", ".jpeg", ".png", ".webp")


class ProveedorWacrm(ProveedorWhatsApp):
    """Proveedor que entrega a través del CRM wacrm."""

    def __init__(self):
        # Sin barra final: todas las rutas se concatenan con "/api/v1/...".
        self.url = os.getenv("WACRM_URL", "").rstrip("/")
        self.api_key = os.getenv("WACRM_API_KEY", "").strip()

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.api_key}"}

    def configurado(self) -> bool:
        return bool(self.url and self.api_key)

    async def parsear_webhook(self, request: Request) -> list[MensajeEntrante]:
        """No se usa: los entrantes llegan por sondeo (ver el docstring del
        módulo). Se deja explícito en vez de a medias — un parser de webhook
        sin probar es peor que no tenerlo."""
        logger.warning(
            "Llegó un webhook a /webhook con el proveedor wacrm activo. "
            "Este proveedor recibe por sondeo; el mensaje se ignora."
        )
        return []

    async def enviar_mensaje(self, telefono: str, mensaje: str, media_url: str = None,
                              confirmar_entrega: bool = False) -> bool:
        """Envía por el CRM, que a su vez entrega a WhatsApp.

        El CRM crea el contacto y la conversación si no existían, así que
        basta el teléfono en formato E.164 — no hace falta saber ningún id
        interno suyo.

        confirmar_entrega se acepta por contrato pero no cambia nada: el
        CRM responde 201 cuando Meta ya aceptó el mensaje, que es tan lejos
        como se puede confirmar sin esperar los callbacks de estado. No se
        finge una confirmación que no se hizo.
        """
        if not self.configurado():
            logger.warning("WACRM_URL o WACRM_API_KEY no configuradas")
            return False

        cuerpo = {"to": telefono, "type": "text", "text": mensaje}
        if media_url:
            es_imagen = media_url.lower().split("?")[0].endswith(_EXT_IMAGEN)
            cuerpo = {
                "to": telefono,
                "type": "image" if es_imagen else "document",
                "media_url": media_url,
                # En WhatsApp el texto viaja como pie del adjunto.
                "text": mensaje,
            }

        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                r = await client.post(
                    f"{self.url}/api/v1/messages",
                    json=cuerpo,
                    headers=self._headers(),
                )
        except Exception as e:
            logger.error(f"No se pudo llamar al CRM: {e}")
            return False

        if r.status_code == 201:
            return True

        # Un 502 con "meta_error" viene de Meta, no del CRM: wacrm no
        # comprueba la ventana de 24 horas por su cuenta, deja que Meta
        # rechace y envuelve ese rechazo. La causa más común es justo esa
        # (código 131047 de Meta), y conviene distinguirla en el log porque
        # no es un fallo que se arregle reintentando.
        if r.status_code == 502 and "131047" in r.text:
            logger.error(
                f"Ventana de 24h cerrada con {telefono}: WhatsApp solo permite "
                "plantillas aprobadas fuera de ella. El mensaje NO se entregó."
            )
            return False

        logger.error(f"El CRM rechazó el envío: {r.status_code} — {r.text[:300]}")

        # Igual que en el adaptador de Twilio: si el adjunto tiró el mensaje
        # completo, se reintenta solo con el texto. Perder la transcripción
        # es un mal menor; perder la respuesta al cliente, no.
        if media_url:
            logger.warning("Reintentando sin el adjunto")
            return await self.enviar_mensaje(telefono, mensaje, None, confirmar_entrega)
        return False
