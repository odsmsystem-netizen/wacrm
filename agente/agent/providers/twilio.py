# agent/providers/twilio.py — Adaptador para Twilio WhatsApp
# Generado por AgentKit

import os
import json
import asyncio
import logging
import base64
import httpx
from fastapi import Request
from agent.providers.base import ProveedorWhatsApp, MensajeEntrante

logger = logging.getLogger("agentkit")

# Estados de Twilio que significan "no llegó" — un envío en sandbox a un
# número que nunca hizo el "join" queda aceptado (HTTP 201) pero termina en
# uno de estos estados unos segundos después. Confiar solo en el 201 reporta
# falsos positivos (se vio en la práctica: 3/3 mensajes "enviados" que en
# realidad fallaron con error 63015 por no estar unidos al sandbox).
_ESTADOS_FALLO = {"failed", "undelivered"}
_ESTADOS_FINALES = _ESTADOS_FALLO | {"delivered", "read"}


class ProveedorTwilio(ProveedorWhatsApp):
    """Proveedor de WhatsApp usando Twilio."""

    def __init__(self):
        self.account_sid = os.getenv("TWILIO_ACCOUNT_SID")
        self.auth_token = os.getenv("TWILIO_AUTH_TOKEN")
        self.phone_number = os.getenv("TWILIO_PHONE_NUMBER")
        # SID (HX...) de la plantilla aprobada para avisar a un vendedor
        # fuera de la ventana de 24h. Ver PLANTILLA_WHATSAPP.md.
        self.content_sid_aviso = os.getenv("TWILIO_CONTENT_SID_AVISO_VENDEDOR", "").strip()

    async def parsear_webhook(self, request: Request) -> list[MensajeEntrante]:
        """Parsea el payload form-encoded de Twilio."""
        form = await request.form()
        texto = form.get("Body", "")
        telefono = form.get("From", "").replace("whatsapp:", "")
        mensaje_id = form.get("MessageSid", "")
        if not texto:
            return []
        return [MensajeEntrante(
            telefono=telefono,
            texto=texto,
            mensaje_id=mensaje_id,
            es_propio=False,
        )]

    async def _enviar(self, client: httpx.AsyncClient, telefono: str, mensaje: str,
                       media_url: str, headers: dict, confirmar_entrega: bool) -> bool:
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"
        data = {
            "From": f"whatsapp:{self.phone_number}",
            "To": f"whatsapp:{telefono}",
            "Body": mensaje,
        }
        if media_url:
            data["MediaUrl"] = media_url

        r = await client.post(url, data=data, headers=headers)
        if r.status_code != 201:
            logger.error(f"Error Twilio: {r.status_code} — {r.text}")
            return False
        if not confirmar_entrega:
            return True

        sid = r.json().get("sid")
        if not sid:
            return True
        estado_url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages/{sid}.json"
        for _ in range(3):
            await asyncio.sleep(1.5)
            rs = await client.get(estado_url, headers=headers)
            if rs.status_code != 200:
                continue
            cuerpo = rs.json()
            estado = cuerpo.get("status")
            if estado in _ESTADOS_FINALES:
                if estado in _ESTADOS_FALLO:
                    err = cuerpo.get("error_message") or cuerpo.get("error_code")
                    logger.error(f"Twilio: mensaje {sid} no se entregó (estado={estado}, error={err})")
                    return False
                return True
        # No se resolvió a un estado final en el tiempo de espera (sigue
        # queued/sent/sending): se asume que va en camino, no se bloquea
        # más tiempo por esto — solo se detectan fallos RÁPIDOS aquí.
        return True

    async def enviar_mensaje(self, telefono: str, mensaje: str, media_url: str = None,
                              confirmar_entrega: bool = False) -> bool:
        """Envía mensaje via Twilio API. Si media_url viene, se adjunta
        (ej. la transcripción de la conversación) — Twilio la descarga desde
        esa URL, así que debe ser pública (ver PUBLIC_BASE_URL en .env).

        WhatsApp manda Body y MediaUrl como UN SOLO mensaje: si el adjunto
        falla (ej. error 63019 "Media failed to download" — visto en la
        práctica con archivos .txt de transcripción), Twilio rechaza el
        mensaje COMPLETO, incluido el texto. Por eso, si falla con adjunto,
        se reintenta una vez SIN el adjunto — el aviso al vendedor es lo
        importante, la transcripción es un plus que no debe tirar todo el
        mensaje si no se puede entregar.

        confirmar_entrega=True espera unos segundos y revisa el estado real
        del mensaje antes de reportar éxito — un HTTP 201 solo significa que
        Twilio ACEPTÓ el mensaje para enviarlo, no que llegó. En sandbox, un
        envío a un número que nunca hizo "join" se acepta así y falla unos
        segundos después (visto en la práctica: error 63015). Se deja en
        False por default para no meterle latencia a cada respuesta normal
        al cliente — solo se activa donde de verdad importa confirmar
        (avisos a vendedores, ver agent/tools.py)."""
        if not all([self.account_sid, self.auth_token, self.phone_number]):
            logger.warning("Variables de Twilio no configuradas")
            return False
        auth = base64.b64encode(f"{self.account_sid}:{self.auth_token}".encode()).decode()
        headers = {"Authorization": f"Basic {auth}"}

        async with httpx.AsyncClient() as client:
            ok = await self._enviar(client, telefono, mensaje, media_url, headers, confirmar_entrega)
            if not ok and media_url:
                logger.warning("Reintentando sin el adjunto de transcripción (el adjunto tiró el mensaje completo)")
                ok = await self._enviar(client, telefono, mensaje, None, headers, confirmar_entrega)
            return ok

    async def enviar_plantilla(self, telefono: str, variables: dict[str, str]) -> bool:
        """Envía la plantilla aprobada de aviso a vendedor (Content API de Twilio).

        A diferencia de enviar_mensaje, esto SÍ atraviesa la ventana de 24
        horas de WhatsApp — es la única forma de alcanzar a un vendedor que
        no le ha escrito al bot recientemente.

        Las variables van por posición ({{1}}, {{2}}, ...) según como se dio
        de alta la plantilla en Twilio. Si TWILIO_CONTENT_SID_AVISO_VENDEDOR
        no está configurado, regresa False sin intentar nada: el sistema
        sigue funcionando igual que antes, solo sin este respaldo.
        """
        if not self.content_sid_aviso:
            logger.info("TWILIO_CONTENT_SID_AVISO_VENDEDOR no configurado; sin respaldo por plantilla.")
            return False
        if not all([self.account_sid, self.auth_token, self.phone_number]):
            logger.warning("Variables de Twilio no configuradas")
            return False

        auth = base64.b64encode(f"{self.account_sid}:{self.auth_token}".encode()).decode()
        headers = {"Authorization": f"Basic {auth}"}
        url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages.json"
        data = {
            "From": f"whatsapp:{self.phone_number}",
            "To": f"whatsapp:{telefono}",
            "ContentSid": self.content_sid_aviso,
            "ContentVariables": json.dumps({str(k): str(v) for k, v in variables.items()}),
        }

        async with httpx.AsyncClient() as client:
            r = await client.post(url, data=data, headers=headers)
            if r.status_code != 201:
                logger.error(f"Error Twilio (plantilla): {r.status_code} — {r.text}")
                return False
            sid = r.json().get("sid")
            if not sid:
                return True
            # Misma confirmación real que en los avisos libres: aquí importa
            # saber si llegó, es el último recurso antes de perder el aviso.
            estado_url = f"https://api.twilio.com/2010-04-01/Accounts/{self.account_sid}/Messages/{sid}.json"
            for _ in range(3):
                await asyncio.sleep(1.5)
                rs = await client.get(estado_url, headers=headers)
                if rs.status_code != 200:
                    continue
                cuerpo = rs.json()
                estado = cuerpo.get("status")
                if estado in _ESTADOS_FINALES:
                    if estado in _ESTADOS_FALLO:
                        err = cuerpo.get("error_message") or cuerpo.get("error_code")
                        logger.error(f"Twilio: plantilla {sid} no se entregó (estado={estado}, error={err})")
                        return False
                    return True
            return True
