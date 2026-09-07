# tests/test_vendedores.py — Tests de vendedores en base de datos
# Generado por AgentKit

"""
Tests de la migración de vendedores de YAML a base de datos.

POR QUÉ SE MOVIERON A LA BASE
-----------------------------
config/vendedores_whatsapp.yaml tiene nombres, correos y WhatsApp de
empleados reales. Está en .gitignore para que no llegue a GitHub (el repo
es público), pero el agente lo NECESITA en tiempo de ejecución para
enrutar avisos. En Railway eso choca de frente: lo ignorado no se sube, y
el filesystem es efímero — cualquier edición desde el panel se perdería
en el siguiente redeploy.

La base resuelve las tres cosas a la vez: los datos nunca tocan git,
sobreviven los redeploys, y el CRUD del panel sigue funcionando.

Correr con:  python -m pytest tests/test_vendedores.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import tools


# ══════════════════════════════════════════════════════════════════
# 1. Normalización de una fila de vendedor
# ══════════════════════════════════════════════════════════════════

def test_normaliza_una_fila_completa():
    fila = tools.normalizar_vendedor({
        "nombre": "Wendy Lopez",
        "netsuite_id": 115,
        "email": "ventas4@ambarcargo.com",
        "whatsapp": "+5213338316311",
    })
    assert fila["nombre"] == "Wendy Lopez"
    assert fila["netsuite_id"] == "115"      # siempre string, para comparar sin sorpresas
    assert fila["whatsapp"] == "+5213338316311"


def test_normaliza_tolera_campos_faltantes():
    fila = tools.normalizar_vendedor({"nombre": "Solo Nombre"})
    assert fila["nombre"] == "Solo Nombre"
    assert fila["netsuite_id"] == ""
    assert fila["email"] == ""
    assert fila["whatsapp"] == ""


def test_normaliza_limpia_espacios():
    fila = tools.normalizar_vendedor({"nombre": "  Ana  ", "whatsapp": " +52133 "})
    assert fila["nombre"] == "Ana"
    assert fila["whatsapp"] == "+52133"


def test_normaliza_entrada_vacia_no_revienta():
    fila = tools.normalizar_vendedor({})
    assert fila["nombre"] == ""
    assert fila["netsuite_id"] == ""


# ══════════════════════════════════════════════════════════════════
# 2. La caché: los llamadores síncronos no deben cambiar
# ══════════════════════════════════════════════════════════════════

VENDEDORES_PRUEBA = [
    {"nombre": "Con WhatsApp", "netsuite_id": "147", "email": "a@x.com", "whatsapp": "+521111"},
    {"nombre": "Sin WhatsApp", "netsuite_id": "112", "email": "b@x.com", "whatsapp": ""},
    {"nombre": "Otra Con WA", "netsuite_id": "133", "email": "c@x.com", "whatsapp": "+521333"},
]


@pytest.fixture(autouse=True)
def cache_limpia():
    """Cada test arranca con la caché en un estado conocido."""
    original = list(tools._CACHE_VENDEDORES)
    tools._CACHE_VENDEDORES.clear()
    yield
    tools._CACHE_VENDEDORES.clear()
    tools._CACHE_VENDEDORES.extend(original)


def test_cargar_vendedores_lee_de_la_cache():
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    assert len(tools._cargar_vendedores()) == 3


def test_poblar_cache_reemplaza_no_acumula():
    """Refrescar dos veces no debe duplicar la lista."""
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    assert len(tools._cargar_vendedores()) == 3


def test_buscar_por_netsuite_id_encuentra():
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    v = tools._vendedor_por_netsuite_id("133")
    assert v is not None
    assert v["nombre"] == "Otra Con WA"


def test_buscar_por_netsuite_id_compara_como_texto():
    """NetSuite a veces devuelve el id como número: no debe fallar por el tipo."""
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    assert tools._vendedor_por_netsuite_id(133) is not None


def test_buscar_por_netsuite_id_inexistente_devuelve_none():
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    assert tools._vendedor_por_netsuite_id("999") is None


# ══════════════════════════════════════════════════════════════════
# 3. Sorteo: nunca elegir a quien no tiene WhatsApp
# ══════════════════════════════════════════════════════════════════

def test_el_sorteo_excluye_a_quien_no_tiene_whatsapp():
    """
    Sortear a alguien sin WhatsApp significa que el lead se pierde en
    silencio: el caso se registra pero nadie recibe el aviso.
    """
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    for _ in range(50):
        elegido = tools._sortear_vendedor()
        assert elegido["whatsapp"], f"sorteó a {elegido['nombre']} sin WhatsApp"


def test_el_sorteo_puede_elegir_a_cualquiera_de_los_validos():
    tools.poblar_cache_vendedores(VENDEDORES_PRUEBA)
    elegidos = {tools._sortear_vendedor()["nombre"] for _ in range(100)}
    assert elegidos == {"Con WhatsApp", "Otra Con WA"}


def test_sin_vendedores_el_sorteo_devuelve_none():
    tools.poblar_cache_vendedores([])
    assert tools._sortear_vendedor() is None


def test_si_nadie_tiene_whatsapp_devuelve_none():
    tools.poblar_cache_vendedores([{"nombre": "Nadie", "netsuite_id": "1",
                                     "email": "", "whatsapp": ""}])
    assert tools._sortear_vendedor() is None


# ══════════════════════════════════════════════════════════════════
# 4. Lectura del YAML — solo como semilla inicial
# ══════════════════════════════════════════════════════════════════

def test_leer_yaml_semilla_devuelve_lista_normalizada(tmp_path):
    ruta = tmp_path / "vendedores.yaml"
    ruta.write_text(
        "vendedores:\n"
        "- nombre: Prueba Uno\n"
        "  netsuite_id: '147'\n"
        "  email: uno@x.com\n"
        "  whatsapp: '+52111'\n",
        encoding="utf-8",
    )
    filas = tools.leer_vendedores_yaml(str(ruta))
    assert len(filas) == 1
    assert filas[0]["nombre"] == "Prueba Uno"
    assert filas[0]["netsuite_id"] == "147"


def test_leer_yaml_inexistente_devuelve_lista_vacia():
    assert tools.leer_vendedores_yaml("/no/existe/vendedores.yaml") == []


def test_leer_yaml_corrupto_no_revienta(tmp_path):
    """Un YAML roto no debe tumbar el arranque del servidor."""
    ruta = tmp_path / "roto.yaml"
    ruta.write_text("vendedores:\n  - [esto no\n    es valido:::\n", encoding="utf-8")
    assert tools.leer_vendedores_yaml(str(ruta)) == []


def test_leer_yaml_sin_la_clave_vendedores(tmp_path):
    ruta = tmp_path / "otra.yaml"
    ruta.write_text("otra_cosa: 1\n", encoding="utf-8")
    assert tools.leer_vendedores_yaml(str(ruta)) == []


# ══════════════════════════════════════════════════════════════════
# 5. Semilla desde variable de entorno — el caso de Railway
# ══════════════════════════════════════════════════════════════════
#
# config/vendedores_whatsapp.yaml esta en .gitignore (datos personales de
# empleados, repo publico) y `railway up` respeta .gitignore, asi que el
# archivo NO llega al contenedor. Verificado en el primer despliegue real:
# los logs decian "Vendedores en cache: 0" y Claudia no podia canalizar
# ningun lead a nadie. La semilla viaja por variable de entorno, igual que
# el token de Twilio.

JSON_VENDEDORES = (
    '[{"nombre":"Ana Prueba","netsuite_id":"147","email":"a@x.com","whatsapp":"+52111"},'
    '{"nombre":"Beto Prueba","netsuite_id":"112","email":"b@x.com","whatsapp":"+52222"}]'
)


def test_semilla_desde_variable_de_entorno(monkeypatch, tmp_path):
    monkeypatch.setenv("VENDEDORES_SEED_JSON", JSON_VENDEDORES)
    filas = tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "no-existe.yaml"))
    assert len(filas) == 2
    assert filas[0]["nombre"] == "Ana Prueba"
    assert filas[0]["netsuite_id"] == "147"


def test_el_yaml_gana_sobre_la_variable(monkeypatch, tmp_path):
    """En local el archivo es la fuente que el usuario edita: debe mandar."""
    monkeypatch.setenv("VENDEDORES_SEED_JSON", JSON_VENDEDORES)
    ruta = tmp_path / "vendedores.yaml"
    ruta.write_text(
        "vendedores:\n- nombre: Del Archivo\n  netsuite_id: '999'\n"
        "  email: c@x.com\n  whatsapp: '+52333'\n",
        encoding="utf-8",
    )
    filas = tools.leer_vendedores_semilla(ruta_yaml=str(ruta))
    assert len(filas) == 1
    assert filas[0]["nombre"] == "Del Archivo"


def test_sin_yaml_ni_variable_devuelve_vacio(monkeypatch, tmp_path):
    monkeypatch.delenv("VENDEDORES_SEED_JSON", raising=False)
    assert tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "nada.yaml")) == []


def test_json_corrupto_no_tumba_el_arranque(monkeypatch, tmp_path):
    """Un JSON mal pegado en Railway no debe impedir que el servidor arranque:
    peor que quedarse sin vendedores es quedarse sin agente."""
    monkeypatch.setenv("VENDEDORES_SEED_JSON", "{esto no es json valido")
    assert tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "nada.yaml")) == []


def test_json_que_no_es_lista_no_revienta(monkeypatch, tmp_path):
    monkeypatch.setenv("VENDEDORES_SEED_JSON", '{"vendedores": "no es lista"}')
    assert tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "nada.yaml")) == []


def test_acepta_tambien_el_formato_envuelto(monkeypatch, tmp_path):
    """Por comodidad: aceptar tanto [...] como {"vendedores": [...]}, que es
    la forma del YAML — es facil pegar una u otra por error."""
    monkeypatch.setenv("VENDEDORES_SEED_JSON",
                       '{"vendedores":' + JSON_VENDEDORES + '}')
    filas = tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "nada.yaml"))
    assert len(filas) == 2
    assert filas[1]["nombre"] == "Beto Prueba"


def test_la_semilla_del_entorno_queda_normalizada(monkeypatch, tmp_path):
    monkeypatch.setenv("VENDEDORES_SEED_JSON",
                       '[{"nombre":" Con Espacios ","netsuite_id":133}]')
    filas = tools.leer_vendedores_semilla(ruta_yaml=str(tmp_path / "nada.yaml"))
    assert filas[0]["nombre"] == "Con Espacios"
    assert filas[0]["netsuite_id"] == "133"   # numero -> texto
    assert filas[0]["whatsapp"] == ""
