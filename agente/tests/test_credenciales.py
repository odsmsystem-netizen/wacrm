# tests/test_credenciales.py — Credenciales de NetSuite: archivo o entorno
# Generado por AgentKit

"""
Tests de scripts/credenciales.py.

POR QUE EXISTE ESTE MODULO
--------------------------
El proyecto tenia DOS mecanismos distintos para las mismas credenciales:

    agent/netsuite_client.py   -> variables de entorno
    scripts/sync_netsuite_*.py -> scripts/config.ini

En local daba igual, los dos funcionaban. En Railway no: config.ini esta
en .gitignore (tiene los tokens en claro) y `railway up` respeta
.gitignore, asi que el archivo nunca llega al contenedor. Resultado: el
agente podia hablar con NetSuite pero el sync no, y el catalogo se quedaba
vacio — 0 articulos, 0 clientes, con Claudia incapaz de cotizar nada.

Ahora hay un solo cargador: usa el archivo si existe (comodo en local) y
cae a las variables de entorno si no (que es como viajan los secretos a
produccion, igual que el token de Twilio o la llave de Anthropic).

Correr con:  python -m pytest tests/test_credenciales.py -v
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import credenciales


CLAVES = ("ACCOUNT_ID", "CONSUMER_KEY", "CONSUMER_SECRET", "TOKEN_ID", "TOKEN_SECRET")


@pytest.fixture(autouse=True)
def entorno_limpio(monkeypatch):
    """Ningun test debe ver las credenciales reales del .env de la maquina."""
    for c in CLAVES + ("SUBSIDIARY_ID",):
        monkeypatch.delenv(f"NETSUITE_{c}", raising=False)


def _escribir_ini(tmp_path, **valores):
    ruta = tmp_path / "config.ini"
    lineas = ["[netsuite]"] + [f"{k} = {v}" for k, v in valores.items()]
    ruta.write_text("\n".join(lineas) + "\n", encoding="utf-8")
    return str(ruta)


# ══════════════════════════════════════════════════════════════════
# 1. El archivo manda cuando existe (comodidad en local)
# ══════════════════════════════════════════════════════════════════

def test_lee_del_archivo_si_existe(tmp_path):
    ruta = _escribir_ini(tmp_path, ACCOUNT_ID="111", CONSUMER_KEY="ck",
                         CONSUMER_SECRET="cs", TOKEN_ID="ti", TOKEN_SECRET="ts")
    cfg = credenciales.cargar_netsuite(ruta_ini=ruta)
    assert cfg["ACCOUNT_ID"] == "111"
    assert cfg["CONSUMER_KEY"] == "ck"


def test_el_archivo_gana_sobre_el_entorno(tmp_path, monkeypatch):
    """En local, con .env Y config.ini presentes, se respeta el archivo:
    es el que el usuario edita a mano y espera que mande."""
    monkeypatch.setenv("NETSUITE_ACCOUNT_ID", "del-entorno")
    ruta = _escribir_ini(tmp_path, ACCOUNT_ID="del-archivo", CONSUMER_KEY="ck",
                         CONSUMER_SECRET="cs", TOKEN_ID="ti", TOKEN_SECRET="ts")
    cfg = credenciales.cargar_netsuite(ruta_ini=ruta)
    assert cfg["ACCOUNT_ID"] == "del-archivo"


# ══════════════════════════════════════════════════════════════════
# 2. Sin archivo, entorno — el caso de Railway
# ══════════════════════════════════════════════════════════════════

def test_cae_al_entorno_si_no_hay_archivo(tmp_path, monkeypatch):
    for c in CLAVES:
        monkeypatch.setenv(f"NETSUITE_{c}", f"env-{c.lower()}")

    cfg = credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "no-existe.ini"))
    assert cfg["ACCOUNT_ID"] == "env-account_id"
    assert cfg["TOKEN_SECRET"] == "env-token_secret"


def test_los_nombres_de_variable_son_los_que_ya_estan_en_railway(tmp_path, monkeypatch):
    """
    Guardia contra renombrar: estas 5 variables YA estan configuradas en
    Railway. Si el codigo empezara a buscar otros nombres, el sync fallaria
    en produccion sin ningun cambio visible en local.
    """
    esperadas = ["NETSUITE_ACCOUNT_ID", "NETSUITE_CONSUMER_KEY",
                 "NETSUITE_CONSUMER_SECRET", "NETSUITE_TOKEN_ID",
                 "NETSUITE_TOKEN_SECRET"]
    for nombre in esperadas:
        monkeypatch.setenv(nombre, "x")

    cfg = credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "nada.ini"))
    assert all(cfg[c] == "x" for c in CLAVES)


def test_subsidiary_tiene_valor_por_defecto(tmp_path, monkeypatch):
    for c in CLAVES:
        monkeypatch.setenv(f"NETSUITE_{c}", "x")
    cfg = credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "nada.ini"))
    assert cfg["SUBSIDIARY_ID"] == "2"   # Ambar Cargo


# ══════════════════════════════════════════════════════════════════
# 3. Sin ninguna de las dos: error CLARO, no un 401 misterioso
# ══════════════════════════════════════════════════════════════════

def test_sin_archivo_ni_entorno_lanza_error_explicito(tmp_path):
    with pytest.raises(credenciales.CredencialesFaltantes) as exc:
        credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "nada.ini"))
    mensaje = str(exc.value)
    assert "NETSUITE_" in mensaje
    assert "config.ini" in mensaje


def test_credenciales_incompletas_dicen_cuales_faltan(tmp_path, monkeypatch):
    """Un 401 de NetSuite no dice que falto. El error debe decirlo."""
    monkeypatch.setenv("NETSUITE_ACCOUNT_ID", "x")
    monkeypatch.setenv("NETSUITE_CONSUMER_KEY", "x")
    with pytest.raises(credenciales.CredencialesFaltantes) as exc:
        credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "nada.ini"))

    # Solo la PRIMERA linea lleva la lista de faltantes; las siguientes son
    # la ayuda, que nombra todas las variables a proposito.
    lista = str(exc.value).splitlines()[0]
    assert "TOKEN_ID" in lista
    assert "TOKEN_SECRET" in lista
    assert "CONSUMER_SECRET" in lista
    # Las que SI estan configuradas no deben aparecer como faltantes
    assert "ACCOUNT_ID" not in lista
    assert "CONSUMER_KEY," not in lista


def test_el_error_no_filtra_valores(tmp_path, monkeypatch):
    """El mensaje nombra las claves que faltan, nunca los valores que si hay."""
    monkeypatch.setenv("NETSUITE_ACCOUNT_ID", "secreto-no-mostrar")
    with pytest.raises(credenciales.CredencialesFaltantes) as exc:
        credenciales.cargar_netsuite(ruta_ini=str(tmp_path / "nada.ini"))
    assert "secreto-no-mostrar" not in str(exc.value)


def test_un_ini_sin_la_seccion_netsuite_cae_al_entorno(tmp_path, monkeypatch):
    """Un config.ini malformado no debe dejar el sync sin credenciales si el
    entorno si las tiene."""
    ruta = tmp_path / "config.ini"
    ruta.write_text("[otra_cosa]\nX = 1\n", encoding="utf-8")
    for c in CLAVES:
        monkeypatch.setenv(f"NETSUITE_{c}", "del-entorno")

    cfg = credenciales.cargar_netsuite(ruta_ini=str(ruta))
    assert cfg["ACCOUNT_ID"] == "del-entorno"
