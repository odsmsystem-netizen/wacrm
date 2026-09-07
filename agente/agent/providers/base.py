# agent/providers/base.py — Clase base para proveedores de WhatsApp
# Generado por AgentKit

"""
Define la interfaz común que todos los proveedores de WhatsApp deben implementar.
Esto permite cambiar de proveedor sin modificar el resto del código.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from fastapi import Request


@dataclass
class MensajeEntrante:
    """Mensaje normalizado — mismo formato sin importar el proveedor."""
    telefono: str       # Número del remitente
    texto: str          # Contenido del mensaje
    mensaje_id: str     # ID único del mensaje
    es_propio: bool     # True si lo envió el agente (se ignora)


class ProveedorWhatsApp(ABC):
    """Interfaz que cada proveedor de WhatsApp debe implementar."""

    @abstractmethod
    async def parsear_webhook(self, request: Request) -> list[MensajeEntrante]:
        """Extrae y normaliza mensajes del payload del webhook."""
        ...

    @abstractmethod
    async def enviar_mensaje(self, telefono: str, mensaje: str, media_url: str = None,
                              confirmar_entrega: bool = False) -> bool:
        """Envía un mensaje de texto, opcionalmente con un archivo adjunto
        (media_url: URL pública que el proveedor pueda descargar). Retorna
        True si fue exitoso.

        confirmar_entrega=True verifica el estado real de entrega (no solo
        que el proveedor aceptó el envío) antes de reportar éxito — úsalo
        donde de verdad importa saber si llegó (ej. avisos a vendedores),
        no en cada respuesta al cliente (le mete latencia)."""
        ...

    async def enviar_plantilla(self, telefono: str, variables: dict[str, str]) -> bool:
        """
        Envía una PLANTILLA previamente aprobada, con sus variables.

        Existe por la ventana de 24 horas de WhatsApp: un mensaje libre solo
        se puede entregar si esa persona te escribió en las últimas 24 horas.
        Fuera de esa ventana, el único mensaje que pasa es una plantilla
        aprobada. Es la diferencia entre que un vendedor se entere de un
        cliente o que el aviso se pierda en silencio.

        Retorna False si el proveedor no la soporta o no está configurada —
        quien llama debe tratarlo como "no se entregó", nunca como error.
        """
        return False

    async def validar_webhook(self, request: Request) -> dict | int | None:
        """Verificación GET del webhook (solo Meta la requiere). Retorna respuesta o None."""
        return None
