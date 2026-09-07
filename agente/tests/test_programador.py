# tests/test_programador.py — Programador del sync diario
# Generado por AgentKit

"""
Tests de agent/programador.py.

POR QUE UN PROGRAMADOR DENTRO DE LA APP
---------------------------------------
En Windows el sync corre por Task Scheduler. En Railway eso no existe, y
el CLI no expone el cron — habria que configurarlo a mano en el dashboard
y levantar un SEGUNDO servicio (con su propio montaje del volumen), lo que
duplica el costo mensual. Para el volumen de operacion de Ambar Cargo no
se justifica: se corre como tarea de fondo del mismo proceso, igual que el
vigilante del tunel.

LO QUE DE VERDAD IMPORTA PROBAR
-------------------------------
Que NO sincronice de mas. Cada corrida son ~12,000 filas traidas de
NetSuite; un bug que dispare el sync en cada vuelta del bucle machacaria
la API de NetSuite cada pocos minutos. La decision de "¿toca correr?" es
pura y esta toda aqui.

Correr con:  python -m pytest tests/test_programador.py -v
"""

import os
import sys
from datetime import datetime, timezone

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent import programador as pr


HOY_TEMPRANO = datetime(2026, 7, 31, 5, 0)    # antes de la hora objetivo
HOY_A_LA_HORA = datetime(2026, 7, 31, 7, 0)   # justo a las 7:00
HOY_TARDE = datetime(2026, 7, 31, 23, 30)     # mucho despues
HORA_OBJETIVO = 7


# ══════════════════════════════════════════════════════════════════
# 1. No correr antes de la hora
# ══════════════════════════════════════════════════════════════════

def test_no_corre_antes_de_la_hora_objetivo():
    assert pr.debe_correr(ultima=None, ahora=HOY_TEMPRANO, hora_objetivo=HORA_OBJETIVO) is False


def test_corre_justo_a_la_hora():
    assert pr.debe_correr(ultima=None, ahora=HOY_A_LA_HORA, hora_objetivo=HORA_OBJETIVO) is True


def test_corre_si_arranca_tarde_y_hoy_no_se_ha_sincronizado():
    """Si el contenedor se reinicio a media tarde y hoy nadie sincronizo,
    hay que ponerse al corriente — no esperar a manana."""
    assert pr.debe_correr(ultima=None, ahora=HOY_TARDE, hora_objetivo=HORA_OBJETIVO) is True


# ══════════════════════════════════════════════════════════════════
# 2. Una vez al dia y nada mas — lo critico
# ══════════════════════════════════════════════════════════════════

def test_no_repite_si_ya_sincronizo_hoy():
    """
    El test mas importante del archivo. El bucle despierta cada pocos
    minutos; sin este guardo traeria 12,000 filas de NetSuite cada vez.
    """
    ya_corrio = datetime(2026, 7, 31, 7, 0, 30)
    assert pr.debe_correr(ultima=ya_corrio, ahora=HOY_TARDE, hora_objetivo=HORA_OBJETIVO) is False


def test_no_repite_ni_un_minuto_despues():
    ya_corrio = datetime(2026, 7, 31, 7, 0, 30)
    justo_despues = datetime(2026, 7, 31, 7, 1, 0)
    assert pr.debe_correr(ultima=ya_corrio, ahora=justo_despues, hora_objetivo=HORA_OBJETIVO) is False


def test_vuelve_a_correr_al_dia_siguiente():
    ayer = datetime(2026, 7, 30, 7, 0)
    manana_a_la_hora = datetime(2026, 7, 31, 7, 0)
    assert pr.debe_correr(ultima=ayer, ahora=manana_a_la_hora, hora_objetivo=HORA_OBJETIVO) is True


def test_al_dia_siguiente_pero_antes_de_la_hora_no_corre():
    ayer = datetime(2026, 7, 30, 7, 0)
    hoy_temprano = datetime(2026, 7, 31, 3, 0)
    assert pr.debe_correr(ultima=ayer, ahora=hoy_temprano, hora_objetivo=HORA_OBJETIVO) is False


def test_una_sincronizacion_de_hace_semanas_dispara_hoy():
    vieja = datetime(2026, 7, 1, 7, 0)
    assert pr.debe_correr(ultima=vieja, ahora=HOY_A_LA_HORA, hora_objetivo=HORA_OBJETIVO) is True


# ══════════════════════════════════════════════════════════════════
# 3. Lectura de la ultima sincronizacion
# ══════════════════════════════════════════════════════════════════

def test_interpreta_la_marca_iso_de_la_base():
    """ns_db guarda 'articulos_actualizado' en ISO con zona horaria."""
    d = pr.interpretar_marca("2026-07-31T21:35:17+00:00")
    assert d is not None
    assert d.year == 2026 and d.month == 7 and d.day == 31


def test_la_marca_utc_se_convierte_a_hora_local_no_se_trunca():
    """La marca se guarda en UTC, pero debe_correr la compara contra
    datetime.now(), que es hora LOCAL. Si solo se le quita la zona horaria
    sin convertir, las dos fechas viven en husos distintos.

    Mientras el contenedor corrio en UTC esto no se notaba (ambos relojes
    coincidian). Con TZ=America/Mexico_City si: un sync de las 19:00 de
    Mexico se guarda como 01:00 UTC del dia SIGUIENTE, y al truncarlo el
    programador cree que ya sincronizo manana — y se salta el sync del dia
    siguiente.
    """
    # 2026-08-02 01:00 UTC == 2026-08-01 19:00 en Mexico (UTC-6)
    d = pr.interpretar_marca("2026-08-02T01:00:00+00:00")
    esperado = datetime(2026, 8, 2, 1, 0, tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
    assert d == esperado, "la marca UTC debe convertirse a la hora local del proceso"


def test_marca_ausente_devuelve_none():
    assert pr.interpretar_marca(None) is None
    assert pr.interpretar_marca("") is None


def test_marca_corrupta_devuelve_none_sin_reventar():
    """Una marca ilegible debe tratarse como 'nunca sincronizado', no
    tumbar el programador."""
    assert pr.interpretar_marca("no es una fecha") is None


# ══════════════════════════════════════════════════════════════════
# 4. Interruptor de apagado
# ══════════════════════════════════════════════════════════════════

def test_se_puede_apagar(monkeypatch):
    monkeypatch.setenv("SYNC_PROGRAMADO_ENABLED", "false")
    assert pr.programador_activo() is False


def test_activo_por_defecto(monkeypatch):
    monkeypatch.delenv("SYNC_PROGRAMADO_ENABLED", raising=False)
    assert pr.programador_activo() is True


def test_la_hora_es_configurable(monkeypatch):
    monkeypatch.setenv("SYNC_PROGRAMADO_HORA", "3")
    assert pr.hora_objetivo() == 3


def test_hora_invalida_cae_al_valor_por_defecto(monkeypatch):
    """Un valor mal escrito no debe impedir que el sync corra nunca."""
    monkeypatch.setenv("SYNC_PROGRAMADO_HORA", "no-es-numero")
    assert pr.hora_objetivo() == pr.HORA_POR_DEFECTO


def test_hora_fuera_de_rango_cae_al_valor_por_defecto(monkeypatch):
    monkeypatch.setenv("SYNC_PROGRAMADO_HORA", "99")
    assert pr.hora_objetivo() == pr.HORA_POR_DEFECTO
