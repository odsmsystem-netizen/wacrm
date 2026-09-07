# agent/providers/__init__.py — Factory de proveedores
# Generado por AgentKit

"""
Selecciona el proveedor de WhatsApp según la variable WHATSAPP_PROVIDER en .env.

Hay DOS caminos de salida, a propósito (ver obtener_proveedor_avisos).
"""

import os
import logging
from agent.providers.base import ProveedorWhatsApp

logger = logging.getLogger("agentkit")

_VALIDOS = ("wacrm", "twilio", "meta")


def _construir(proveedor: str) -> ProveedorWhatsApp:
    """Instancia un proveedor por nombre. Sin defaults ni adivinanzas."""
    if proveedor == "wacrm":
        from agent.providers.wacrm import ProveedorWacrm
        return ProveedorWacrm()
    if proveedor == "twilio":
        from agent.providers.twilio import ProveedorTwilio
        return ProveedorTwilio()
    if proveedor == "meta":
        # agent/providers/meta.py no existe en este repo. Antes esta rama
        # reventaba con un ImportError sin explicación; mejor decir qué pasa.
        raise ValueError(
            "El proveedor 'meta' no está implementado en este repo "
            "(falta agent/providers/meta.py). Usa: wacrm o twilio."
        )
    raise ValueError(
        f"Proveedor no soportado: {proveedor}. Usa: {', '.join(_VALIDOS)}"
    )


def obtener_proveedor() -> ProveedorWhatsApp:
    """Proveedor para las conversaciones con CLIENTES."""
    proveedor = os.getenv("WHATSAPP_PROVIDER", "").lower().strip()
    if not proveedor:
        raise ValueError(
            f"WHATSAPP_PROVIDER no configurado en .env. Usa: {', '.join(_VALIDOS)}"
        )
    return _construir(proveedor)


def obtener_proveedor_avisos() -> ProveedorWhatsApp:
    """Proveedor para los avisos INTERNOS a vendedores.

    Está separado del de clientes por una razón concreta: cuando los
    clientes se atienden por wacrm, mandar por ahí también los avisos
    metería a cada vendedor como un contacto más del CRM y cada aviso como
    una conversación en la bandeja del equipo. La bandeja dejaría de ser
    "clientes" para ser "clientes y recados internos", que es justo lo que
    hace que un CRM se deje de usar.

    Por eso, si los clientes van por wacrm y nadie dijo lo contrario, los
    avisos caen a twilio en vez de heredar wacrm. En cualquier otro caso se
    usa el mismo proveedor de siempre, así que el comportamiento previo no
    cambia. WHATSAPP_PROVIDER_AVISOS manda sobre todo lo anterior.
    """
    explicito = os.getenv("WHATSAPP_PROVIDER_AVISOS", "").lower().strip()
    if explicito:
        return _construir(explicito)

    clientes = os.getenv("WHATSAPP_PROVIDER", "").lower().strip()
    if clientes == "wacrm":
        logger.info(
            "Avisos a vendedores por twilio (los clientes van por wacrm). "
            "Define WHATSAPP_PROVIDER_AVISOS si quieres otra cosa."
        )
        return _construir("twilio")

    return obtener_proveedor()
