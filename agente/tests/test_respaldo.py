# tests/test_respaldo.py — Tests del respaldo de configuración y datos
# Generado por AgentKit

"""
Tests de scripts/respaldo.py.

POR QUE EXISTE EL RESPALDO
--------------------------
La configuración de negocio de Ambar Cargo vive en UN solo disco y no está
en ningún repositorio: config/prompts.yaml (el system prompt de Claudia,
afinado a lo largo de semanas), business.yaml, clientes_escala.yaml, y las
dos bases — agentkit.db (conversaciones, cotizaciones, vendedores,
usuarios del panel) y netsuite_sync.db (3,156 artículos + 8,772 clientes).

El repo publico NO sirve de respaldo: esos archivos no van ahi a proposito.

LO QUE MAS IMPORTA PROBAR
-------------------------
Que el respaldo contenga de verdad lo que dice contener. Un respaldo que
falla en silencio es peor que no tener respaldo, porque da la falsa
tranquilidad de estar cubierto — justo hasta el dia que lo necesitas.

Correr con:  python -m pytest tests/test_respaldo.py -v
"""

import os
import sys
import zipfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import respaldo


@pytest.fixture
def proyecto(tmp_path):
    """Un proyecto de mentira con la misma forma que el real."""
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "prompts.yaml").write_text("system_prompt: hola\n", encoding="utf-8")
    (tmp_path / "config" / "business.yaml").write_text("negocio: prueba\n", encoding="utf-8")
    (tmp_path / "scripts").mkdir()
    (tmp_path / "scripts" / "config.ini").write_text("[netsuite]\nTOKEN=x\n", encoding="utf-8")
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=sk-ant-prueba\n", encoding="utf-8")
    (tmp_path / "agentkit.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 100)
    (tmp_path / "netsuite_sync.db").write_bytes(b"SQLite format 3\x00" + b"\x00" * 200)
    return tmp_path


# ══════════════════════════════════════════════════════════════════
# 1. El respaldo contiene lo que dice contener
# ══════════════════════════════════════════════════════════════════

def test_crea_el_archivo(proyecto):
    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    assert os.path.isfile(destino)
    assert destino.endswith(".zip")


def test_incluye_la_configuracion_del_negocio(proyecto):
    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    with zipfile.ZipFile(destino) as z:
        dentro = set(z.namelist())
    assert "config/prompts.yaml" in dentro
    assert "config/business.yaml" in dentro


def test_incluye_los_secretos(proyecto):
    """Un respaldo SIN los secretos no sirve para restaurar nada: sin .env
    el agente no arranca. Por eso respaldos/ tiene que estar en .gitignore."""
    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    with zipfile.ZipFile(destino) as z:
        dentro = set(z.namelist())
    assert ".env" in dentro
    assert "scripts/config.ini" in dentro


def test_incluye_las_dos_bases(proyecto):
    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    with zipfile.ZipFile(destino) as z:
        dentro = set(z.namelist())
    assert "agentkit.db" in dentro
    assert "netsuite_sync.db" in dentro


def test_el_contenido_se_conserva_intacto(proyecto):
    """No basta con que el nombre este en el zip: el contenido debe volver
    byte por byte. Se compara contra lo que hay REALMENTE en disco (no
    contra el literal del fixture) porque en Windows write_text traduce
    \\n a \\r\\n al escribir — el respaldo debe copiar lo que existe, no
    lo que creemos que escribimos."""
    esperado_yaml = (proyecto / "config" / "prompts.yaml").read_bytes()
    esperado_db = (proyecto / "netsuite_sync.db").read_bytes()

    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    with zipfile.ZipFile(destino) as z:
        assert z.read("config/prompts.yaml") == esperado_yaml
        assert z.read("netsuite_sync.db") == esperado_db
        # Y el contenido sigue siendo el texto que pusimos
        assert b"system_prompt: hola" in z.read("config/prompts.yaml")


# ══════════════════════════════════════════════════════════════════
# 2. Verificación — un respaldo corrupto debe delatarse
# ══════════════════════════════════════════════════════════════════

def test_el_respaldo_recien_hecho_se_verifica_bien(proyecto):
    destino = respaldo.crear_respaldo(str(proyecto), str(proyecto / "respaldos"))
    ok, problema = respaldo.verificar(destino)
    assert ok is True, problema


def test_un_zip_corrupto_se_detecta(proyecto, tmp_path):
    corrupto = tmp_path / "corrupto.zip"
    corrupto.write_bytes(b"esto no es un zip")
    ok, problema = respaldo.verificar(str(corrupto))
    assert ok is False
    assert problema


def test_un_zip_sin_lo_esencial_se_detecta(tmp_path):
    """Si el .env no entro, el respaldo no sirve — hay que enterarse AHORA."""
    incompleto = tmp_path / "incompleto.zip"
    with zipfile.ZipFile(incompleto, "w") as z:
        z.writestr("config/prompts.yaml", "algo")
    ok, problema = respaldo.verificar(str(incompleto))
    assert ok is False
    assert ".env" in problema


# ══════════════════════════════════════════════════════════════════
# 3. Tolerancia a archivos ausentes
# ══════════════════════════════════════════════════════════════════

def test_un_archivo_que_no_existe_no_tumba_el_respaldo(tmp_path):
    """Una instalacion nueva puede no tener netsuite_sync.db todavia."""
    (tmp_path / "config").mkdir()
    (tmp_path / "config" / "prompts.yaml").write_text("x\n", encoding="utf-8")
    (tmp_path / ".env").write_text("K=v\n", encoding="utf-8")

    destino = respaldo.crear_respaldo(str(tmp_path), str(tmp_path / "respaldos"))
    with zipfile.ZipFile(destino) as z:
        assert "config/prompts.yaml" in z.namelist()
        assert "netsuite_sync.db" not in z.namelist()


# ══════════════════════════════════════════════════════════════════
# 4. Rotación — no llenar el disco de respaldos viejos
# ══════════════════════════════════════════════════════════════════

def test_conserva_solo_los_ultimos_n(tmp_path):
    carpeta = tmp_path / "respaldos"
    carpeta.mkdir()
    for i in range(8):
        (carpeta / f"agentkit-respaldo-2026070{i}-120000.zip").write_bytes(b"x")

    respaldo.rotar(str(carpeta), conservar=5)
    quedan = sorted(p.name for p in carpeta.glob("*.zip"))
    assert len(quedan) == 5
    # Se conservan los MAS NUEVOS (nombre con fecha, orden lexicografico)
    assert quedan[-1] == "agentkit-respaldo-20260707-120000.zip"
    assert "agentkit-respaldo-20260700-120000.zip" not in quedan


def test_rotar_con_menos_archivos_que_el_limite_no_borra_nada(tmp_path):
    carpeta = tmp_path / "respaldos"
    carpeta.mkdir()
    for i in range(3):
        (carpeta / f"agentkit-respaldo-2026070{i}-120000.zip").write_bytes(b"x")

    respaldo.rotar(str(carpeta), conservar=5)
    assert len(list(carpeta.glob("*.zip"))) == 3


def test_rotar_ignora_archivos_ajenos(tmp_path):
    """No borrar cosas que no son respaldos nuestros."""
    carpeta = tmp_path / "respaldos"
    carpeta.mkdir()
    (carpeta / "no-tocar.txt").write_text("importante", encoding="utf-8")
    for i in range(7):
        (carpeta / f"agentkit-respaldo-2026070{i}-120000.zip").write_bytes(b"x")

    respaldo.rotar(str(carpeta), conservar=2)
    assert (carpeta / "no-tocar.txt").exists()
