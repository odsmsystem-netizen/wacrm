# tests/test_borrar_conversacion.py — Borrado de conversaciones
# Generado por AgentKit

"""
Tests de limpiar_historial y del endpoint que lo expone.

POR QUE EXISTE
--------------
Surgio de una necesidad concreta: despues de migrar a Railway quedaron 9
mensajes de PRUEBA en la base de produccion, y no habia forma de sacarlos
sin acceso SSH al contenedor.

Pero la utilidad real es permanente: un cliente que pide que borren su
conversacion, o un chat que se descarrilo y conviene reiniciar para que
Claudia no arrastre contexto malo.

LO QUE MAS IMPORTA PROBAR
-------------------------
Que borre SOLO la conversacion pedida. Un borrado que se lleve de mas es
irreversible y destruye historial de clientes reales.

Correr con:  python -m pytest tests/test_borrar_conversacion.py -v
"""

import os
import sys
import asyncio

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


@pytest.fixture
def memoria_temporal(tmp_path, monkeypatch):
    """Base SQLite nueva y aislada por test — nunca la real del proyecto."""
    monkeypatch.setenv("DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'prueba.db'}")
    for mod in [m for m in list(sys.modules) if m.startswith("agent.memory")]:
        sys.modules.pop(mod, None)
    import importlib
    memoria = importlib.import_module("agent.memory")
    importlib.reload(memoria)
    asyncio.run(memoria.inicializar_db())
    return memoria


def _sembrar(memoria, datos):
    async def _run():
        for tel, textos in datos.items():
            for t in textos:
                await memoria.guardar_mensaje(tel, "user", t)
                await memoria.guardar_mensaje(tel, "assistant", f"respuesta a {t}")
    asyncio.run(_run())


def _historial(memoria, tel):
    return asyncio.run(memoria.obtener_historial(tel))


# ══════════════════════════════════════════════════════════════════
# 1. Borra lo pedido
# ══════════════════════════════════════════════════════════════════

def test_borra_la_conversacion_indicada(memoria_temporal):
    m = memoria_temporal
    _sembrar(m, {"+521111": ["hola", "adios"]})
    assert len(_historial(m, "+521111")) == 4

    asyncio.run(m.limpiar_historial("+521111"))
    assert _historial(m, "+521111") == []


# ══════════════════════════════════════════════════════════════════
# 2. NO borra lo que no se pidio — lo critico
# ══════════════════════════════════════════════════════════════════

def test_no_toca_las_otras_conversaciones(memoria_temporal):
    """
    Lo mas importante del archivo. Un borrado que se lleve de mas es
    irreversible y destruye historial de clientes reales.
    """
    m = memoria_temporal
    _sembrar(m, {
        "+521111": ["prueba uno"],
        "+522222": ["cliente real que NO se debe borrar"],
        "+523333": ["otro cliente real"],
    })

    asyncio.run(m.limpiar_historial("+521111"))

    assert _historial(m, "+521111") == []
    assert len(_historial(m, "+522222")) == 2
    assert len(_historial(m, "+523333")) == 2


def test_un_telefono_inexistente_no_borra_nada(memoria_temporal):
    m = memoria_temporal
    _sembrar(m, {"+521111": ["hola"]})
    asyncio.run(m.limpiar_historial("+529999999"))
    assert len(_historial(m, "+521111")) == 2


def test_telefono_vacio_no_borra_todo(memoria_temporal):
    """Un parametro vacio por error NO debe vaciar la base entera."""
    m = memoria_temporal
    _sembrar(m, {"+521111": ["hola"], "+522222": ["mundo"]})
    asyncio.run(m.limpiar_historial(""))
    assert len(_historial(m, "+521111")) == 2
    assert len(_historial(m, "+522222")) == 2


def test_no_confunde_telefonos_con_prefijo_comun(memoria_temporal):
    """+52111 no debe arrastrar a +5211122."""
    m = memoria_temporal
    _sembrar(m, {"+52111": ["corto"], "+5211122": ["largo"]})
    asyncio.run(m.limpiar_historial("+52111"))
    assert _historial(m, "+52111") == []
    assert len(_historial(m, "+5211122")) == 2


# ══════════════════════════════════════════════════════════════════
# 3. Idempotencia y bordes
# ══════════════════════════════════════════════════════════════════

def test_borrar_dos_veces_no_revienta(memoria_temporal):
    m = memoria_temporal
    _sembrar(m, {"+521111": ["hola"]})
    asyncio.run(m.limpiar_historial("+521111"))
    asyncio.run(m.limpiar_historial("+521111"))
    assert _historial(m, "+521111") == []


def test_devuelve_cuantos_borro(memoria_temporal):
    """El panel necesita confirmar al usuario cuantos mensajes se fueron."""
    m = memoria_temporal
    _sembrar(m, {"+521111": ["a", "b", "c"]})
    borrados = asyncio.run(m.limpiar_historial("+521111"))
    assert borrados == 6   # 3 del cliente + 3 respuestas


def test_borrar_una_conversacion_vacia_devuelve_cero(memoria_temporal):
    m = memoria_temporal
    assert asyncio.run(m.limpiar_historial("+529999")) == 0
