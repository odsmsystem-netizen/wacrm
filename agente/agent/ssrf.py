# agent/ssrf.py — Guarda contra peticiones hacia dentro de la red

"""
Cuando el servidor descarga una URL que le dieron, esa petición sale
desde DENTRO de la red — con el acceso que tiene el servidor, no quien
pidió. Una URL apuntando a `127.0.0.1`, a `169.254.169.254` (metadatos
de nube) o a un `192.168.x.x` convierte al agente en un puente para
sondear servicios internos que no deberían ser alcanzables desde fuera.

Que el panel pida contraseña no lo evita: basta una sesión de admin
robada, o que ese panel acabe publicado en un dominio. Y aquí el vecino
de red es el propio CRM y el firewall de la empresa.

Es la misma defensa que el CRM aplica a sus webhooks salientes
(`src/lib/webhooks/ssrf.ts`), traducida a Python para que las dos
mitades del proyecto se comporten igual.
"""

import ipaddress
import socket
from urllib.parse import urlparse

# Nombres que nunca deben resolverse hacia fuera.
_NOMBRES_INTERNOS = ("localhost",)
_SUFIJOS_INTERNOS = (".localhost", ".local", ".internal", ".home.arpa")


def _es_privada(ip: str) -> bool:
    """True para loopback, privada, link-local, ULA o reservada."""
    try:
        dir_ip = ipaddress.ip_address(ip)
    except ValueError:
        # Si no se puede interpretar, se trata como sospechosa: es más
        # seguro rechazar algo válido que dejar pasar algo que no lo es.
        return True
    return (
        dir_ip.is_private
        or dir_ip.is_loopback
        or dir_ip.is_link_local     # incluye 169.254.169.254 (metadatos)
        or dir_ip.is_reserved
        or dir_ip.is_multicast
        or dir_ip.is_unspecified
    )


def url_es_alcanzable(url: str) -> tuple[bool, str]:
    """¿Se puede descargar esta URL sin exponer la red interna?

    Devuelve (permitida, motivo). El motivo es para el log y para el
    mensaje de error — que sea explícito ahorra media hora de confusión
    a quien pegue una URL de su intranet sin saber por qué falla.
    """
    try:
        partes = urlparse(url)
    except ValueError:
        return False, "URL mal formada"

    if partes.scheme not in ("http", "https"):
        return False, "solo se admiten direcciones http:// o https://"

    host = (partes.hostname or "").lower().strip("[]")
    if not host:
        return False, "la URL no tiene servidor"

    if host in _NOMBRES_INTERNOS or host.endswith(_SUFIJOS_INTERNOS):
        return False, "apunta a un nombre interno"

    # Se resuelven TODAS las direcciones del nombre: un dominio puede
    # devolver una pública y una privada, y basta con que una entre para
    # que la petición acabe dentro de la red.
    try:
        infos = socket.getaddrinfo(host, partes.port or (443 if partes.scheme == "https" else 80))
    except socket.gaierror:
        return False, "no se pudo resolver el nombre"

    for info in infos:
        ip = info[4][0]
        if _es_privada(ip):
            return False, "apunta a una dirección interna de la red"

    return True, ""
