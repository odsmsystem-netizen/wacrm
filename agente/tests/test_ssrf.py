"""El guarda que impide que el servidor descargue URLs hacia dentro de la red.

Importa porque la peticion sale con el acceso del servidor, no con el de
quien la pidio: una URL a 127.0.0.1 o a un 192.168.x.x convierte al agente
en un puente para sondear servicios internos. Sus vecinos de red son el
CRM y el firewall de la empresa.
"""

import pytest

from agent.ssrf import url_es_alcanzable


@pytest.mark.parametrize("url", [
    # IPs publicas literales: no dependen de DNS, asi que el test vale
    # igual sin conexion. Un dominio inventado se rechazaria por no
    # resolver — que es correcto, pero haria el test dependiente de la red.
    "https://93.184.216.34/catalogo.txt",
    "http://8.8.8.8/pagina",
    "https://1.1.1.1/a/b?c=d",
])
def test_permite_direcciones_publicas(url):
    permitida, motivo = url_es_alcanzable(url)
    assert permitida, f"deberia permitirse: {motivo}"


def test_rechaza_lo_que_no_resuelve():
    """Si el nombre no resuelve no se puede comprobar que sea publico, asi
    que se rechaza. Preferible a dejar pasar algo sin verificar."""
    permitida, motivo = url_es_alcanzable("https://este-dominio-no-existe-jamas-12345.com/")
    assert not permitida
    assert "resolver" in motivo


@pytest.mark.parametrize("url,razon", [
    ("http://127.0.0.1:8000/admin",              "loopback"),
    ("http://[::1]/",                            "loopback IPv6"),
    ("http://10.0.0.5/",                         "privada 10/8"),
    ("http://172.16.3.4/",                       "privada 172.16/12"),
    ("http://192.168.1.55/",                     "privada 192.168/16"),
    ("http://169.254.169.254/latest/meta-data/", "metadatos de nube"),
    ("http://0.0.0.0/",                          "no especificada"),
])
def test_bloquea_direcciones_internas(url, razon):
    permitida, _ = url_es_alcanzable(url)
    assert not permitida, f"deberia bloquearse ({razon}): {url}"


@pytest.mark.parametrize("url", [
    "http://localhost/",
    "http://algo.localhost/",
    "http://crm.local/",
    "http://servidor.internal/",
])
def test_bloquea_nombres_internos(url):
    """Sin resolver siquiera: un nombre interno no tiene por que existir en
    este equipo para ser peligroso en otro."""
    permitida, _ = url_es_alcanzable(url)
    assert not permitida


@pytest.mark.parametrize("url", [
    "file:///etc/passwd",
    "ftp://ejemplo.com/x",
    "gopher://ejemplo.com/",
    "data:text/plain,hola",
])
def test_solo_admite_http_y_https(url):
    """`file://` leeria archivos del servidor; los demas esquemas alcanzan
    servicios que nunca deberian abrirse desde una URL pegada en un panel."""
    permitida, _ = url_es_alcanzable(url)
    assert not permitida


@pytest.mark.parametrize("url", ["", "no-es-una-url", "http://", "https:///ruta"])
def test_rechaza_urls_mal_formadas(url):
    permitida, _ = url_es_alcanzable(url)
    assert not permitida


def test_el_motivo_explica_el_rechazo():
    """El mensaje llega al usuario del panel: sin el, pegar una URL de la
    intranet falla sin decir por que y se pierde media hora."""
    _, motivo = url_es_alcanzable("http://192.168.1.55/")
    assert motivo and len(motivo) > 10
